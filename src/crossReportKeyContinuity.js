/**
 * A matched key registry is required before two dated snapshots can be
 * compared. Newly minted current keys may indicate identity drift.
 */
export function verifyCrossReportKeyContinuity(normalizedCurrent) {
    if (normalizedCurrent?.extraction_ok !== true) {
        return { ok: false, reason: "current_extraction_failed" };
    }
    const keys = normalizedCurrent.key_resolution;
    if (!keys || keys.accounts?.ambiguous?.length ||
        keys.tradelines?.ambiguous?.length ||
        keys.accounts?.minted !== 0 || keys.tradelines?.minted !== 0) {
        return { ok: false, reason: "unresolved_cross_report_identity" };
    }
    return { ok: true };
}
