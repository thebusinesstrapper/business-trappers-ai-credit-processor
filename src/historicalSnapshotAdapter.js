/**
 * Convert an already verified, fully normalized Credit Hero report to the
 * minimal tradeline snapshot consumed by historicalRecovery.
 * Never infer report verification, completeness, or dispute delivery.
 */
export function toVerifiedTradelineSnapshot({ report, reportDate, verifiedActive, extractionOk } = {}) {
    if (verifiedActive !== true || extractionOk !== true || !report ||
        !Array.isArray(report.accounts) ||
        typeof reportDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(reportDate) ||
        report.report_metadata?.report_date !== reportDate) {
        return { ok: false, reason: "verified_report_and_matching_date_required" };
    }
    const items = [];
    for (const account of report.accounts) {
        if (!Array.isArray(account?.bureau_tradelines)) {
            return { ok: false, reason: "incomplete_tradeline_structure" };
        }
        for (const tradeline of account.bureau_tradelines) {
            const stableItemKey = tradeline?.stable_item_key;
            if (typeof stableItemKey !== "string" || !stableItemKey.trim()) {
                return { ok: false, reason: "missing_stable_tradeline_key" };
            }
            items.push({ stableItemKey, bureau: tradeline.bureau ?? null, accountKey: account.stable_account_key ?? null });
        }
    }
    if (new Set(items.map(i => i.stableItemKey)).size !== items.length) {
        return { ok: false, reason: "duplicate_stable_tradeline_keys" };
    }
    return {
        ok: true,
        snapshot: {
            verified: true,
            extractionComplete: true,
            reportDate,
            scope: "tradelines_only",
            crossReportIdentityVerified: false, // No prior key registry was supplied by M6.
            items,
        },
    };
}
