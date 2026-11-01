import { compareVerifiedSnapshots } from "./historicalRecovery.js";

/**
 * Validate that dated report comparisons have sufficient evidence.
 * A report difference is not proof that a dispute was sent.
 */
export function assessHistoricalEvidence({ snapshots, deliveryRecords } = {}) {
    if (!Array.isArray(snapshots) || snapshots.length < 2) {
        return { ok: false, reason: "historical_snapshots_required" };
    }
    if (!Array.isArray(deliveryRecords)) {
        return { ok: false, reason: "delivery_records_required" };
    }
    const ordered = [...snapshots].sort((a, b) => String(a.reportDate).localeCompare(String(b.reportDate)));
    const comparisons = [];
    for (let i = 1; i < ordered.length; i++) {
        const result = compareVerifiedSnapshots(ordered[i - 1], ordered[i]);
        if (!result.ok) return { ok: false, reason: result.reason };
        comparisons.push(result);
    }
    const unverifiedDeliveries = deliveryRecords.filter(r =>
        r?.verified !== true ||
        !Number.isInteger(r?.round) ||
        r.round < 1 || r.round > 7 ||
        typeof r?.stableItemKey !== "string" || !r.stableItemKey.trim() ||
        typeof r?.strategy !== "string" || !r.strategy.trim()
    );
    if (unverifiedDeliveries.length) {
        return { ok: false, reason: "unverified_delivery_records", unverifiedCount: unverifiedDeliveries.length };
    }
    const deliveryKeys = deliveryRecords.map(r => [r.round, r.stableItemKey.trim()].join(":"));
    if (new Set(deliveryKeys).size !== deliveryKeys.length) {
        return { ok: false, reason: "duplicate_delivery_records" };
    }
    return { ok: true, comparisons, verifiedDeliveries: deliveryRecords };
}
