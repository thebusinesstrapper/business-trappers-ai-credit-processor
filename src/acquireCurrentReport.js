/**
 * acquireCurrentReport.js
 *
 * THE REPORT FULFILLMENT CYCLE.
 *
 * ---------------------------------------------------------------------------
 * THE CYCLE IS THE ARCHITECTURE. THERE IS NO MANUAL STAGE IN IT.
 *
 *     Determine desired report state
 *              |
 *     Read newest report in the selector      <-- AUTHORITATIVE
 *              |
 *     Compare against the required state
 *              |
 *      +-------+-------+
 *      |               |
 *   not required    required
 *      |               |
 *      |        Report Acquisition Authority (preconditions, decision engine)
 *      |               |
 *      |        Authorized order
 *      |               |
 *      |        Poll the selector until a STRICTLY newer report appears
 *      |               |
 *      +-------+-------+
 *              |
 *      Select the newest report
 *              |
 *      JSON extraction
 *
 * NO DATE-SPECIFIC BEHAVIOUR. This module never knows what today is, never
 * knows when a free report becomes available, and never special-cases a report.
 * It asks one question: DOES THE REQUIRED REPORT ALREADY EXIST? Everything else
 * follows from the answer.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER SUBMITTER IS AN INJECTED CAPABILITY, NOT A MISSING STAGE.
 *
 * Version 1 has no authorized Order Submitter (Report Acquisition Authority
 * §9). That is a MISSING CAPABILITY — not a designed human step.
 *
 * The distinction is load-bearing. If the hand-off were modelled as a STAGE, it
 * would become permanent: code, tests, memory states and operator habits would
 * accrete around it, and "zero Business Trappers operational touch" would quietly
 * become "zero touch, except this bit". Ossification by convenience.
 *
 * So the cycle below runs END TO END. `orderSubmitter` is a parameter. When it
 * is absent, the cycle halts exactly where it would otherwise have ACTED, and
 * says so — a capability gap, reported. When it is authorized and injected, the
 * SAME cycle completes with no edit to this file and no manual intervention.
 *
 * Authorizing the submitter is a wiring change. It is not a rewrite, and it is
 * deliberately not a new code path.
 * ---------------------------------------------------------------------------
 */

import { readReportSelector, selectReport } from "./reportSelector.js";
import { decideFreshness, hasNewerReport, timeoutOutcome, ACTION } from "./reportFreshness.js";

// Credit Hero support: a newly ordered report normally appears within minutes.
export const POLL_TIMEOUT_MS = 5 * 60 * 1000;
export const POLL_INTERVAL_MS = 10 * 1000;

export const CYCLE_RESULT = Object.freeze({
    READY_FOR_EXTRACTION: "READY_FOR_EXTRACTION",
    NO_ACTION_REQUIRED: "NO_ACTION_REQUIRED",
    MANUAL_REVIEW: "MANUAL_REVIEW",
    CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE", // the submitter is not authorized
});

/**
 * Run the full fulfillment cycle.
 *
 * @param {import('playwright').Page} page  the Credit Hero View Report page
 * @param {object}   memory                 AI Memory client state
 * @param {object}   deps
 * @param {Function} [deps.orderSubmitter]  ASYNC (page, memory) -> { ok, orderSubmitted, error }
 *                                          THE ONLY MODULE PERMITTED TO ORDER.
 *                                          Absent in Version 1 — not authorized.
 * @param {number}   [deps.timeoutMs]
 * @param {number}   [deps.intervalMs]
 */
export async function fulfillReportCycle(page, memory = {}, deps = {}) {

    const { orderSubmitter = null, timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = deps;

    // ---- 1. Read the selector. It is authoritative. -------------------------
    //
    // Not elapsed time. Not CRC's "new report available in N days". Not the
    // availability dates printed on the order page. Those are secondary signals
    // that can, and do, disagree with what actually exists.
    console.log("Reading the Credit Hero report selector...");

    const read = await readReportSelector(page);

    if (!read.ok) {
        return {
            result: CYCLE_RESULT.MANUAL_REVIEW,
            reason: read.error,
            readyForExtraction: false,
            orderSubmitted: false,
        };
    }

    const selector = read.selector;
    const baseline = selector.newest.reportDate;

    console.log(`Reports on selector: ${selector.reports.map((r) => r.reportDate).join(", ")}`);
    console.log(`Newest: ${baseline}`);

    // ---- 2. Compare against the required state ------------------------------
    const decision = decideFreshness(selector, memory);

    console.log(`Freshness: ${decision.action} — ${decision.reason}`);

    if (decision.action === ACTION.NO_ACTION_REQUIRED) {
        return {
            result: CYCLE_RESULT.NO_ACTION_REQUIRED,
            reason: decision.reason,
            newestReportDate: decision.newestReportDate,
            readyForExtraction: false,
            orderSubmitted: false,
        };
    }

    if (decision.action === ACTION.MANUAL_REVIEW) {
        return {
            result: CYCLE_RESULT.MANUAL_REVIEW,
            reason: decision.reason,
            rejectedOptions: decision.rejectedOptions,
            readyForExtraction: false,
            orderSubmitted: false,
        };
    }

    // ---- 3a. The required report already exists. Select it and go. ----------
    if (decision.action === ACTION.USE_NEWEST) {
        return selectAndFinish(page, decision.select, {
            reason: decision.reason,
            newestReportDate: decision.newestReportDate,
            orderSubmitted: false,
        });
    }

    // ---- 3b. Acquisition is required ---------------------------------------
    //
    // Everything below is the acquisition branch. It is ONE path. The absence of
    // an authorized submitter halts it at the point of action — it does not
    // divert it into a different, human-shaped workflow.
    if (decision.action !== ACTION.ACQUISITION_REQUIRED) {
        return {
            result: CYCLE_RESULT.MANUAL_REVIEW,
            reason: `Unrecognised freshness action: ${decision.action}.`,
            readyForExtraction: false,
            orderSubmitted: false,
        };
    }

    if (!orderSubmitter) {
        // A CAPABILITY GAP, reported. Not a stage in the design.
        return {
            result: CYCLE_RESULT.CAPABILITY_UNAVAILABLE,
            reason:
                `A newer report is required (newest available: ${baseline}; last analyzed: ` +
                `${decision.lastReportDateUsed}). The cycle halts here because no authorized Order ` +
                `Submitter is injected. Report Acquisition Authority §9 reserves that module for a ` +
                `separate, explicit authorization. This is a MISSING CAPABILITY, not a manual step in ` +
                `the intended architecture — once the submitter is authorized and injected, this same ` +
                `cycle completes with no operational touch and no change to this file.`,
            baseline,
            lastReportDateUsed: decision.lastReportDateUsed,
            readyForExtraction: false,
            orderSubmitted: false, // INVARIANT: nothing on this path can set it true.
            resumeWith: { baseline },
        };
    }

    // ---- 4. Authorized order ------------------------------------------------
    //
    // The submitter is the ONLY module permitted to act. It carries the Eight
    // Preconditions, positive identification of "free", positive exclusion of
    // "paid", and the idempotency intent record. This orchestrator does not
    // second-guess it and does not pick an option for it.
    console.log(`Acquisition required. Baseline: ${baseline}. Invoking the authorized Order Submitter...`);

    const submission = await orderSubmitter(page, memory);

    if (!submission?.ok) {
        return {
            result: CYCLE_RESULT.MANUAL_REVIEW,
            reason: `Order Submitter did not complete: ${submission?.error ?? "no reason given"}.`,
            baseline,
            readyForExtraction: false,
            orderSubmitted: !!submission?.orderSubmitted,
        };
    }

    // ---- 5. Poll until a STRICTLY newer report appears -----------------------
    const polled = await awaitNewerReport(page, baseline, { timeoutMs, intervalMs });

    return {
        ...polled,
        orderSubmitted: true,
    };
}

/** Select a report and hand off to extraction. */
async function selectAndFinish(page, target, meta) {
    const selected = await selectReport(page, target);

    if (!selected.ok) {
        return {
            result: CYCLE_RESULT.MANUAL_REVIEW,
            reason: selected.error,
            readyForExtraction: false,
            orderSubmitted: meta.orderSubmitted ?? false,
        };
    }

    return {
        result: CYCLE_RESULT.READY_FOR_EXTRACTION,
        reason: meta.reason,
        newestReportDate: meta.newestReportDate,
        selectedReport: selected.selected,
        readyForExtraction: true,
        orderSubmitted: meta.orderSubmitted ?? false,
    };
}

/**
 * Poll the selector until a report STRICTLY NEWER than `baseline` appears.
 *
 * ---------------------------------------------------------------------------
 * ON TIMEOUT WE STOP. WE DO NOT ANALYZE THE OLD REPORT.
 *
 * The tempting behaviour — "we waited, nothing came, use what we have" —
 * produces a dispute package built on a report that may already be superseded.
 * Every letter would then assert, in the consumer's voice and over their
 * signature, facts that may already have been corrected: an account deleted last
 * week, disputed as current.
 *
 * A stalled cycle costs one round. A stale-report dispute puts a false statement
 * in the client's name.
 * ---------------------------------------------------------------------------
 */
export async function awaitNewerReport(page, baseline, options = {}) {

    const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;

    if (!baseline) {
        return {
            result: CYCLE_RESULT.MANUAL_REVIEW,
            reason:
                "No baseline report date was supplied. Without it we cannot prove a report is NEW " +
                "rather than one that was always present.",
            readyForExtraction: false,
        };
    }

    console.log(`Polling for a report newer than ${baseline}...`);

    const started = Date.now();
    let attempts = 0;

    while (Date.now() - started < timeoutMs) {
        attempts++;

        const read = await readReportSelector(page);

        if (read.ok) {
            const check = hasNewerReport(read.selector, baseline);

            if (check.appeared) {
                console.log(`Newer report appeared: ${check.reportDate} (after ${attempts} checks)`);

                const finished = await selectAndFinish(page, check.select, {
                    reason: `A newer report (${check.reportDate}) appeared and was selected.`,
                    newestReportDate: check.reportDate,
                });

                return { ...finished, baseline, waitedMs: Date.now() - started, attempts };
            }
        }

        await page.waitForTimeout(intervalMs);
    }

    const outcome = timeoutOutcome(baseline, Date.now() - started);

    console.error(outcome.reason);

    return {
        result: CYCLE_RESULT.MANUAL_REVIEW,
        reason: outcome.reason,
        baseline,
        waitedMs: outcome.waitedMs,
        attempts,
        analyzedOlderReport: false, // INVARIANT.
        readyForExtraction: false,  // INVARIANT. Extraction never proceeds from here.
    };
}
