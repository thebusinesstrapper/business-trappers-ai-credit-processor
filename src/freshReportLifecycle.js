import { getSupabase } from "./supabase.js";

const CLIENT_STATE_TABLE = "client_state";

function validClientId(value) {
    const id = String(value ?? "");
    return /^\d+$/.test(id) ? id : null;
}

function validIsoDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? value
        : null;
}

/**
 * Atomically record the report actually used and advance rounds 1-5 after a
 * confirmed CRC secure-message delivery. The row must already be in `waiting`,
 * which is written only after M8 confirms the message was sent.
 *
 * Permanent future-cycle rule: next_eligible_date is cleared. Future readiness
 * is determined by a strictly newer Credit Hero report, not elapsed days.
 */
export async function advanceAfterFreshReportDelivery(crcClientId, deliveredRound, reportDateUsed) {
    const id = validClientId(crcClientId);
    const round = Number(deliveredRound);
    const reportDate = validIsoDate(reportDateUsed);

    if (!id) return { ok: false, reason: "invalid_crc_client_id" };
    if (!Number.isInteger(round) || round < 1 || round >= 6) {
        return { ok: false, reason: "invalid_delivered_round", deliveredRound };
    }
    if (!reportDate) return { ok: false, reason: "invalid_report_date_used" };

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({
            current_round: round + 1,
            processing_state: "ready",
            last_dispute_date: today,
            next_eligible_date: null,
            last_report_date_used: reportDate,
            last_successful_processing_at: now.toISOString(),
            ai_initialized: true,
            block_reason: null,
        })
        .eq("crc_client_id", id)
        .eq("current_round", round)
        .eq("processing_state", "waiting")
        .select("crc_client_id,current_round,processing_state,last_report_date_used,last_dispute_date,next_eligible_date")
        .maybeSingle();

    if (error) throw new Error(`Failed fresh-report round advance: ${error.message}`);
    if (!data) return { ok: false, reason: "already_advanced_or_not_delivered" };

    return {
        ok: true,
        previousRound: round,
        newRound: data.current_round,
        reportDateUsed: data.last_report_date_used,
        state: data,
    };
}

/** Store the final round's report date before the existing terminal completion writer. */
export async function recordFinalFreshReportDelivery(crcClientId, deliveredRound, reportDateUsed) {
    const id = validClientId(crcClientId);
    const round = Number(deliveredRound);
    const reportDate = validIsoDate(reportDateUsed);

    if (!id) return { ok: false, reason: "invalid_crc_client_id" };
    if (round !== 6) return { ok: false, reason: "final_round_required" };
    if (!reportDate) return { ok: false, reason: "invalid_report_date_used" };

    const now = new Date();
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({
            last_report_date_used: reportDate,
            last_dispute_date: now.toISOString().slice(0, 10),
            next_eligible_date: null,
            last_successful_processing_at: now.toISOString(),
            ai_initialized: true,
            block_reason: null,
        })
        .eq("crc_client_id", id)
        .eq("current_round", round)
        .eq("processing_state", "waiting")
        .select("crc_client_id,current_round,processing_state,last_report_date_used")
        .maybeSingle();

    if (error) throw new Error(`Failed final fresh-report record: ${error.message}`);
    if (!data) return { ok: false, reason: "final_delivery_state_not_found" };

    return { ok: true, reportDateUsed: data.last_report_date_used, state: data };
}
