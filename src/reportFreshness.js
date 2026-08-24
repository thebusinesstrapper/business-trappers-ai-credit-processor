/**
 * reportFreshness.js
 *
 * PURE. No browser. No Playwright. Fully unit-testable.
 *
 * ---------------------------------------------------------------------------
 * THE REPORT SELECTOR IS THE AUTHORITATIVE SOURCE OF REPORT FRESHNESS.
 *
 * Confirmed by Credit Hero support and live testing:
 *   1. The View Report page always displays the NEWEST available report.
 *   2. A newly ordered report appears in the report selector within minutes.
 *
 * The processor therefore no longer INFERS readiness from anything else — not
 * from CRC's "new report available in N days", not from the order page's
 * availability dates, not from elapsed time. Those are all secondary signals
 * that can disagree with reality.
 *
 * It READS the selector. The selector is the truth.
 *
 * ---------------------------------------------------------------------------
 * NEVER ANALYZE AN OLDER REPORT WHEN A NEWER ONE IS EXPECTED.
 *
 * This is the rule the whole module exists to enforce, and the failure it
 * prevents is silent: we order a report, the new one is slow to appear, we time
 * out, and we quietly analyze the OLD one instead. Every letter then asserts
 * facts that may already have been corrected — false statements in the
 * consumer's voice, over their signature.
 *
 * A stalled cycle costs one round. A stale-report dispute costs credibility with
 * the bureau and asserts something untrue. We take the stall.
 * ---------------------------------------------------------------------------
 */

export const FRESHNESS_SCHEMA_VERSION = "BT-FRESHNESS-1.1";

export const ACTION = Object.freeze({
    USE_NEWEST: "USE_NEWEST",
    ACQUISITION_REQUIRED: "ACQUISITION_REQUIRED",
    MANUAL_REVIEW: "MANUAL_REVIEW",
    NO_ACTION_REQUIRED: "NO_ACTION_REQUIRED",
});

const FORBIDDEN_OPTION_LANGUAGE = /order|new\s*report|refresh|purchase|buy|update|generate|pull|request/i;

const DATE_PATTERNS = [
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{4})\b/,
];

const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function parseReportDate(text) {
    if (typeof text !== "string" || !text.trim()) return null;

    let m = text.match(DATE_PATTERNS[0]);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;

    m = text.match(DATE_PATTERNS[1]);
    if (m) {
        return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
    }

    m = text.match(DATE_PATTERNS[2]);
    if (m) {
        const month = MONTHS[m[1].toLowerCase()];
        if (!month) return null;
        return `${m[3]}-${String(month).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
    }

    return null;
}

export function isSelectableReportOption(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    if (FORBIDDEN_OPTION_LANGUAGE.test(text)) return false;
    return parseReportDate(text) !== null;
}

export function readSelector(options = []) {
    const reports = [];
    const rejected = [];

    for (const option of options) {
        if (!isSelectableReportOption(option.text)) {
            rejected.push({ text: option.text, reason: "Not positively identifiable as an existing report date." });
            continue;
        }

        reports.push({
            value: option.value,
            text: option.text,
            reportDate: parseReportDate(option.text),
            selected: !!option.selected,
        });
    }

    reports.sort((a, b) => b.reportDate.localeCompare(a.reportDate));

    return {
        reports,
        rejected,
        newest: reports[0] ?? null,
        count: reports.length,
    };
}

/**
 * Permanent future-round freshness rule:
 * once a prior report date is known, the next cycle may use ONLY a strictly
 * newer report. Equality is not "no action" for production; it means a new
 * report must be acquired before another dispute package can be generated.
 */
export function decideFreshness(selector, memory = {}) {
    const { newest, count, rejected } = selector;

    if (!newest || count === 0) {
        return {
            action: ACTION.MANUAL_REVIEW,
            reason:
                "No report could be positively identified in the report selector. We do not guess " +
                "which report is current, and we do not fall back to whatever the page happens to " +
                "be showing.",
            rejectedOptions: rejected,
        };
    }

    const lastUsed = memory.last_report_date_used ?? null;

    if (lastUsed && newest.reportDate <= lastUsed) {
        return {
            action: ACTION.ACQUISITION_REQUIRED,
            reason:
                `A fresh report is required for the next dispute cycle. The newest report on the selector ` +
                `(${newest.reportDate}) is not strictly newer than the report already used (${lastUsed}).`,
            newestReportDate: newest.reportDate,
            lastReportDateUsed: lastUsed,
        };
    }

    return {
        action: ACTION.USE_NEWEST,
        reason: lastUsed
            ? `The selector's newest report (${newest.reportDate}) is strictly newer than the last analyzed (${lastUsed}).`
            : `The selector's newest report is ${newest.reportDate}. No prior report has been recorded yet.`,
        newestReportDate: newest.reportDate,
        lastReportDateUsed: lastUsed,
        select: { value: newest.value, text: newest.text },
    };
}

export function hasNewerReport(selector, baseline) {
    if (!selector.newest) {
        return { appeared: false, reason: "No readable report on the selector." };
    }

    if (!baseline) {
        return {
            appeared: false,
            reason:
                "No baseline report date was recorded before ordering. Without it we cannot prove a " +
                "report is NEW rather than one that was always there — so we cannot proceed.",
        };
    }

    if (selector.newest.reportDate > baseline) {
        return {
            appeared: true,
            reportDate: selector.newest.reportDate,
            baseline,
            select: { value: selector.newest.value, text: selector.newest.text },
        };
    }

    return {
        appeared: false,
        reason: `Newest report is ${selector.newest.reportDate}; baseline was ${baseline}. Not newer.`,
        newestReportDate: selector.newest.reportDate,
        baseline,
    };
}

export function timeoutOutcome(baseline, waitedMs) {
    return {
        action: ACTION.MANUAL_REVIEW,
        reason:
            `A newer report was expected but did not appear in the report selector within ` +
            `${Math.round(waitedMs / 1000)}s. The newest report remains ${baseline}. ` +
            `Processing STOPS. The processor does not analyze an older report when a newer one was ` +
            `expected — that would assert facts in the consumer's voice that may already be stale.`,
        baseline,
        waitedMs,
        analyzedOlderReport: false,
    };
}
