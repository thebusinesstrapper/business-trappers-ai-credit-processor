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
 * Read every client_state row, newest first, paging past the 1000-row cap.
 *
 * @returns {Promise<{ok: boolean, recordCount: number, generatedAt: string, records: object[]}>}
 */
export async function getDashboardData() {
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
            throw new Error(`Failed to read ${CLIENT_STATE_TABLE}: ${error.message}`);
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
