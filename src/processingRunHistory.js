import { getSupabase } from "./supabase.js";

const TABLE = "processing_run_history";

function validIsoDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validIsoTimestamp(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
}

function nonNegativeIntOrNull(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Persist one confirmed successful dispute cycle in processing_run_history.
 *
 * Safety rules:
 * - success-only: callers should invoke this only after confirmed delivery AND
 *   a successful lifecycle advance/completion.
 * - idempotent: a matching completed row for client + round + report date is
 *   returned instead of inserting a duplicate.
 * - audit-only: failure to write history must never cause a resend or mutate
 *   client_state; callers should log a failed audit write and continue.
 * - unknown fields stay null rather than being inferred.
 */
export async function recordSuccessfulProcessingRun({
    crcClientId,
    roundCompleted,
    reportDateUsed,
    startedAt,
    eligibilityReason,
    lettersGenerated = null,
    crcSaveVerified = false,
    clientNotificationVerified = false,
    resultingClientState = null,
    reportSource = null,
    negativeItemsFound = null,
    negativeItemsRemaining = null,
} = {}) {
    const id = crcClientId == null ? "" : String(crcClientId).trim();
    const round = Number(roundCompleted);

    if (!/^\d+$/.test(id)) {
        return { ok: false, reason: "invalid_crc_client_id" };
    }
    if (!Number.isInteger(round) || round < 1 || round > 6) {
        return { ok: false, reason: "invalid_round_completed" };
    }
    if (!validIsoDate(reportDateUsed)) {
        return { ok: false, reason: "valid_report_date_required" };
    }
    if (!validIsoTimestamp(startedAt)) {
        return { ok: false, reason: "valid_started_at_required" };
    }

    const allowedStates = new Set(["ready", "processing", "waiting", "blocked", "complete"]);
    const safeResultingState = allowedStates.has(resultingClientState) ? resultingClientState : null;
    const safeReportSource = ["existing", "newly_ordered_free"].includes(reportSource)
        ? reportSource
        : null;

    const supabase = getSupabase();

    const { data: existing, error: existingError } = await supabase
        .from(TABLE)
        .select("processing_run_id, crc_client_id, round_completed, report_date_used, run_result")
        .eq("crc_client_id", id)
        .eq("round_completed", round)
        .eq("report_date_used", reportDateUsed)
        .eq("run_result", "completed")
        .maybeSingle();

    if (existingError) {
        return { ok: false, reason: "audit_dedupe_read_failed", detail: existingError.message };
    }
    if (existing) {
        return { ok: true, duplicate: true, row: existing };
    }

    const payload = {
        crc_client_id: id,
        started_at: new Date(startedAt).toISOString(),
        completed_at: new Date().toISOString(),
        round_attempted: round,
        round_completed: round,
        eligibility_decision: "eligible",
        eligibility_reason:
            typeof eligibilityReason === "string" && eligibilityReason.trim()
                ? eligibilityReason.trim().slice(0, 1000)
                : `Confirmed delivery used report ${reportDateUsed}.`,
        credit_hero_access_outcome: "active",
        report_date_used: reportDateUsed,
        report_source: safeReportSource,
        negative_items_found: nonNegativeIntOrNull(negativeItemsFound),
        negative_items_remaining: nonNegativeIntOrNull(negativeItemsRemaining),
        letters_generated: nonNegativeIntOrNull(lettersGenerated),
        crc_save_verified: crcSaveVerified === true,
        client_notification_verified: clientNotificationVerified === true,
        run_result: "completed",
        failure_or_block_reason: null,
        previous_client_state: "ready",
        resulting_client_state: safeResultingState,
    };

    const { data, error } = await supabase
        .from(TABLE)
        .insert(payload)
        .select()
        .single();

    if (error) {
        return { ok: false, reason: "audit_insert_failed", detail: error.message };
    }

    return { ok: true, duplicate: false, row: data };
}
