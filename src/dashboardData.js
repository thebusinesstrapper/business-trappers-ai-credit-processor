/**
 * dashboardData.js — READ-ONLY export of client_state for the Google Sheets
 * Executive Operations Dashboard.
 *
 * WHAT THIS MODULE CANNOT DO, BY CONSTRUCTION.
 *
 * It imports exactly one thing: getSupabase. It does not import any milestone,
 * any CRC module, any CreditHeroScore module, crcSecureMessage, crcClientNotice,
 * crcClientStatus, clientMemory, or the queue. So it cannot run M7 or M8, cannot
 * open a browser, cannot send a message, cannot change a CRC status, cannot
 * acquire a delivery lock, and cannot touch current_round — none of that code is
 * reachable from here.
 *
 * The only Supabase verb used is .select(). There is no insert, update, upsert,
 * or delete anywhere in this file, which is verifiable by grep rather than by
 * reading intent.
 *
 * FIELD WHITELIST. Columns are named explicitly in the select. Adding a
 * sensitive column to client_state later cannot leak it through this endpoint,
 * because the endpoint asks for named columns rather than "*". No report
 * contents, dispute letters, PDFs, SSNs, dates of birth, addresses, emails, or
 * phone numbers are requested or returned.
 */

import { getSupabase } from "./supabase.js";

export const DASHBOARD_DATA_VERSION = "BT-DASHBOARD-1.0";

const CLIENT_STATE_TABLE = "client_state";

/** Supabase caps a single range at 1000 rows; page through in blocks. */
const PAGE_SIZE = 1000;

/** Hard ceiling so a runaway table can never spin this endpoint forever. */
const MAX_PAGES = 50;

/**
 * The ONLY columns this endpoint may return. Operational state only.
 */
const DASHBOARD_FIELDS = [
    "crc_client_id",
    "client_display_name",
    "ai_initialized",
    "current_round",
    "processing_state",
    "last_dispute_date",
    "next_eligible_date",
    "last_report_date_used",
    "negative_items_remaining",
    "process_complete",
    "credit_hero_access_state",
    "block_reason",
    "last_successful_processing_at",
    "updated_at",
    "inactive_notice_sent_at",
    "inactive_reminder_sent_at",
    "last_credit_hero_check_at",
    "inactive_notice_last_error",
    // Observation-only: the CRC status text last positively observed on the
    // live DataGrid, or the exact status a routing/M8 path confirmed it wrote.
    // Written only via clientMemory.recordCreditHeroState()'s guarded
    // crc_client_status field — this endpoint remains select-only.
    "crc_client_status",
    // Manual review. Written only by clientMemory.recordManualReview() /
    // clearManualReview(), and only on an approved, non-diagnostic run.
    // manual_review_reason is sanitized at the call site before it is stored,
    // so no report contents or account numbers pass through here.
    "manual_review_active",
    "manual_review_stage",
    "manual_review_reason",
    "manual_review_flagged_at",
    // When monitoring was confirmed active again after being inactive. Written
    // once by clientMemory.recordMonitoringReactivated() on the inactive->active
    // transition. Operational state only; this endpoint remains select-only.
    "monitoring_reactivated_date",
];

const SELECT_COLUMNS = DASHBOARD_FIELDS.join(", ");

/**
 * Constant-time-ish comparison so the secret cannot be discovered by timing the
 * response. Length is compared first, then every byte is examined regardless of
 * where the first mismatch occurs.
 */
function secretsMatch(provided, expected) {
    if (typeof provided !== "string" || typeof expected !== "string") return false;
    if (provided.length !== expected.length) return false;

    let diff = 0;

    for (let i = 0; i < provided.length; i += 1) {
        diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
    }

    return diff === 0;
}

/**
 * Authorize a dashboard request.
 *
 * @param {string|undefined} providedSecret  value of the x-dashboard-secret header
 * @returns {{ok: boolean, status: number, error_code?: string, error?: string}}
 */
export function authorizeDashboardRequest(providedSecret) {
    const expected = process.env.DASHBOARD_SYNC_SECRET;

    // A missing server-side secret must NOT mean "allow everyone". Fail closed.
    if (!expected) {
        return {
            ok: false,
            status: 401,
            error_code: "DASHBOARD_SECRET_NOT_CONFIGURED",
            error: "Dashboard sync is not configured on this server.",
        };
    }

    if (!providedSecret || !secretsMatch(providedSecret, expected)) {
        return {
            ok: false,
            status: 401,
            error_code: "DASHBOARD_UNAUTHORIZED",
            error: "Missing or invalid x-dashboard-secret header.",
        };
    }

    return { ok: true, status: 200 };
}

/**
 * Maximum read attempts for a transient Supabase/PostgREST failure. The dashboard
 * read is idempotent and read-only, so a bounded retry is safe.
 */
const MAX_READ_ATTEMPTS = 3;

/** Modest fixed-plus-linear backoff between attempts (ms). Attempt 1 -> 150ms, 2 -> 300ms. */
function backoffMs(attempt) {
    return 150 * attempt;
}

/**
 * Is this error worth retrying? Transient transport/timeout/availability errors
 * are; a permanent schema or permission error is NOT (retrying it just delays the
 * same 500). Classification is best-effort and defaults to "transient" only for
 * recognized transient signals — an unknown error is treated as permanent so we
 * fail fast rather than hammer a broken dependency.
 */
function isRetryableReadError(error) {
    const code = String(error?.code ?? "").toUpperCase();
    const msg = String(error?.message ?? "").toLowerCase();

    // Permanent PostgREST/Postgres errors: undefined table (42P01), undefined
    // column (42703), permission denied (42501), and PostgREST schema errors
    // (PGRST...). Never retried.
    if (/^(42P01|42703|42501)$/.test(code) || code.startsWith("PGRST")) return false;

    // Recognized transient signals.
    const transient =
        /(timeout|timed out|econn|etimedout|socket hang up|network|fetch failed|503|502|504|too many connections|temporarily unavailable)/.test(
            msg
        );
    return transient;
}

/**
 * Sanitized server-side log line for a dashboard read attempt. Emits ONLY the
 * endpoint, attempt number, and a safe error code/short message. Never logs the
 * Supabase key, connection string, request secret, consumer data, or query
 * results. The message is truncated and stripped of anything that could carry a
 * value, and long digit runs are redacted defensively.
 */
function logDashboardReadFailure(attempt, error) {
    const code = String(error?.code ?? "UNKNOWN").slice(0, 40);
    const safeMessage = String(error?.message ?? "read failed")
        .replace(/\d{4,}/g, "#") // redact any long digit run (ids, numbers)
        .slice(0, 160);
    console.error(
        `[dashboard-data] read attempt ${attempt}/${MAX_READ_ATTEMPTS} failed: ` +
            `code=${code} message="${safeMessage}"`
    );
}

/**
 * Read every client_state row, newest first, paging past the 1000-row cap.
 *
 * Hardened with a bounded retry (max ${MAX_READ_ATTEMPTS}) for TRANSIENT read
 * failures. Permanent schema/permission errors are not retried. After the final
 * failure it still throws, so the endpoint fails closed with HTTP 500 exactly as
 * before. Strictly read-only: the only Supabase verb here remains .select().
 *
 * @returns {Promise<{ok: boolean, recordCount: number, generatedAt: string, records: object[]}>}
 */
export async function getDashboardData() {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
        try {
            return await readAllClientStateRows();
        } catch (error) {
            lastError = error;
            logDashboardReadFailure(attempt, error);

            // Do not retry a permanent error, and do not delay after the last try.
            if (!isRetryableReadError(error) || attempt === MAX_READ_ATTEMPTS) break;

            await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
        }
    }

    // Fail closed: the route handler maps a throw to the existing generic 500.
    throw new Error(`Failed to read ${CLIENT_STATE_TABLE}: ${lastError?.message ?? "unknown error"}`);
}

/**
 * The actual paged read. Kept separate so getDashboardData() can wrap it in the
 * retry loop without duplicating the paging logic. Read-only (.select only).
 */
async function readAllClientStateRows() {
    const supabase = getSupabase();
    const records = [];

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
        const from = pageIndex * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;

        const { data, error } = await supabase
            .from(CLIENT_STATE_TABLE)
            .select(SELECT_COLUMNS)
            // Newest first. nullsFirst:false keeps rows that have never been
            // updated at the end rather than dominating the top of the sheet.
            .order("updated_at", { ascending: false, nullsFirst: false })
            .range(from, to);

        if (error) {
            // Throw the raw Supabase error so getDashboardData() can classify it
            // (retryable vs permanent) and log it sanitized.
            const e = new Error(error.message);
            e.code = error.code;
            throw e;
        }

        const batch = Array.isArray(data) ? data : [];
        records.push(...batch);

        // A short page means we have reached the end.
        if (batch.length < PAGE_SIZE) break;
    }

    return {
        ok: true,
        recordCount: records.length,
        generatedAt: new Date().toISOString(),
        records,
    };
}

export { DASHBOARD_FIELDS };
