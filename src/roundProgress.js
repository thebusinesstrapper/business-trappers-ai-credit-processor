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
    if (strategies.length === 0) {
        return round === mostRecent;
    }

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

    const priorRound = round - 1;
    const priorRows = priorRound >= 1
        ? (Array.isArray(priorHistoryRows) ? priorHistoryRows : []).filter((row) => disputedInRound(row, priorRound))
        : [];

    const priorKeys = new Set(priorRows.map((row) => asKey(row?.stable_item_key)).filter(Boolean));
    const allPriorKeys = new Set(
        (Array.isArray(priorHistoryRows) ? priorHistoryRows : [])
            .map((row) => asKey(row?.stable_item_key))
            .filter(Boolean)
    );
    const currentKeys = new Set((Array.isArray(currentItemKeys) ? currentItemKeys : []).map(asKey).filter(Boolean));
    const thisRoundKeys = deliveredKeys(chainItems, round);

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
        comparisonComplete: round === 1 ? true : true,
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
    const nowIso = new Date().toISOString();

    const summaryPayload = {
        crc_client_id: id,
        round_completed: round,
        report_date_used: reportDateUsed,
        prior_disputed_items: calculated.priorDisputedItems,
        deleted_items: calculated.deletedItems,
        still_reporting_items: calculated.stillReportingItems,
        unknown_items: calculated.unknownItems,
        newly_disputed_items: calculated.newlyDisputedItems,
        disputed_this_round: calculated.disputedThisRound,
        comparison_complete: calculated.comparisonComplete,
        data_source: "live_verified",
        updated_at: nowIso,
    };

    const { data: summary, error: summaryError } = await supabase
        .from(SUMMARY_TABLE)
        .upsert(summaryPayload, {
            onConflict: "crc_client_id,round_completed,report_date_used",
        })
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
            .upsert(payload, {
                onConflict: "crc_client_id,observed_round,report_date_used,stable_item_key",
            });

        if (error) {
            outcomeErrors.push({ stableItemKey: outcome.stableItemKey, detail: error.message });
        }
    }

    return {
        ok: outcomeErrors.length === 0,
        summary,
        outcomesWritten: calculated.outcomes.length - outcomeErrors.length,
        outcomeErrors,
    };
}

export function calculateHistoricalRoundProgress(rows = [], roundCompleted) {
    const round = validRound(roundCompleted);
    if (!round) return { ok: false, reason: "invalid_round_completed" };

    const priorRound = round - 1;
    const priorRows = priorRound >= 1
        ? rows.filter((row) => disputedInRound(row, priorRound))
        : [];
    const currentRows = rows.filter((row) => disputedInRound(row, round));

    const priorKeys = new Set(priorRows.map((row) => asKey(row?.stable_item_key)).filter(Boolean));
    const currentKeys = new Set(currentRows.map((row) => asKey(row?.stable_item_key)).filter(Boolean));

    let stillReporting = 0;
    for (const key of priorKeys) {
        if (currentKeys.has(key)) stillReporting += 1;
    }

    let newlyDisputed = 0;
    for (const row of currentRows) {
        if (Number(row?.first_round_disputed) === round) newlyDisputed += 1;
    }

    const unknown = Math.max(0, priorKeys.size - stillReporting);

    return {
        ok: true,
        priorDisputedItems: priorKeys.size,
        deletedItems: 0,
        stillReportingItems: stillReporting,
        unknownItems: unknown,
        newlyDisputedItems: newlyDisputed,
        disputedThisRound: currentKeys.size,
        comparisonComplete: unknown === 0,
    };
}

export async function backfillHistoricalRoundProgress() {
    const supabase = getSupabase();

    const { data: historyRows, error: historyError } = await supabase
        .from("item_dispute_history")
        .select("crc_client_id,stable_item_key,first_round_disputed,most_recent_round_disputed,strategies_used");

    if (historyError) {
        return { ok: false, reason: "item_history_read_failed", detail: historyError.message };
    }

    const { data: runs, error: runsError } = await supabase
        .from("processing_run_history")
        .select("crc_client_id,round_completed,report_date_used,run_result")
        .eq("run_result", "completed")
        .not("round_completed", "is", null)
        .not("report_date_used", "is", null);

    if (runsError) {
        return { ok: false, reason: "processing_history_read_failed", detail: runsError.message };
    }

    const byClient = new Map();
    for (const row of historyRows ?? []) {
        const id = String(row.crc_client_id);
        if (!byClient.has(id)) byClient.set(id, []);
        byClient.get(id).push(row);
    }

    let written = 0;
    let skippedLive = 0;
    const errors = [];

    for (const run of runs ?? []) {
        const id = String(run.crc_client_id);
        const round = validRound(run.round_completed);
        const reportDate = run.report_date_used;
        if (!round || !validIsoDate(reportDate)) continue;

        const { data: existing, error: existingError } = await supabase
            .from(SUMMARY_TABLE)
            .select("round_item_progress_id,data_source")
            .eq("crc_client_id", id)
            .eq("round_completed", round)
            .eq("report_date_used", reportDate)
            .maybeSingle();

        if (existingError) {
            errors.push({ crcClientId: id, round, reason: existingError.message });
            continue;
        }
        if (existing?.data_source === "live_verified") {
            skippedLive += 1;
            continue;
        }

        const calc = calculateHistoricalRoundProgress(byClient.get(id) ?? [], round);
        if (!calc.ok) continue;

        const { error } = await supabase
            .from(SUMMARY_TABLE)
            .upsert({
                crc_client_id: id,
                round_completed: round,
                report_date_used: reportDate,
                prior_disputed_items: calc.priorDisputedItems,
                deleted_items: calc.deletedItems,
                still_reporting_items: calc.stillReportingItems,
                unknown_items: calc.unknownItems,
                newly_disputed_items: calc.newlyDisputedItems,
                disputed_this_round: calc.disputedThisRound,
                comparison_complete: calc.comparisonComplete,
                data_source: "historical_inferred",
                updated_at: new Date().toISOString(),
            }, {
                onConflict: "crc_client_id,round_completed,report_date_used",
            });

        if (error) {
            errors.push({ crcClientId: id, round, reason: error.message });
        } else {
            written += 1;
        }
    }

    return { ok: errors.length === 0, written, skippedLive, errors };
}

export async function getRoundResultsData() {
    const supabase = getSupabase();

    const [{ data: summaries, error: summaryError }, { data: clients, error: clientError }] = await Promise.all([
        supabase
            .from(SUMMARY_TABLE)
            .select("crc_client_id,round_completed,report_date_used,prior_disputed_items,deleted_items,still_reporting_items,unknown_items,newly_disputed_items,disputed_this_round,comparison_complete,data_source,updated_at")
            .order("report_date_used", { ascending: false })
            .order("crc_client_id", { ascending: true }),
        supabase
            .from("client_state")
            .select("crc_client_id,client_display_name"),
    ]);

    if (summaryError) throw new Error(summaryError.message);
    if (clientError) throw new Error(clientError.message);

    const names = new Map((clients ?? []).map((row) => [String(row.crc_client_id), row.client_display_name ?? null]));

    const records = (summaries ?? []).map((row) => ({
        client_name: names.get(String(row.crc_client_id)) ?? null,
        ...row,
        deletion_rate:
            Number(row.prior_disputed_items) > 0 && row.comparison_complete === true
                ? Number(row.deleted_items) / Number(row.prior_disputed_items)
                : null,
    }));

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
