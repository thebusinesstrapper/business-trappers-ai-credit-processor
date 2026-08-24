/**
 * reportFreshness.test.js
 * Run: node src/reportFreshness.test.js
 *
 * The rule under test: NEVER ANALYZE AN OLDER REPORT WHEN A NEWER ONE IS
 * EXPECTED. A stale-report dispute asserts facts in the consumer's voice that
 * may already have been corrected.
 */

import {
    parseReportDate,
    isSelectableReportOption,
    readSelector,
    decideFreshness,
    hasNewerReport,
    timeoutOutcome,
    ACTION,
} from "./reportFreshness.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(62)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

console.log("\n=== Parsing report dates ===\n");

check("July 13, 2026", parseReportDate("July 13, 2026"), "2026-07-13");
check("7/13/2026", parseReportDate("7/13/2026"), "2026-07-13");
check("2026-07-13", parseReportDate("2026-07-13"), "2026-07-13");
check("unparseable -> null", parseReportDate("Select a report"), null);

console.log("\n=== Only existing reports are selectable ===\n");

check("'July 13, 2026'", isSelectableReportOption("July 13, 2026"), true);
check("'Order New Report'", isSelectableReportOption("Order New Report"), false);
check("'Refresh Report'", isSelectableReportOption("Refresh Report"), false);
check("'Purchase 3-Bureau Report $18.95'", isSelectableReportOption("Purchase 3-Bureau Report $18.95"), false);
check("'Order new report 7/18/2026' (date + trap)", isSelectableReportOption("Order new report 7/18/2026"), false);
check("'Select...'", isSelectableReportOption("Select..."), false);

console.log("\n=== The selector is authoritative ===\n");

const selector = readSelector([
    { value: "3", text: "July 13, 2026", selected: true },
    { value: "2", text: "June 11, 2026" },
    { value: "1", text: "May 10, 2026" },
    { value: "x", text: "Order New Report" },
]);

check("3 reports read", selector.count, 3);
check("newest is July 13", selector.newest.reportDate, "2026-07-13");
check("order option REJECTED", selector.rejected.length, 1);
check("...and never ranked as newest", selector.newest.text.includes("Order"), false);

console.log("\n=== Freshness decisions ===\n");

const first = decideFreshness(selector, {});
check("no prior report -> USE_NEWEST", first.action, ACTION.USE_NEWEST);
check("...selects July 13", first.select.text, "July 13, 2026");

const newer = decideFreshness(selector, { last_report_date_used: "2026-06-11" });
check("newer than last used -> USE_NEWEST", newer.action, ACTION.USE_NEWEST);
check("...selects the NEWEST, not the last used", newer.newestReportDate, "2026-07-13");

const same = decideFreshness(selector, { last_report_date_used: "2026-07-13" });
check("same report cannot be reused -> ACQUISITION_REQUIRED", same.action, ACTION.ACQUISITION_REQUIRED);

const stale = decideFreshness(selector, {
    last_report_date_used: "2026-07-13",
    newer_report_required: true,
});
check("newer required but none exists -> ACQUISITION_REQUIRED", stale.action, ACTION.ACQUISITION_REQUIRED);

const olderThanUsed = decideFreshness(selector, { last_report_date_used: "2026-08-01" });
check("selector older than last used -> ACQUISITION_REQUIRED", olderThanUsed.action, ACTION.ACQUISITION_REQUIRED);

const empty = decideFreshness(readSelector([{ value: "x", text: "Order New Report" }]), {});
check("no readable report -> MANUAL_REVIEW", empty.action, ACTION.MANUAL_REVIEW);

console.log("\n=== Polling: STRICTLY newer, never merely 'different' ===\n");

const before = readSelector([{ value: "2", text: "June 11, 2026" }]);
const after = readSelector([
    { value: "3", text: "July 13, 2026" },
    { value: "2", text: "June 11, 2026" },
]);

check("no change -> not appeared", hasNewerReport(before, "2026-06-11").appeared, false);
check("newer appeared", hasNewerReport(after, "2026-06-11").appeared, true);
check("...and it is the new one", hasNewerReport(after, "2026-06-11").reportDate, "2026-07-13");

const older = readSelector([
    { value: "1", text: "May 10, 2026" },
    { value: "2", text: "June 11, 2026" },
]);
check("an OLDER report appearing is NOT 'newer'", hasNewerReport(older, "2026-06-11").appeared, false);

const rerendered = readSelector([{ value: "99", text: "June 11, 2026" }]);
check("same date, new option value -> NOT newer", hasNewerReport(rerendered, "2026-06-11").appeared, false);

check("no baseline -> cannot prove novelty", hasNewerReport(after, null).appeared, false);

console.log("\n=== TIMEOUT: we STOP. We do NOT use the old report. ===\n");

const timeout = timeoutOutcome("2026-06-11", 300000);

check("timeout -> MANUAL_REVIEW", timeout.action, ACTION.MANUAL_REVIEW);
check("...analyzedOlderReport is FALSE (invariant)", timeout.analyzedOlderReport, false);
check("...baseline preserved", timeout.baseline, "2026-06-11");
check("...reason states the danger", timeout.reason.includes("stale"), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);

// Later-round legacy memory with no baseline must acquire; never reuse existing.
{
    const legacySelector = readSelector([{ value: "x", text: "08/24/2026" }]);
    const legacyResult = decideFreshness(legacySelector, { last_report_date_used: null, newer_report_required: true });
    check("later round with no baseline -> ACQUISITION_REQUIRED", legacyResult.action, ACTION.ACQUISITION_REQUIRED);
}
