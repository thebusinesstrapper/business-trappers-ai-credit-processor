import { getSupabase } from "./supabase.js";

const TABLE = "item_dispute_history";

function asArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()) : [];
}

function validRound(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

/**
 * Read durable per-item dispute memory and convert it to the shape selectStrategy()
 * already expects: { [stable_item_key]: { currentStatus, rounds: [...] } }.
 *
 * A delivered dispute is stored with outcome "unknown" until a later report or
 * consumer/bureau response proves a more specific outcome. Unknown is deliberate:
 * history may make the next dispute firmer, but it must never invent bureau conduct.
 */
export async function readItemDisputeHistory(crcClientId) {
    const id = crcClientId == null ? "" : String(crcClientId).trim();
    if (!/^\d+$/.test(id)) return { ok: false, reason: "invalid_crc_client_id", itemHistory: {} };

    const supabase = getSupabase();
    const { data, error } = await supabase
        .from(TABLE)
        .select("stable_item_key,bureau,furnisher_name,issue_identified,first_round_disputed,most_recent_round_disputed,strategies_used,reasons_used,latest_outcome,item_status,evidence_facts")
        .eq("crc_client_id", id);

    if (error) return { ok: false, reason: "item_history_read_failed", detail: error.message, itemHistory: {} };

    const itemHistory = {};
    for (const row of data ?? []) {
        const strategies = asArray(row.strategies_used);
        const reasons = asArray(row.reasons_used);
        const firstRound = validRound(row.first_round_disputed) ?? 1;
        const mostRecent = validRound(row.most_recent_round_disputed) ?? firstRound;

        const rounds = strategies.map((strategy, index) => {
            const round = Math.min(6, firstRound + index);
            return {
                round,
                strategy,
                reason: reasons[index] ?? null,
                outcome: round === mostRecent ? (row.latest_outcome ?? "unknown") : "unknown",
            };
        });

        // If a legacy/partial row somehow has no strategy array but does have a
        // most-recent round, preserve the fact of a prior dispute without guessing
        // which strategy was used.
        if (rounds.length === 0 && validRound(row.most_recent_round_disputed)) {
            rounds.push({ round: mostRecent, strategy: null, reason: null, outcome: row.latest_outcome ?? "unknown" });
        }

        itemHistory[row.stable_item_key] = {
            currentStatus: row.item_status,
            bureau: row.bureau,
            furnisher: row.furnisher_name,
            issueIdentified: row.issue_identified,
            evidenceFacts: row.evidence_facts ?? null,
            rounds,
        };
    }

    return { ok: true, itemHistory, rows: data ?? [] };
}

function safeText(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 1000);
    return fallback;
}

/**
 * Record the exact items/strategies/reasons that were actually delivered in a
 * confirmed successful round. Idempotent per client+bureau+stable_item_key+round.
 *
 * IMPORTANT: this is strategy memory, NOT a suppression list. item_status remains
 * active_candidate after delivery. A still-reporting derogatory item remains
 * eligible for a later dispute unless it is explicitly resolved/excluded/NFA.
 */
export async function recordDeliveredItemHistory({ crcClientId, roundCompleted, chainItems = [] } = {}) {
    const id = crcClientId == null ? "" : String(crcClientId).trim();
    const round = validRound(roundCompleted);
    if (!/^\d+$/.test(id)) return { ok: false, reason: "invalid_crc_client_id", written: 0 };
    if (!round) return { ok: false, reason: "invalid_round_completed", written: 0 };
    if (!Array.isArray(chainItems)) return { ok: false, reason: "chain_items_required", written: 0 };

    const deliverable = chainItems.filter((item) =>
        item?.chainComplete === true &&
        item?.round === round &&
        typeof item?.stableItemKey === "string" && item.stableItemKey.trim() &&
        typeof item?.bureau === "string" && item.bureau.trim() &&
        item?.strategy?.strategy && item.strategy.strategy !== "BT-ST-0016" &&
        item?.reason?.reason && item.reason.reason !== "BT-RN-0026"
    );

    const supabase = getSupabase();
    let written = 0;
    let duplicates = 0;
    const errors = [];

    for (const item of deliverable) {
        const key = item.stableItemKey.trim();
        const bureau = item.bureau.trim();

        const { data: existing, error: readError } = await supabase
            .from(TABLE)
            .select("item_dispute_history_id,first_round_disputed,most_recent_round_disputed,strategies_used,reasons_used")
            .eq("crc_client_id", id)
            .eq("bureau", bureau)
            .eq("stable_item_key", key)
            .maybeSingle();

        if (readError) {
            errors.push({ stableItemKey: key, reason: "read_failed", detail: readError.message });
            continue;
        }

        if (existing && Number(existing.most_recent_round_disputed) === round) {
            duplicates += 1;
            continue;
        }

        const strategy = item.strategy.strategy;
        const reason = item.reason.reason;
        const strategies = [...asArray(existing?.strategies_used), strategy];
        const reasons = [...asArray(existing?.reasons_used), reason];

        const payload = {
            crc_client_id: id,
            stable_item_key: key,
            bureau,
            furnisher_name: safeText(item.furnisher, "Unknown furnisher"),
            issue_identified: safeText(item.decisionRecord, reason),
            first_round_disputed: validRound(existing?.first_round_disputed) ?? round,
            most_recent_round_disputed: round,
            strategies_used: strategies,
            reasons_used: reasons,
            latest_outcome: "unknown",
            item_status: "active_candidate",
            evidence_facts: safeText(
                Array.isArray(item.reasoningChain) ? item.reasoningChain.join(" | ") : null,
                null
            ),
            updated_at: new Date().toISOString(),
        };

        let result;
        if (existing?.item_dispute_history_id) {
            result = await supabase
                .from(TABLE)
                .update(payload)
                .eq("item_dispute_history_id", existing.item_dispute_history_id)
                .select("item_dispute_history_id")
                .single();
        } else {
            result = await supabase
                .from(TABLE)
                .insert(payload)
                .select("item_dispute_history_id")
                .single();
        }

        if (result.error) {
            errors.push({ stableItemKey: key, reason: "write_failed", detail: result.error.message });
        } else {
            written += 1;
        }
    }

    return {
        ok: errors.length === 0,
        written,
        duplicates,
        eligibleItems: deliverable.length,
        errors,
    };
}
