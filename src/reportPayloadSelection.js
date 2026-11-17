/**
 * Select a captured report only when the active selection's response is unambiguous.
 * Timestamp isolation alone cannot prove that a payload belongs to a report.
 */
export function selectUnambiguousReportPayload(captures, selectionStartedAt) {
    if (!Number.isFinite(selectionStartedAt) || !Array.isArray(captures)) {
        return { ok: false, reason: "invalid_capture_context" };
    }
    const candidates = captures.filter(c =>
        c?.looksLikeCreditReport === true &&
        Number.isFinite(c.responseStartedAt) &&
        c.responseStartedAt >= selectionStartedAt
    );
    if (candidates.length === 0) return { ok: false, reason: "no_fresh_report_payload", candidates: 0 };
    // A second report-shaped response could belong to another request. Never
    // silently prefer the largest or the first without matching identity.
    if (candidates.length !== 1) {
        return { ok: false, reason: "ambiguous_report_payloads", candidates: candidates.length };
    }
    return { ok: true, report: candidates[0], candidates: 1 };
}
