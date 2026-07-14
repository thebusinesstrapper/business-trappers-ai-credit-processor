/**
 * milestone6.test.js
 * Run: node src/milestone6.test.js
 *
 * ===========================================================================
 * PRE-FLIGHT. This exists because of a bug that would have wasted every run.
 *
 * milestone6.js called:
 *
 *     decideFreshness({ selector, memory })      <- ONE object
 *
 * but the real signature is:
 *
 *     decideFreshness(selector, memory)          <- TWO positional args
 *
 * So `newest` and `count` came back undefined, and the function did exactly what
 * it was designed to do with unreadable input: it FAILED CLOSED to MANUAL_REVIEW.
 *
 * That is the nasty part. The run would have halted on EVERY client, EVERY time,
 * with a reason that reads like a legitimate, careful refusal:
 *
 *     "No report could be positively identified in the report selector."
 *
 * A fail-closed default is the right behaviour on bad input — and it is also a
 * perfect disguise for a caller passing bad input. Nothing would have looked
 * broken. We would have concluded that Credit Hero's selector was unreadable and
 * gone hunting through the DOM for a problem that was never there.
 *
 * These tests assert the CHAIN REACHES CAPTURE, using the real module shapes
 * rather than shapes I assumed.
 * ===========================================================================
 */

import { readSelector, decideFreshness, ACTION } from "./reportFreshness.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(60)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

// The raw <option> list, as readReportSelector() scrapes it from the page.
const rawOptions = [
    { value: "r3", text: "07/13/2026", selected: true },
    { value: "r2", text: "05/28/2026", selected: false },
    { value: "r1", text: "03/14/2026", selected: false },
];

const parsed = readSelector(rawOptions);

console.log("\n=== THE SELECTOR PARSES ===\n");

check("3 reports positively identified", parsed.count, 3);
check("newest is July 13, 2026", parsed.newest.reportDate, "2026-07-13");
check("newest carries a selectable value", parsed.newest.value, "r3");
check("nothing wrongly rejected", parsed.rejected.length, 0);

console.log("\n=== CLIENT 15: FIRST RUN, NO AI MEMORY ===\n");

// Elizabeth has no AI Memory record. This is the exact case the real run hits,
// and the case the argument bug would have silently broken.
const firstRun = decideFreshness(parsed, {});

check("action is USE_NEWEST", firstRun.action, ACTION.USE_NEWEST);
check("...selects the July 13 report", firstRun.newestReportDate, "2026-07-13");
check("...supplies a target for selectReport()", firstRun.select?.value, "r3");
check("REACHES CAPTURE", firstRun.action === ACTION.USE_NEWEST && !!firstRun.select, true);

console.log("\n--- The bug, reproduced ---");

// The old call. Reproduced so the failure mode is on the record, not just in a
// comment.
const broken = decideFreshness({ selector: parsed, memory: {} });

check("passing ONE object -> MANUAL_REVIEW", broken.action, ACTION.MANUAL_REVIEW);
check("...and it looks like a legitimate refusal", /do not guess which report is current/i.test(broken.reason), true);
check("...which is why nothing would have looked broken", !!broken.reason, true);

console.log("\n=== OTHER MEMORY STATES ===\n");

// Already analyzed July 13. This is a decision about whether a DISPUTE CYCLE is
// due — not about whether we may READ the report. Capture proceeds regardless.
const seen = decideFreshness(parsed, { last_report_date_used: "2026-07-13" });
check("already-analyzed -> NO_ACTION_REQUIRED", seen.action, ACTION.NO_ACTION_REQUIRED);

// A newer report exists than the one memory last used.
const stale = decideFreshness(parsed, { last_report_date_used: "2026-05-28" });
check("newer report exists -> USE_NEWEST", stale.action, ACTION.USE_NEWEST);
check("...picks July 13, not May 28", stale.newestReportDate, "2026-07-13");

// Memory demands something newer than anything that exists. We cannot manufacture
// a report by waiting, and the Order Submitter is not authorized.
const needsNewer = decideFreshness(parsed, {
    last_report_date_used: "2026-07-13",
    newer_report_required: true,
});
check("memory needs newer than newest -> ACQUISITION_REQUIRED", needsNewer.action, ACTION.ACQUISITION_REQUIRED);

console.log("\n=== AN ORDER CONTROL IS NEVER MISTAKEN FOR A REPORT ===\n");

// Between 2026-07-18 and 2026-08-10 the ONLY enabled option on the order page is
// a $18.95 PAID report. Anything that treats an order control as a report date is
// one step from buying it.
const withOrderControl = readSelector([
    { value: "r3", text: "07/13/2026", selected: true },
    { value: "order", text: "Order new report 7/18/2026", selected: false },
]);

check("only 1 real report identified", withOrderControl.count, 1);
check("...the order control is REJECTED", withOrderControl.rejected.length, 1);
check("...despite carrying a parseable date", /order new report/i.test(withOrderControl.rejected[0].text), true);
check("newest is still July 13", withOrderControl.newest.reportDate, "2026-07-13");

console.log("\n=== THE NEW-TAB HANDOFF ===\n");

const { readFileSync: rf } = await import("fs");
const m6 = rf(new URL("./milestone6.js", import.meta.url), "utf-8");

// BUG 1 — THE CRASH. openCreditHero(page, context) takes TWO arguments.
// milestone6 passed one, so `context` was undefined and context.waitForEvent()
// threw, immediately after the dashboard was restored.
check("openCreditHero receives the context", /openCreditHero\(page,\s*context\)/.test(m6), true);
check("...and the context is taken from the session", /const context = session\.context/.test(m6), true);

// BUG 2 — THE STALE HANDLE. openCreditHero returns the page it ACTUALLY landed
// on. CRC opens CreditHero in a NEW TAB, so `page` still points at the CRC
// dashboard. Every downstream read would have queried the wrong tab and failed in
// a way that looks exactly like Credit Hero being broken.
check("adopts the page openCreditHero landed on", /const chPage = creditHero\.page/.test(m6), true);
check("...selector reads the CreditHero page", /readReportSelector\(chPage\)/.test(m6), true);
check("...selection acts on the CreditHero page", /selectReport\(chPage,/.test(m6), true);
check("...activation verifies the CreditHero page", /verifyActiveReport\(chPage,/.test(m6), true);
check("no stale dashboard handle left downstream", /readReportSelector\(page\)|selectReport\(page,|verifyActiveReport\(page,/.test(m6), false);

// BUG 3 — THE SILENT ONE. A response listener bound to the CRC dashboard page
// would sit on the wrong tab and capture NOTHING. The run would report
// "no report payload captured" with no hint that the listener had been watching
// an idle page the whole time.
console.log("\n--- The capture listener must not be bound to the wrong tab ---");

check("capture listens on the CONTEXT, not a page", /function capturePayloads\(context\)/.test(m6), true);
check("...context.on(\"response\")", /context\.on\("response"/.test(m6), true);
check("...NOT page.on(\"response\")", /page\.on\("response"/.test(m6), false);
check("...attached BEFORE the CreditHero click", m6.indexOf("capturePayloads(context)") < m6.indexOf("openCreditHero(page, context)"), true);

console.log("\n=== NOTHING IS EXTRACTED OR NORMALIZED HERE ===\n");

const { readFileSync } = await import("fs");
const src = readFileSync(new URL("./milestone6.js", import.meta.url), "utf-8");

check("milestone6 declares normalized: false", /normalized: false/.test(src), true);
check("...reconciled: false", /reconciled: false/.test(src), true);
check("...lettersGenerated: 0", /lettersGenerated: 0/.test(src), true);
check("does NOT import a normalizer", /reportNormalize|itemKey/.test(src), false);

// The report page carries controls that order reports and reactivate monitoring.
check("no click on any report-page control", /\.click\(\)/.test(src), false);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
