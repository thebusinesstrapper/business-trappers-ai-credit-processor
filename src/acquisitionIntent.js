/**
 * acquisitionIntent.js
 *
 * The application-side connection to `report_acquisition_intents` — the table
 * created by migration 002 and, until this module, never referenced by any code.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS FOR
 *
 * Report acquisition is the FIRST IRREVERSIBLE ACTION this system performs.
 * Every other guardrail in the codebase was written on the assumption that a
 * re-run is free. Ordering a report is not free: it spends an entitlement that
 * cannot be returned.
 *
 * The table makes a duplicate order impossible. This module is the only way the
 * application touches it.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD IS THE DATABASE, NOT THIS FILE.
 *
 * 002 defines a PARTIAL UNIQUE INDEX:
 *
 *   create unique index one_unresolved_intent_per_client
 *       on report_acquisition_intents (crc_client_id)
 *       where status in ('intent_created','submission_started','submitted');
 *
 * createIntent() therefore attempts an INSERT and treats PostgreSQL error 23505
 * (unique violation) as the SAFETY OUTCOME: an unresolved intent already exists,
 * so we stop.
 *
 * IT DOES NOT read-then-insert. That pattern has a time-of-check/time-of-use
 * race — two runs both read "no open intent", both insert, both order — and the
 * partial index exists precisely to close it. A read cannot close it; only the
 * insert is atomic.
 *
 * readOpenIntent() exists for RECOVERY and DIAGNOSTICS only. It must never be
 * used as the pre-insert gate.
 * ---------------------------------------------------------------------------
 *
 * WHAT THIS MODULE CANNOT DO, BY CONSTRUCTION. It imports getSupabase and
 * nothing else. No Playwright, no milestone, no CRC module, no clientMemory. It
 * cannot open a browser, click anything, order anything, change a CRC status,
 * touch client_state, advance current_round, or take a delivery lock.
 */

import { getSupabase } from "./supabase.js";

const INTENTS_TABLE = "report_acquisition_intents";

/** PostgreSQL unique_violation. The idempotency guard firing is THIS code. */
const UNIQUE_VIOLATION = "23505";

/** The approved permanent vocabulary for requested_report_type. */
export const REQUESTED_REPORT_TYPE = "3_bureau_free";

/**
 * The seven statuses permitted by 002's CHECK constraint.
 *
 * The first three are UNRESOLVED and are exactly the set the partial unique
 * index filters on. `submitted` being unresolved is deliberate: a click having
 * landed is not proof that a report was obtained.
 */
export const INTENT_STATUS = Object.freeze({
    INTENT_CREATED: "intent_created",
    SUBMISSION_STARTED: "submission_started",
    SUBMITTED: "submitted",
    REPORT_AVAILABLE: "report_available",
    FAILED: "failed",
    MANUAL_REVIEW: "manual_review",
    CANCELLED: "cancelled",
});

export const UNRESOLVED_STATUSES = Object.freeze([
    INTENT_STATUS.INTENT_CREATED,
    INTENT_STATUS.SUBMISSION_STARTED,
    INTENT_STATUS.SUBMITTED,
]);

/**
 * How long an unresolved intent may sit before it stops being "the report is
 * still generating" and becomes "a human needs to look at this".
 *
 * Credit Hero delivers a newly ordered report within minutes (Report Selector
 * Authority §1.2), so 48h is generous by two orders of magnitude. It is sized
 * to absorb an overnight outage, not to wait out a genuine failure.
 */
export const INTENT_GRACE_HOURS = 48;

/** The columns this module ever reads back. Never `metadata` free-text by default. */
const RETURN_COLUMNS =
    "id, crc_client_id, processing_run_id, requested_report_type, " +
    "credit_hero_option_id, observed_cost, decision, status, created_at, " +
    "submitted_at, resolved_at, report_date_before, report_date_after, " +
    "failure_reason, browserbase_session_id";

/**
 * Read this client's UNRESOLVED intent, if any.
 *
 * FOR RECOVERY AND DIAGNOSTICS ONLY — never as the duplicate-prevention gate.
 * See the module header.
 *
 * @returns {Promise<object|null>}
 */
export async function readOpenIntent(crcClientId) {
    const id = String(crcClientId);
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(INTENTS_TABLE)
        .select(RETURN_COLUMNS)
        .eq("crc_client_id", id)
        .in("status", UNRESOLVED_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1);

    if (error) {
        throw new Error(`Failed to read acquisition intent: ${error.message}`);
    }

    return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * Create an acquisition intent BEFORE any submission is attempted.
 *
 * THE INSERT IS THE GUARD. A 23505 unique violation means another unresolved
 * intent already exists for this client — which is the answer, not an error.
 * We return it as a clean refusal so the caller stops rather than orders.
 *
 * @param {object} opts
 * @param {string|number} opts.crcClientId
 * @param {string} opts.processingRunId       one uuid per runMilestone6() call
 * @param {string} opts.decision              a DECISIONS value, recorded verbatim
 * @param {string|null} opts.creditHeroOptionId
 * @param {number|null} opts.observedCost     AFFIRMATIVELY read. null = unknown.
 * @param {string|null} opts.reportDateBefore ISO date; the hasNewerReport baseline
 * @param {string|null} opts.browserbaseSessionId
 * @param {object|null} opts.metadata
 * @returns {Promise<{ok: boolean, intent?: object, reason?: string}>}
 */
export async function createIntent(opts = {}) {
    const {
        crcClientId,
        processingRunId,
        decision,
        creditHeroOptionId = null,
        observedCost = null,
        reportDateBefore = null,
        browserbaseSessionId = null,
        metadata = null,
    } = opts;

    const id = String(crcClientId);

    if (!/^\d+$/.test(id)) {
        throw new Error(`createIntent: invalid crcClientId "${crcClientId}".`);
    }

    if (!processingRunId) {
        throw new Error("createIntent: processingRunId is required.");
    }

    if (!decision) {
        throw new Error("createIntent: decision is required.");
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(INTENTS_TABLE)
        .insert({
            crc_client_id: id,
            processing_run_id: String(processingRunId),
            requested_report_type: REQUESTED_REPORT_TYPE,
            credit_hero_option_id: creditHeroOptionId,
            observed_cost: observedCost,
            decision,
            status: INTENT_STATUS.INTENT_CREATED,
            report_date_before: reportDateBefore,
            browserbase_session_id: browserbaseSessionId,
            metadata,
        })
        .select(RETURN_COLUMNS)
        .maybeSingle();

    if (error) {
        // THE GUARD FIRING. Not a fault — the intended outcome.
        if (error.code === UNIQUE_VIOLATION) {
            return {
                ok: false,
                reason: "unresolved_intent_exists",
                detail:
                    "An unresolved acquisition intent already exists for this client. " +
                    "A previous run may or may not have ordered. Not submitting.",
            };
        }

        // 003's CHECK: a submit intent must carry an affirmatively read cost of 0.
        return {
            ok: false,
            reason: "intent_insert_failed",
            detail: error.message,
        };
    }

    if (!data) {
        return { ok: false, reason: "intent_insert_returned_no_row" };
    }

    return { ok: true, intent: data };
}

/** Compare-and-swap one intent from an expected status to a new one. */
async function transition(intentId, fromStatus, toStatus, fields = {}) {
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(INTENTS_TABLE)
        .update({ status: toStatus, ...fields })
        .eq("id", intentId)
        .eq("status", fromStatus)
        .select(RETURN_COLUMNS)
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to transition acquisition intent: ${error.message}`);
    }

    if (!data) {
        return { ok: false, reason: "intent_transition_conflict", fromStatus, toStatus };
    }

    return { ok: true, intent: data };
}

/** intent_created -> submission_started. Called immediately before interacting. */
export async function markSubmissionStarted(intentId) {
    return transition(
        intentId,
        INTENT_STATUS.INTENT_CREATED,
        INTENT_STATUS.SUBMISSION_STARTED
    );
}

/**
 * submission_started -> submitted.
 *
 * STILL UNRESOLVED. Per 002: "Do not mark the intent resolved merely because a
 * click occurred. Resolution requires positive confirmation that the new report
 * became available."
 */
export async function markSubmitted(intentId) {
    return transition(
        intentId,
        INTENT_STATUS.SUBMISSION_STARTED,
        INTENT_STATUS.SUBMITTED,
        { submitted_at: new Date().toISOString() }
    );
}

/**
 * Move an intent to a RESOLVED status.
 *
 * `report_available` is only ever passed by the recovery path, and only on
 * positive confirmation that a strictly newer report exists.
 */
export async function resolveIntent(intentId, status, fields = {}) {
    const resolved = [
        INTENT_STATUS.REPORT_AVAILABLE,
        INTENT_STATUS.FAILED,
        INTENT_STATUS.MANUAL_REVIEW,
        INTENT_STATUS.CANCELLED,
    ];

    if (!resolved.includes(status)) {
        throw new Error(`resolveIntent: "${status}" is not a resolved status.`);
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(INTENTS_TABLE)
        .update({
            status,
            resolved_at: new Date().toISOString(),
            report_date_after: fields.reportDateAfter ?? null,
            failure_reason: fields.failureReason ?? null,
        })
        .eq("id", intentId)
        .in("status", UNRESOLVED_STATUSES)
        .select(RETURN_COLUMNS)
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to resolve acquisition intent: ${error.message}`);
    }

    if (!data) {
        return { ok: false, reason: "intent_already_resolved_or_missing" };
    }

    return { ok: true, intent: data };
}

/**
 * ---------------------------------------------------------------------------
 * RECOVERY DECISION — PURE. No browser, no database, no clock dependency
 * beyond the `now` you hand it. Fully unit-testable, which is the point: this
 * is the function that decides whether a possibly-orphaned order is finished.
 *
 * THE ONE THING IT NEVER RETURNS IS "SUBMIT AGAIN."
 *
 * Recovery here is confirmation of EFFECT, never a retry of the ACTION. The
 * only way an intent auto-resolves is a report strictly newer than the baseline
 * recorded before the order — which is positive proof the order landed. If that
 * proof is absent we wait, and if we have waited too long a human looks. At no
 * point does any branch below lead back to a submission.
 * ---------------------------------------------------------------------------
 *
 * @param {object|null} intent            an unresolved intent row, or null
 * @param {string|null} newestReportDate  ISO date currently on the selector
 * @param {Date} now
 * @returns {{action: string, reason: string, ...}}
 */
export const RECOVERY = Object.freeze({
    NO_OPEN_INTENT: "no_open_intent",
    RESOLVE_REPORT_AVAILABLE: "resolve_report_available",
    WAIT_WITHIN_GRACE: "wait_within_grace",
    MANUAL_REVIEW: "manual_review",
});

export function decideIntentRecovery(intent, newestReportDate, now = new Date()) {
    if (!intent) {
        return { action: RECOVERY.NO_OPEN_INTENT, reason: "No unresolved intent for this client." };
    }

    const baseline = intent.report_date_before ?? null;

    // ---- POSITIVE CONFIRMATION OF EFFECT ---------------------------------
    //
    // STRICTLY newer, exactly as reportFreshness.hasNewerReport() requires. Not
    // "different", not "the count changed" — a report that is merely different
    // could be an older one the page re-sorted.
    if (baseline && newestReportDate && newestReportDate > baseline) {
        return {
            action: RECOVERY.RESOLVE_REPORT_AVAILABLE,
            reason:
                `A report dated ${newestReportDate} is strictly newer than the ${baseline} ` +
                `baseline recorded before the order. The order landed.`,
            reportDateAfter: newestReportDate,
            baseline,
        };
    }

    // ---- NO CONFIRMATION. How long have we been waiting? -----------------
    //
    // Measured from submitted_at when we know a click landed, otherwise from
    // created_at. A `submitted_at` of NULL does NOT mean "did not submit" — per
    // 002 it means the outcome is UNKNOWN — so the clock still runs.
    const startedAt = intent.submitted_at ?? intent.created_at ?? null;
    const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;

    if (!Number.isFinite(startedMs)) {
        return {
            action: RECOVERY.MANUAL_REVIEW,
            reason: "The intent carries no readable timestamp, so its age cannot be established.",
            baseline,
        };
    }

    const hoursWaited = (now.getTime() - startedMs) / 3600000;

    if (hoursWaited < INTENT_GRACE_HOURS) {
        return {
            action: RECOVERY.WAIT_WITHIN_GRACE,
            reason:
                `No newer report yet; ${Math.floor(hoursWaited)}h of the ` +
                `${INTENT_GRACE_HOURS}h grace period used. Leaving the intent unresolved and ` +
                `re-observing on a later run. Nothing is resubmitted.`,
            hoursWaited,
            baseline,
        };
    }

    return {
        action: RECOVERY.MANUAL_REVIEW,
        reason:
            `No newer report appeared within ${INTENT_GRACE_HOURS}h of an unresolved ` +
            `acquisition intent (status "${intent.status}"). A human must establish whether ` +
            `an order was placed. The processor does not resubmit to find out.`,
        hoursWaited,
        baseline,
    };
}
