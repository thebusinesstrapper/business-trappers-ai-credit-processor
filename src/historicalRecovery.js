/**
 * Evidence-only historical comparison for on-demand recovery.
 * Input snapshots must already be extracted from VERIFIED dated reports.
 * This module does not infer prior disputes from account appearances.
 */
function keyOf(item) {
    return typeof item?.stableItemKey === "string" && item.stableItemKey.trim()
        ? item.stableItemKey.trim() : null;
}
function validate(snapshot) {
    if (!snapshot || snapshot.verified !== true ||
        typeof snapshot.reportDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.reportDate) ||
        !Array.isArray(snapshot.items) || snapshot.extractionComplete !== true) {
        return { ok: false, reason: "verified_complete_snapshot_required" };
    }
    const keys = snapshot.items.map(keyOf);
    if (keys.some(k => !k) || new Set(keys).size !== keys.length) {
        return { ok: false, reason: "stable_unique_item_keys_required" };
    }
    return { ok: true };
}
export function compareVerifiedSnapshots(prior, current) {
    const a = validate(prior), b = validate(current);
    if (!a.ok || !b.ok) return { ok: false, reason: !a.ok ? a.reason : b.reason, outcomes: [] };
    if (current.reportDate <= prior.reportDate) {
        return { ok: false, reason: "strictly_newer_report_required", outcomes: [] };
    }
    const before = new Map(prior.items.map(item => [keyOf(item), item]));
    const after = new Map(current.items.map(item => [keyOf(item), item]));
    const outcomes = [];
    for (const [key, oldItem] of before) {
        const now = after.get(key);
        outcomes.push({
            stableItemKey: key,
            priorReportDate: prior.reportDate,
            currentReportDate: current.reportDate,
            outcome: now ? "still_reporting" : "not_observed_in_new_report",
            // Not observed does NOT establish deletion by a bureau or causation by a dispute.
            evidence: { prior: oldItem, current: now ?? null },
            priorDisputeVerified: false,
        });
    }
    for (const [key, item] of after) {
        if (!before.has(key)) outcomes.push({
            stableItemKey: key,
            priorReportDate: prior.reportDate,
            currentReportDate: current.reportDate,
            outcome: "newly_observed",
            evidence: { prior: null, current: item },
            priorDisputeVerified: false,
        });
    }
    return { ok: true, outcomes, reportDates: [prior.reportDate, current.reportDate] };
}
