import { normalizeReport } from "./reportNormalize.js";
import { verifyCrossReportKeyContinuity } from "./crossReportKeyContinuity.js";
import { toVerifiedTradelineSnapshot } from "./historicalSnapshotAdapter.js";
import { compareVerifiedSnapshots } from "./historicalRecovery.js";

export function compareCapturedReports(prior, current, crcClientId) {
    if (prior?.verifiedActive !== true || current?.verifiedActive !== true ||
        !Array.isArray(prior.reportedAddresses) || !Array.isArray(current.reportedAddresses)) {
        return { ok: false, reason: "verified_capture_required" };
    }
    const a = normalizeReport(prior.payload, { crcClientId, reportedAddresses: prior.reportedAddresses });
    if (!a.extraction_ok) return { ok: false, reason: "prior_extraction_failed" };
    const b = normalizeReport(current.payload, {
        crcClientId, previousReport: a.report, reportedAddresses: current.reportedAddresses,
    });
    if (!b.extraction_ok) return { ok: false, reason: "current_extraction_failed" };
    const continuity = verifyCrossReportKeyContinuity(b);
    if (!continuity.ok) return continuity;
    const first = toVerifiedTradelineSnapshot({
        report: a.report, reportDate: prior.reportDate, verifiedActive: true, extractionOk: true,
    });
    const second = toVerifiedTradelineSnapshot({
        report: b.report, reportDate: current.reportDate, verifiedActive: true, extractionOk: true,
    });
    if (!first.ok || !second.ok) return { ok: false, reason: !first.ok ? first.reason : second.reason };
    return compareVerifiedSnapshots(
        { ...first.snapshot, crossReportIdentityVerified: true },
        { ...second.snapshot, crossReportIdentityVerified: true }
    );
}
