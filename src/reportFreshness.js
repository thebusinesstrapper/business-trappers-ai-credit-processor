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

export const FRESHNESS_SCHEMA_VERSION = "BT-FRESHNESS-1.0";

export const ACTION = Object.freeze({
    USE_NEWEST: "USE_NEWEST",                 // The newest report on the selector is good. Extract it.
    ACQUISITION_REQUIRED: "ACQUISITION_REQUIRED", // Memory needs a newer report than exists.
    MANUAL_REVIEW: "MANUAL_REVIEW",           // Anything we cannot account for.
    NO_ACTION_REQUIRED: "NO_ACTION_REQUIRED", // Already processed this report.
});

// Option text that would CREATE a report rather than show an existing one.
// Selecting one of these is not a read — it is an irreversible action.
const FORBIDDEN_OPTION_LANGUAGE = /order|new\s*report|refresh|purchase|buy|update|generate|pull|request/i;

const DATE_PATTERNS = [
    /\b(\d{4})-(\d{2})-(\d{2})\b/,                                   // 2026-07-13
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,                             // 7/13/2026
    /\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{4})\b/,                 // July 13, 2026
];

const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse a report date from a selector option's visible text.
 * Returns an ISO date string, or null if it cannot be positively read.
 *
 * NULL IS NOT A FAILURE TO BE PAPERED OVER. An option whose date we cannot read
 * is an option we cannot rank, and an unrankable option means we cannot know
 * which report is newest.
 */
export function parseReportDate(text) {
    if (typeof text !== "string" || !text.trim()) return null;

    // ISO
    let m = text.match(DATE_PATTERNS[0]);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;

    // US numeric
    m = text.match(DATE_PATTERNS[1]);
    if (m) {
        return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
    }

    // Month name
    m = text.match(DATE_PATTERNS[2]);
    if (m) {
        const month = MONTHS[m[1].toLowerCase()];
        if (!month) return null;
        return `${m[3]}-${String(month).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
    }

    return null;
}

/**
 * An option is a REPORT we may select only if we can positively identify it as
 * an existing report date carrying no action language.
 *
 * Fail closed. We do not find out what an unrecognised option does by clicking
 * it — on this page, some controls spend money.
 */
export function isSelectableReportOption(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    if (FORBIDDEN_OPTION_LANGUAGE.test(text)) return false;

    return parseReportDate(text) !== null;
}

/**
 * Reduce a raw selector read into a ranked list of reports.
 *
 * @param {Array<{value: string, text: string, selected?: boolean}>} options
 */
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

    // Newest first.
    reports.sort((a, b) => b.reportDate.localeCompare(a.reportDate));

    return {
        reports,
        rejected,
        newest: reports[0] ?? null,
        count: reports.length,
    };
}

/**
 * Decide what to do, given what the selector shows and what memory knows.
 *
 * @param {object} selector    readSelector() output
 * @param {object} memory      AI Memory client state
 * @param {string} memory.last_report_date_used   ISO date of the last report ANALYZED
 * @param {boolean} memory.newer_report_required  Policy says a newer report is needed
 */
export function decideFreshness(selector, memory = {}) {
    const { newest, count, rejected } = selector;

    // ---- Nothing readable --------------------------------------------------
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

    // ---- Already analyzed the newest report --------------------------------
    if (lastUsed && newest.reportDate === lastUsed && !memory.newer_report_required) {
        return {
            action: ACTION.NO_ACTION_REQUIRED,
            reason: `The newest report (${newest.reportDate}) has already been analyzed. No new cycle is due.`,
            newestReportDate: newest.reportDate,
        };
    }

    // ---- Memory demands a newer report than the one on the page ------------
    //
    // The selector is authoritative for what EXISTS. If memory says we need
    // something newer than the newest thing that exists, a report must be
    // acquired — we cannot manufacture one by waiting.
    if (memory.newer_report_required && lastUsed && newest.reportDate <= lastUsed) {
        return {
            action: ACTION.ACQUISITION_REQUIRED,
            reason:
                `Memory requires a newer report, but the newest report on the selector ` +
                `(${newest.reportDate}) is not newer than the one already analyzed (${lastUsed}).`,
            newestReportDate: newest.reportDate,
            lastReportDateUsed: lastUsed,
        };
    }

    // ---- The newest report is new to us. Use it. ---------------------------
    return {
        action: ACTION.USE_NEWEST,
        reason: lastUsed
            ? `The selector's newest report (${newest.reportDate}) is newer than the last analyzed (${lastUsed}).`
            : `The selector's newest report is ${newest.reportDate}. No prior report has been analyzed.`,
        newestReportDate: newest.reportDate,
        lastReportDateUsed: lastUsed,
        select: { value: newest.value, text: newest.text },
    };
}

/**
 * After an acquisition, decide whether a NEWER report has actually appeared.
 *
 * This is the guard on the polling loop, and it is deliberately strict:
 * STRICTLY NEWER than the baseline. Not "different". Not "the count changed".
 *
 * A report that is merely different could be an older one the page re-sorted.
 * A count that changed could be an artefact of a partial render. Only a date
 * strictly greater than the baseline proves the new report has landed.
 *
 * @param {object} selector  a fresh readSelector() output
 * @param {string} baseline  the newest report date recorded BEFORE ordering
 */
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

/**
 * The timeout outcome.
 *
 * WE DO NOT FALL BACK TO THE OLD REPORT. That is the entire point of this
 * module. A newer report was expected and did not arrive; analyzing the old one
 * would produce a dispute package asserting facts that may already be stale —
 * and those assertions go out in the consumer's name.
 */
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
        analyzedOlderReport: false, // INVARIANT.
    };
}
