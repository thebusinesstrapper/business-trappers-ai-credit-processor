/**
 * acquireCurrentReport.js
 *
 * THE ACQUISITION WORKFLOW.
 *
 *   Open View Report
 *        |
 *   Read report selector  <-- AUTHORITATIVE for report freshness
 *        |
 *   Record the newest report date (BASELINE)
 *        |
 *   Is a newer report required?
 *      /                    \
 *    No                     Yes
 *     |                      |
 *     |              Acquisition Decision Engine (PURE, already frozen)
 *     |                      |
 *     |              submit_free_report? --> NOT AUTHORIZED IN V1 (see below)
 *     |                      |
 *     |              [order placed by a HUMAN]
 *     |                      |
 *     |              Return to View Report
 *     |                      |
 *     |              POLL the selector until a STRICTLY NEWER report appears
 *     |                      |
 *     |              Timeout? --> MANUAL REVIEW. Never analyze the old report.
 *      \                    /
 *       Select the newest report
 *                |
 *       Begin JSON extraction
 *
 * ---------------------------------------------------------------------------
 * THE ORDER SUBMITTER IS NOT BUILT AND IS NOT CALLED.
 *
 * Report Acquisition Authority v1.0 §9 is binding:
 *
 *   "The Order Submitter is not authorized by this document... Building the
 *    module that actually submits requires a separate, explicit go-ahead once
 *    the decision table is frozen and reviewed."
 *
 * This orchestrator therefore RECOMMENDS acquisition and STOPS. It routes to a
 * human, who places the order. It then resumes and polls.
 *
 * ---------------------------------------------------------------------------
 * !! THE PAID-ONLY WINDOW: 2026-07-18 THROUGH 2026-08-10 !!
 *
 * The order page discovery spike (2026-07-12) found exactly two controls:
 *
 *   productBuyNew_01  FREE 3-Bureau Report   (Available 8/10/2026)
 *   productBuyNew_03  $18.95                 (Available 7/18/2026)
 *
 * Between 18 July and 10 August, the ONLY ENABLED option is the $18.95 PAID
 * report. Any logic that reaches for "whatever is available" during that window
 * BUYS IT.
 *
 * The Acquisition Decision Engine hard-requires productBuyNew_01 specifically,
 * at cost 0, enabled. It will return free_report_not_yet_available throughout
 * that window. This orchestrator never overrides it, and never selects an option
 * the engine did not name.
 * ---------------------------------------------------------------------------
 */

import { readReportSelector, selectReport } from "./reportSelector.js";
import { decideFreshness, hasNewerReport, timeoutOutcome, ACTION } from "./reportFreshness.js";

// Credit Hero support: a newly ordered report normally appears within a couple
// of minutes. Five minutes gives generous headroom without stalling a run.
export const POLL_TIMEOUT_MS = 5 * 60 * 1000;
export const POLL_INTERVAL_MS = 10 * 1000;

/**
 * Read the selector, decide, and select the report to analyze.
 *
 * @param {import('playwright').Page} page   the View Report page
 * @param {object} memory                    AI Memory client state
 */
export async function acquireCurrentReport(page, memory = {}) {

    console.log("Reading the Credit Hero report selector...");

    const read = await readReportSelector(page);

    if (!read.ok) {
        return {
            ok: false,
            action: ACTION.MANUAL_REVIEW,
            reason: read.error,
            readyForExtraction: false,
        };
    }

    const selector = read.selector;

    console.log(`Reports on selector: ${selector.reports.map((r) => r.reportDate).join(", ")}`);
    console.log(`Newest: ${selector.newest.reportDate}`);

    const decision = decideFreshness(selector, memory);

    console.log(`Freshness decision: ${decision.action} — ${decision.reason}`);

    // ---- Nothing to do -----------------------------------------------------
    if (decision.action === ACTION.NO_ACTION_REQUIRED) {
        return {
            ok: true,
            action: decision.action,
            reason: decision.reason,
            newestReportDate: decision.newestReportDate,
            readyForExtraction: false,
        };
    }

    // ---- Cannot account for the page ---------------------------------------
    if (decision.action === ACTION.MANUAL_REVIEW) {
        return {
            ok: false,
            action: decision.action,
            reason: decision.reason,
            rejectedOptions: decision.rejectedOptions,
            readyForExtraction: false,
        };
    }

    // ---- A newer report must be acquired -----------------------------------
    //
    // We STOP here. This orchestrator does not submit an order — that module is
    // not authorized (Report Acquisition Authority §9). It reports what is needed
    // and hands the baseline to whoever resumes the run.
    if (decision.action === ACTION.ACQUISITION_REQUIRED) {
        return {
            ok: false,
            action: decision.action,
            reason: decision.reason,
            baseline: decision.newestReportDate,
            lastReportDateUsed: decision.lastReportDateUsed,
            readyForExtraction: false,

            orderSubmitted: false, // INVARIANT. Nothing here can set this true.
            note:
                "Acquisition is required, but the Order Submitter is not authorized in Version 1 " +
                "(Report Acquisition Authority v1.0 §9). A human places the order. Call " +
                "awaitNewerReport() with this baseline afterwards to resume.",
        };
    }

    // ---- Use the newest report ---------------------------------------------
    const selected = await selectReport(page, decision.select);

    if (!selected.ok) {
        return {
            ok: false,
            action: ACTION.MANUAL_REVIEW,
            reason: selected.error,
            readyForExtraction: false,
        };
    }

    return {
        ok: true,
        action: ACTION.USE_NEWEST,
        reason: decision.reason,
        newestReportDate: decision.newestReportDate,
        selectedReport: selected.selected,
        readyForExtraction: true,
    };
}

/**
 * Poll the report selector until a STRICTLY NEWER report than `baseline` appears.
 *
 * Called after an order has been placed (by a human, in Version 1).
 *
 * ---------------------------------------------------------------------------
 * ON TIMEOUT WE STOP. WE DO NOT ANALYZE THE OLD REPORT.
 *
 * This is the single most important line in the module. The tempting behaviour
 * — "we waited, nothing came, let's just use what we have" — produces a dispute
 * package built on a report that may already be superseded. Every letter then
 * asserts, in the consumer's voice and over their signature, facts that may have
 * already been corrected. An account deleted last week would be disputed as
 * current.
 *
 * A stalled cycle costs one round. A stale-report dispute costs the client's
 * credibility with the bureau and puts a false statement in their name.
 * ---------------------------------------------------------------------------
 *
 * @param {import('playwright').Page} page
 * @param {string} baseline   newest report date recorded BEFORE the order
 */
export async function awaitNewerReport(page, baseline, options = {}) {

    const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;

    if (!baseline) {
        return {
            ok: false,
            action: ACTION.MANUAL_REVIEW,
            reason:
                "No baseline report date was supplied. Without it we cannot prove a report is NEW " +
                "rather than one that was always present, so we cannot safely proceed.",
            readyForExtraction: false,
        };
    }

    console.log(`Polling the report selector for a report newer than ${baseline}...`);

    const started = Date.now();
    let attempts = 0;

    while (Date.now() - started < timeoutMs) {
        attempts++;

        const read = await readReportSelector(page);

        if (read.ok) {
            const check = hasNewerReport(read.selector, baseline);

            if (check.appeared) {
                console.log(`Newer report appeared: ${check.reportDate} (after ${attempts} checks)`);

                const selected = await selectReport(page, check.select);

                if (!selected.ok) {
                    return {
                        ok: false,
                        action: ACTION.MANUAL_REVIEW,
                        reason: selected.error,
                        readyForExtraction: false,
                    };
                }

                return {
                    ok: true,
                    action: ACTION.USE_NEWEST,
                    reason: `A newer report (${check.reportDate}) appeared and was selected.`,
                    baseline,
                    newestReportDate: check.reportDate,
                    selectedReport: selected.selected,
                    waitedMs: Date.now() - started,
                    attempts,
                    readyForExtraction: true,
                };
            }
        }

        // Re-read the page rather than sleeping blindly: the selector is
        // repopulated by the app, so we poll the ACTUAL end-state we need.
        await page.waitForTimeout(intervalMs);
    }

    const outcome = timeoutOutcome(baseline, Date.now() - started);

    console.error(outcome.reason);

    return {
        ok: false,
        ...outcome,
        attempts,
        readyForExtraction: false, // INVARIANT. Extraction never proceeds from here.
    };
}
