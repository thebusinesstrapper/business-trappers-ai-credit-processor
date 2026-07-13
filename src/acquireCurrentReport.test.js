/**
 * acquireCurrentReport.test.js
 * Run: node src/acquireCurrentReport.test.js
 *
 * Proves the architectural claims, rather than asserting them in a comment:
 *
 *   1. NO DATE-SPECIFIC BEHAVIOUR. The cycle only asks whether the required
 *      report exists. Shifting every date by years changes nothing.
 *   2. THE HAND-OFF IS A CAPABILITY GAP, NOT A STAGE. Injecting an authorized
 *      submitter completes the SAME cycle with zero operational touch and zero
 *      changes to the orchestrator.
 *   3. ON TIMEOUT WE NEVER ANALYZE THE OLDER REPORT.
 */

import { fulfillReportCycle, CYCLE_RESULT } from "./acquireCurrentReport.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(64)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

/**
 * A fake Credit Hero page. `reports` is the list of dates in the selector.
 * An injected submitter may push a new one onto it — exactly as a real order
 * would, appearing in the selector minutes later.
 */
function fakePage(reports, opts = {}) {
    const state = { reports: [...reports], selected: null, pollsBeforeArrival: opts.pollsBeforeArrival ?? 0, polls: 0 };

    const frame = {
        evaluate: async () => {
            state.polls++;

            // Simulate the delay before an ordered report lands in the selector.
            const visible =
                state.polls > state.pollsBeforeArrival
                    ? state.reports
                    : state.reports.filter((r) => !r.pending);

            return [{
                id: "reportSelect",
                name: "reportSelect",
                selectedValue: visible[0]?.value ?? "",
                options: visible.map((r) => ({ value: r.value, text: r.text, selected: false })),
            }];
        },
        locator: () => ({
            selectOption: async (value) => { state.selected = value; },
        }),
    };

    return {
        _state: state,
        frames: () => [frame],
        waitForTimeout: async () => {},
    };
}

const R = (value, text, pending = false) => ({ value, text, pending });

console.log("\n=== The required report already exists -> select and extract ===\n");

const page1 = fakePage([R("3", "July 13, 2026"), R("2", "June 11, 2026")]);
const r1 = await fulfillReportCycle(page1, { last_report_date_used: "2026-06-11" });

check("READY_FOR_EXTRACTION", r1.result, CYCLE_RESULT.READY_FOR_EXTRACTION);
check("selected the NEWEST", r1.selectedReport.text, "July 13, 2026");
check("no order placed", r1.orderSubmitted, false);
check("ready", r1.readyForExtraction, true);

console.log("\n=== NO DATE-SPECIFIC BEHAVIOUR ===\n");

// The exact same shape, years away. If any logic special-cased July 2026, this
// would break. It does not, because the cycle asks only: does it already exist?
const page2 = fakePage([R("9", "March 2, 2031"), R("8", "January 4, 2031")]);
const r2 = await fulfillReportCycle(page2, { last_report_date_used: "2031-01-04" });

check("2031 behaves identically", r2.result, CYCLE_RESULT.READY_FOR_EXTRACTION);
check("...selects the newest", r2.selectedReport.text, "March 2, 2031");

// Already analyzed the newest -> nothing due.
const page3 = fakePage([R("3", "July 13, 2026")]);
const r3 = await fulfillReportCycle(page3, { last_report_date_used: "2026-07-13" });
check("already analyzed newest -> NO_ACTION_REQUIRED", r3.result, CYCLE_RESULT.NO_ACTION_REQUIRED);

console.log("\n=== The hand-off is a CAPABILITY GAP, not a stage ===\n");

// Memory needs a newer report; none exists; NO submitter injected.
const page4 = fakePage([R("3", "July 13, 2026")]);
const r4 = await fulfillReportCycle(page4, {
    last_report_date_used: "2026-07-13",
    newer_report_required: true,
});

check("halts as CAPABILITY_UNAVAILABLE", r4.result, CYCLE_RESULT.CAPABILITY_UNAVAILABLE);
check("...NOT a 'manual step' result", r4.result === CYCLE_RESULT.MANUAL_REVIEW, false);
check("...orderSubmitted false (INVARIANT)", r4.orderSubmitted, false);
check("...not ready for extraction", r4.readyForExtraction, false);
check("...names the missing capability", r4.reason.includes("MISSING CAPABILITY"), true);
check("...hands back the baseline to resume", r4.resumeWith.baseline, "2026-07-13");

console.log("\n=== Inject an AUTHORIZED submitter: the SAME cycle goes zero-touch ===\n");

// The order lands in the selector after 2 polls — as Credit Hero describes.
const page5 = fakePage(
    [R("3", "July 13, 2026"), R("4", "August 14, 2026", true)],
    { pollsBeforeArrival: 2 }
);

// This stands in for the authorized Order Submitter. The orchestrator is
// UNCHANGED — the capability is injected, not coded around.
const authorizedSubmitter = async () => ({ ok: true, orderSubmitted: true });

const r5 = await fulfillReportCycle(
    page5,
    { last_report_date_used: "2026-07-13", newer_report_required: true },
    { orderSubmitter: authorizedSubmitter, intervalMs: 0, timeoutMs: 5000 }
);

check("cycle COMPLETES with no manual touch", r5.result, CYCLE_RESULT.READY_FOR_EXTRACTION);
check("...order was placed", r5.orderSubmitted, true);
check("...polled until the newer report appeared", r5.newestReportDate, "2026-08-14");
check("...selected the NEW report", r5.selectedReport.text, "August 14, 2026");
check("...ready for extraction", r5.readyForExtraction, true);
check("...baseline recorded before ordering", r5.baseline, "2026-07-13");

console.log("\n=== TIMEOUT: we STOP. We never analyze the older report. ===\n");

// The ordered report NEVER arrives.
const page6 = fakePage(
    [R("3", "July 13, 2026"), R("4", "August 14, 2026", true)],
    { pollsBeforeArrival: 9999 }
);

const r6 = await fulfillReportCycle(
    page6,
    { last_report_date_used: "2026-07-13", newer_report_required: true },
    { orderSubmitter: authorizedSubmitter, intervalMs: 0, timeoutMs: 60 }
);

check("timeout -> MANUAL_REVIEW", r6.result, CYCLE_RESULT.MANUAL_REVIEW);
check("...analyzedOlderReport FALSE (INVARIANT)", r6.analyzedOlderReport, false);
check("...readyForExtraction FALSE (INVARIANT)", r6.readyForExtraction, false);
check("...did NOT select the old report", page6._state.selected, null);
check("...order IS recorded as submitted", r6.orderSubmitted, true);

console.log("\n=== A failing submitter never yields a stale analysis ===\n");

const page7 = fakePage([R("3", "July 13, 2026")]);
const brokenSubmitter = async () => ({ ok: false, orderSubmitted: false, error: "free option not available" });

const r7 = await fulfillReportCycle(
    page7,
    { last_report_date_used: "2026-07-13", newer_report_required: true },
    { orderSubmitter: brokenSubmitter, intervalMs: 0, timeoutMs: 60 }
);

check("submitter refused -> MANUAL_REVIEW", r7.result, CYCLE_RESULT.MANUAL_REVIEW);
check("...not ready for extraction", r7.readyForExtraction, false);
check("...old report NOT selected", page7._state.selected, null);
check("...reason carries the submitter's refusal", r7.reason.includes("free option not available"), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
