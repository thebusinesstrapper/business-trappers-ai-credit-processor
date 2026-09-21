import { getSupabase } from "./supabase.js";

const SUMMARY_TABLE = "round_item_progress";
const OUTCOME_TABLE = "item_round_outcomes";

function validRound(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

function validIsoDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function asKey(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function disputedInRound(row, round) {
    const first = Number(row?.first_round_disputed);
    const mostRecent = Number(row?.most_recent_round_disputed);
    if (!Number.isInteger(first) || !Number.isInteger(mostRecent)) return false;
    if (round < first || round > mostRecent) return false;

    const strategies = Array.isArray(row?.strategies_used) ? row.strategies_used : [];
    if (strategies.length === 0) return round === mostRecent;

    const index = round - first;
    return index >= 0 && index < strategies.length;
}

function deliveredKeys(chainItems, round) {
    const keys = new Set();
    for (const item of Array.isArray(chainItems) ? chainItems : []) {
        const key = asKey(item?.stableItemKey);
        if (
            key &&
            item?.chainComplete === true &&
            Number(item?.round) === round &&
            item?.strategy?.strategy &&
            item.strategy.strategy !== "BT-ST-0016" &&
            item?.reason?.reason &&
            item.reason.reason !== "BT-RN-0026"
        ) {
            keys.add(key);
        }
    }
    return keys;
}

export function calculateLiveRoundProgress({
    roundCompleted,
    priorHistoryRows = [],
    currentItemKeys = [],
    chainItems = [],
} = {}) {
    const round = validRound(roundCompleted);
    if (!round) return { ok: false, reason: "invalid_round_completed" };

    const history = Array.isArray(priorHistoryRows) ? priorHistoryRows : [];
    const currentKeys = new Set((Array.isArray(currentItemKeys) ? currentItemKeys : []).map(asKey).filter(Boolean));
    const thisRoundKeys = deliveredKeys(chainItems, round);

    if (round === 1) {
        return {
            ok: true,
            priorDisputedItems: null,
            deletedItems: null,
            stillReportingItems: null,
            unknownItems: null,
            newlyDisputedItems: thisRoundKeys.size,
            disputedThisRound: thisRoundKeys.size,
            comparisonComplete: false,
            outcomes: [],
        };
    }

    const priorRound = round - 1;
    const priorRows = history.filter((row) => disputedInRound(row, priorRound));
    const priorKeys = new Set(priorRows.map((row) => asKey(row?.stable_item_key)).filter(Boolean));

    // Legacy clients may reach their first post-launch round without any durable
    // item history for the previous round. Do not turn "missing history" into
    // zero deletions or "all new" items. The round itself is still recorded, but
    // comparison metrics remain unknown until a later round has a true baseline.
    if (priorKeys.size === 0) {
        return {
            ok: true,
            priorDisputedItems: null,
            deletedItems: null,
            stillReportingItems: null,
            unknownItems: null,
            newlyDisputedItems: null,
            disputedThisRound: thisRoundKeys.size,
            comparisonComplete: false,
            outcomes: [],
        };
    }

    const allPriorKeys = new Set(history.map((row) => asKey(row?.stable_item_key)).filter(Boolean));

    let deleted = 0;
    let stillReporting = 0;
    const outcomes = [];

    for (const key of priorKeys) {
        const outcome = currentKeys.has(key) ? "still_reporting" : "deleted";
        if (outcome === "deleted") deleted += 1;
        else stillReporting += 1;
        outcomes.push({ stableItemKey: key, priorRoundDisputed: priorRound, outcome });
    }

    let newlyDisputed = 0;
    for (const key of thisRoundKeys) {
        if (!allPriorKeys.has(key)) newlyDisputed += 1;
    }

    return {
        ok: true,
        priorDisputedItems: priorKeys.size,
        deletedItems: deleted,
        stillReportingItems: stillReporting,
        unknownItems: 0,
        newlyDisputedItems: newlyDisputed,
        disputedThisRound: thisRoundKeys.size,
        comparisonComplete: true,
        outcomes,
    };
}

export async function recordLiveRoundProgress({
    crcClientId,
    roundCompleted,
    reportDateUsed,
    priorHistoryRows = [],
    currentItemKeys = [],
    chainItems = [],
} = {}) {
    const id = crcClientId == null ? "" : String(crcClientId).trim();
    const round = validRound(roundCompleted);

    if (!/^\d+$/.test(id)) return { ok: false, reason: "invalid_crc_client_id" };
    if (!round) return { ok: false, reason: "invalid_round_completed" };
    if (!validIsoDate(reportDateUsed)) return { ok: false, reason: "valid_report_date_required" };

    const calculated = calculateLiveRoundProgress({
        roundCompleted: round,
        priorHistoryRows,
        currentItemKeys,
        chainItems,
    });
    if (!calculated.ok) return calculated;

    const supabase = getSupabase();
    const now = new Date();
    const nowIso = now.toISOString();
    const roundDate = nowIso.slice(0, 10);

    const summaryPayload = {
        crc_client_id: id,
        round_completed: round,
        round_completed_date: roundDate,
        report_date_used: reportDateUsed,
        prior_disputed_items: calculated.priorDisputedItems,
        deleted_items: calculated.deletedItems,
        still_reporting_items: calculated.stillReportingItems,
        unknown_items: calculated.unknownItems,
        newly_disputed_items: calculated.newlyDisputedItems,
        disputed_this_round: calculated.disputedThisRound,
        comparison_complete: calculated.comparisonComplete,
        data_source: "live_verified",
        delivery_recorded_at: nowIso,
        updated_at: nowIso,
    };

    const { data: summary, error: summaryError } = await supabase
        .from(SUMMARY_TABLE)
        .upsert(summaryPayload, { onConflict: "crc_client_id,round_completed" })
        .select()
        .single();

    if (summaryError) {
        return { ok: false, reason: "round_progress_summary_write_failed", detail: summaryError.message };
    }

    const outcomeErrors = [];
    for (const outcome of calculated.outcomes) {
        const payload = {
            crc_client_id: id,
            observed_round: round,
            report_date_used: reportDateUsed,
            stable_item_key: outcome.stableItemKey,
            prior_round_disputed: outcome.priorRoundDisputed,
            outcome: outcome.outcome,
            updated_at: nowIso,
        };

        const { error } = await supabase
            .from(OUTCOME_TABLE)
            .upsert(payload, { onConflict: "crc_client_id,observed_round,stable_item_key" });

        if (error) outcomeErrors.push({ stableItemKey: outcome.stableItemKey, detail: error.message });
    }

    return {
        ok: outcomeErrors.length === 0,
        summary,
        outcomesWritten: calculated.outcomes.length - outcomeErrors.length,
        outcomeErrors,
    };
}

function inferCompletedRoundCount(client) {
    const current = validRound(client?.current_round) ?? 1;

    // Normal lifecycle: current_round points to the NEXT round, so current-1
    // rounds have been completed. On final completion current_round remains 6,
    // therefore process_complete proves round 6 was also delivered.
    if (client?.process_complete === true && current === 6) return 6;

    let completed = Math.max(0, current - 1);

    // Historical/status-write exception: a confirmed dispute date with current
    // round still at 1 proves at least Round 1 happened (e.g. a post-delivery CRC
    // status write failed before round advancement).
    if (completed === 0 && client?.last_dispute_date) completed = 1;

    return Math.min(6, completed);
}

function historyCountsForRound(rows, round) {
    const currentRows = rows.filter((row) => disputedInRound(row, round));
    const priorRows = round > 1 ? rows.filter((row) => disputedInRound(row, round - 1)) : [];

    const currentKeys = new Set(currentRows.map((row) => asKey(row?.stable_item_key)).filter(Boolean));
    const priorKeys = new Set(priorRows.map((row) => asKey(row?.stable_item_key)).filter(Boolean));

    let newlyDisputed = 0;
    for (const row of currentRows) {
        if (Number(row?.first_round_disputed) === round) newlyDisputed += 1;
    }

    const hasCurrentEvidence = currentKeys.size > 0;
    const hasPriorEvidence = priorKeys.size > 0;

    return {
        disputedThisRound: hasCurrentEvidence ? currentKeys.size : null,
        priorDisputedItems: hasPriorEvidence ? priorKeys.size : null,
        newlyDisputedItems: hasCurrentEvidence ? newlyDisputed : null,
        hasItemEvidence: hasCurrentEvidence || hasPriorEvidence,
    };
}

/**
 * Coverage invariant: every client whose durable client_state proves a round was
 * completed must have one and only one round_item_progress row for that round.
 *
 * This is intentionally conservative for legacy history. It records that the
 * round happened and any item counts we can actually prove, but NEVER invents
 * deletion/still-reporting outcomes without a complete prior/current report
 * comparison. A later live_verified write replaces the historical placeholder.
 */
export async function ensureRoundProgressCoverage() {
    const supabase = getSupabase();

    const [{ data: clients, error: clientError }, { data: historyRows, error: historyError }] = await Promise.all([
        supabase
            .from("client_state")
            .select("crc_client_id,current_round,last_dispute_date,process_complete"),
        supabase
            .from("item_dispute_history")
            .select("crc_client_id,stable_item_key,first_round_disputed,most_recent_round_disputed,strategies_used"),
    ]);

    if (clientError) return { ok: false, reason: "client_state_read_failed", detail: clientError.message };
    if (historyError) return { ok: false, reason: "item_history_read_failed", detail: historyError.message };

    const historyByClient = new Map();
    for (const row of historyRows ?? []) {
        const id = String(row.crc_client_id);
        if (!historyByClient.has(id)) historyByClient.set(id, []);
        historyByClient.get(id).push(row);
    }

    let expectedRows = 0;
    let insertedOrUpdated = 0;
    let preservedLive = 0;
    const errors = [];

    for (const client of clients ?? []) {
        const id = String(client.crc_client_id);
        const completedRounds = inferCompletedRoundCount(client);
        const history = historyByClient.get(id) ?? [];

        for (let round = 1; round <= completedRounds; round += 1) {
            expectedRows += 1;

            const { data: existing, error: existingError } = await supabase
                .from(SUMMARY_TABLE)
                .select("data_source")
                .eq("crc_client_id", id)
                .eq("round_completed", round)
                .maybeSingle();

            if (existingError) {
                errors.push({ crcClientId: id, round, reason: existingError.message });
                continue;
            }

            if (existing?.data_source === "live_verified") {
                preservedLive += 1;
                continue;
            }

            const counts = historyCountsForRound(history, round);
            const isMostRecent = round === completedRounds;
            const roundCompletedDate = isMostRecent && validIsoDate(client.last_dispute_date)
                ? client.last_dispute_date
                : null;

            const { error } = await supabase
                .from(SUMMARY_TABLE)
                .upsert({
                    crc_client_id: id,
                    round_completed: round,
                    round_completed_date: roundCompletedDate,
                    report_date_used: null,
                    prior_disputed_items: counts.priorDisputedItems,
                    deleted_items: null,
                    still_reporting_items: null,
                    unknown_items: counts.priorDisputedItems,
                    newly_disputed_items: counts.newlyDisputedItems,
                    disputed_this_round: counts.disputedThisRound,
                    comparison_complete: false,
                    data_source: counts.hasItemEvidence ? "historical_item_evidence" : "historical_round_only",
                    delivery_recorded_at: null,
                    updated_at: new Date().toISOString(),
                }, { onConflict: "crc_client_id,round_completed" });

            if (error) errors.push({ crcClientId: id, round, reason: error.message });
            else insertedOrUpdated += 1;
        }
    }

    return {
        ok: errors.length === 0,
        expectedRows,
        insertedOrUpdated,
        preservedLive,
        errors,
    };
}

export async function backfillHistoricalRoundProgress() {
    return ensureRoundProgressCoverage();
}

export async function getRoundResultsData() {
    const supabase = getSupabase();

    const [{ data: summaries, error: summaryError }, { data: clients, error: clientError }] = await Promise.all([
        supabase
            .from(SUMMARY_TABLE)
            .select("crc_client_id,round_completed,round_completed_date,report_date_used,prior_disputed_items,deleted_items,still_reporting_items,unknown_items,newly_disputed_items,disputed_this_round,comparison_complete,data_source,delivery_recorded_at,updated_at")
            .order("round_completed_date", { ascending: false, nullsFirst: false })
            .order("crc_client_id", { ascending: true })
            .order("round_completed", { ascending: true }),
        supabase
            .from("client_state")
            .select("crc_client_id,client_display_name"),
    ]);

    if (summaryError) throw new Error(summaryError.message);
    if (clientError) throw new Error(clientError.message);

    const names = new Map((clients ?? []).map((row) => [String(row.crc_client_id), row.client_display_name ?? null]));

    const records = (summaries ?? []).map((row) => {
        const verifiedComparison = row.data_source === "live_verified" && row.comparison_complete === true;
        const comparisonStatus = verifiedComparison
            ? "Verified"
            : row.data_source === "live_verified" && Number(row.round_completed) === 1
                ? "Not applicable - first round"
                : row.data_source === "live_verified"
                    ? "Live - prior baseline unavailable"
                    : row.data_source === "historical_item_evidence"
                        ? "Historical - item counts only"
                        : "Historical - round confirmed";

        return {
            client_name: names.get(String(row.crc_client_id)) ?? null,
            ...row,
            deletion_rate:
                verifiedComparison && Number(row.prior_disputed_items) > 0
                    ? Number(row.deleted_items) / Number(row.prior_disputed_items)
                    : null,
            comparison_status: comparisonStatus,
            data_source_label: row.data_source === "live_verified" ? "Live Verified" : "Historical Reconstruction",
        };
    });

    const verified = records.filter((row) => row.data_source === "live_verified" && row.comparison_complete === true);
    const totals = verified.reduce((acc, row) => {
        acc.prior_disputed_items += Number(row.prior_disputed_items) || 0;
        acc.deleted_items += Number(row.deleted_items) || 0;
        acc.still_reporting_items += Number(row.still_reporting_items) || 0;
        acc.disputed_this_round += Number(row.disputed_this_round) || 0;
        return acc;
    }, { prior_disputed_items: 0, deleted_items: 0, still_reporting_items: 0, disputed_this_round: 0 });

    return {
        ok: true,
        generatedAt: new Date().toISOString(),
        recordCount: records.length,
        totals: {
            ...totals,
            deletion_rate: totals.prior_disputed_items > 0
                ? totals.deleted_items / totals.prior_disputed_items
                : null,
        },
        records,
    };
}
