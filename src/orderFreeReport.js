/**
 * orderFreeReport.js
 *
 * ===========================================================================
 * THE ONLY MODULE PERMITTED TO NAVIGATE TO, OR ACT ON, THE CREDIT HERO ORDER
 * PAGE (mcc_order_select_v2.asp).
 *
 * openCreditReport.js lists that URL in FORBIDDEN_PAGES and refuses to navigate
 * to it, before AND after landing. THAT RULE IS NOT RELAXED AND MUST NOT BE.
 * It protects the report-reading path, where arriving on the order page can only
 * ever be an accident — a Credit Hero redirect that would put a money-spending
 * page under an automation that was looking for a report.
 *
 * This module is the deliberate exception, in its own file, with its own
 * explicit authority, exactly as openCreditReport.js's header anticipated: "If a
 * future milestone needs to click something over there, it belongs in a
 * different module with an explicit, deliberate decision behind it."
 *
 * The boundary is therefore INTENT. Arriving here by accident is forbidden.
 * Arriving here on purpose, having already decided to spend a positively
 * verified zero-cost entitlement, is this module and only this module.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * OBSERVE-ONLY IS THE DEFAULT AND IT IS ENFORCED AT THE TOP OF THE ONE
 * FUNCTION THAT CAN CLICK.
 *
 *   ENABLE_FREE_REPORT_SUBMISSION unset / "false" / anything else -> OBSERVE
 *   ENABLE_FREE_REPORT_SUBMISSION === "true"                      -> may submit
 *
 * In observe mode nothing is selected, nothing is submitted, and the Submit
 * control is never even located — this module holds no handle that could be
 * clicked. Reading a page to learn what it offers costs the client nothing.
 * ---------------------------------------------------------------------------
 */

import { FREE_OPTION_ID, isFreeRowText } from "./orderPageReader.js";

export const ORDER_FREE_REPORT_VERSION = "BT-ORDER-FREE-1.0";

/** The one page this module may reach. Anything else is a hard stop. */
const ORDER_PAGE = "mcc_order_select_v2.asp";

const LINK_TIMEOUT = 20000;
const NAV_TIMEOUT = 60000;
const READ_TIMEOUT = 8000;

/** Visible text of the control that leads to the order page. */
const ORDER_LINK_PATTERN = /order\s+new\s+report/i;

/**
 * Escape an id for use inside a CSS attribute selector.
 *
 * NOT CSS.escape(). That is a BROWSER global and is `undefined` in Node, so
 * building the selector string here — which happens in Node, before Playwright
 * ships it to the page — would have thrown "CSS is not defined" at the exact
 * moment we were about to interact with a money-spending page.
 *
 * Attribute-value form is used rather than the `#id` shorthand so that an id
 * containing a character illegal in a bare selector cannot break the query.
 */
function idSelector(optionId) {
    const escaped = String(optionId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `input[type="radio"][id="${escaped}"]`;
}

/**
 * Is live submission switched on?
 *
 * STRICT EQUALITY TO THE STRING "true". Not truthiness — "false" is a truthy
 * string, and an env var that says false must never enable an irreversible
 * action. Unset means observe.
 */
export function isSubmissionEnabled() {
    return String(process.env.ENABLE_FREE_REPORT_SUBMISSION ?? "").trim() === "true";
}

/**
 * Resolve the ORDER NEW REPORT link's own absolute href, searching every frame.
 *
 * WE NEVER CONSTRUCT THIS URL. openCreditReport.js refuses to build a report URL
 * from a known filename because a guessed path is a guessed navigation on a site
 * with an order page on it. That reasoning applies with more force here, where
 * the destination IS the order page: we go only where a link on the page
 * actually points.
 *
 * Reading `el.href` (the property) yields the browser's own absolute resolution.
 */
async function findOrderPageUrl(page) {
    for (const frame of page.frames()) {
        let href = null;

        try {
            href = await frame.evaluate((needle) => {
                const anchors = Array.from(document.querySelectorAll("a[href]"));

                const match = anchors.find((a) =>
                    (a.getAttribute("href") || "").toLowerCase().includes(needle.toLowerCase())
                );

                return match ? match.href : null;
            }, ORDER_PAGE);
        } catch {
            continue; // detached or cross-origin frame
        }

        if (href) return href;
    }

    // Fall back to the visible label, resolving the anchor it belongs to.
    for (const frame of page.frames()) {
        const link = frame.getByText(ORDER_LINK_PATTERN).first();

        if (!(await link.count().catch(() => 0))) continue;

        const href = await link
            .evaluate((el) => {
                const anchor = el.closest("a[href]") ?? (el.tagName === "A" ? el : null);
                return anchor ? anchor.href : null;
            })
            .catch(() => null);

        if (href) return href;
    }

    return null;
}

/**
 * Navigate the given page to the Credit Hero order page.
 *
 * READ-ONLY ONCE THERE. This function goes to the page and stops; it selects
 * nothing and submits nothing. The caller reads it with
 * orderPageReader.readOrderPageOptions().
 *
 * @returns {Promise<{ok: boolean, url?: string, error_code?: string, error?: string}>}
 */
export async function navigateToOrderPage(page) {
    const deadline = Date.now() + LINK_TIMEOUT;

    let orderUrl = null;

    while (Date.now() < deadline) {
        orderUrl = await findOrderPageUrl(page);
        if (orderUrl) break;
        await page.waitForTimeout(250);
    }

    if (!orderUrl) {
        return {
            ok: false,
            error_code: "ORDER_PAGE_LINK_NOT_FOUND",
            error:
                `No link to "${ORDER_PAGE}" was found on the Credit Hero dashboard. ` +
                `The URL is never constructed, so acquisition stops here.`,
        };
    }

    // The destination must BE the order page. A link that merely matched the
    // label but points somewhere else is not followed.
    if (!orderUrl.toLowerCase().includes(ORDER_PAGE.toLowerCase())) {
        return {
            ok: false,
            error_code: "ORDER_PAGE_URL_UNEXPECTED",
            error: `The ORDER NEW REPORT link does not point at ${ORDER_PAGE}. Not navigating.`,
        };
    }

    await page.goto(orderUrl, { waitUntil: "load", timeout: NAV_TIMEOUT });

    const landed = page.url();

    if (!landed.toLowerCase().includes(ORDER_PAGE.toLowerCase())) {
        return {
            ok: false,
            error_code: "ORDER_PAGE_NOT_REACHED",
            error: `Navigation did not land on ${ORDER_PAGE}. Landed on a different page.`,
        };
    }

    console.log(`On the Credit Hero order page (read-only unless submission is enabled).`);

    return { ok: true, url: landed };
}

/**
 * THE TRIPLE GATE — re-verified against the LIVE DOM immediately before any
 * click, never trusted from an earlier read.
 *
 * decideAcquisition() already proved the free option is zero-cost, enabled, and
 * distinct from the paid option. That decision was made from a snapshot. Pages
 * change underneath automations, and the cost of being wrong here is a charge to
 * the client, so the option is proven again at the moment of use:
 *
 *   1. Its id is EXACTLY FREE_OPTION_ID.
 *   2. Its own row text positively reads as the 3-bureau FREE option.
 *   3. Its row carries NO dollar amount whatsoever.
 *
 * All three, or nothing happens.
 */
async function verifyFreeOptionLive(frame, optionId) {
    const radio = frame.locator(idSelector(optionId)).first();

    if (!(await radio.count().catch(() => 0))) {
        return { ok: false, reason: `Option "${optionId}" is not present on the live page.` };
    }

    if (optionId !== FREE_OPTION_ID) {
        return {
            ok: false,
            reason: `Refusing to select "${optionId}": it is not the free option id.`,
        };
    }

    const row = radio
        .locator("xpath=ancestor-or-self::*[contains(@class,'order-item')][1]")
        .first();

    const node = (await row.count().catch(() => 0)) > 0 ? row : radio;
    const text = (await node.textContent({ timeout: READ_TIMEOUT }).catch(() => "")) || "";

    if (!isFreeRowText(text)) {
        return {
            ok: false,
            reason:
                `Refusing to select "${optionId}": its live row text does not positively read ` +
                `as the 3-bureau FREE option, or it now carries a price.`,
        };
    }

    if (await radio.isDisabled().catch(() => true)) {
        return { ok: false, reason: `Option "${optionId}" is disabled on the live page.` };
    }

    return { ok: true };
}

/**
 * Select and submit the FREE report.
 *
 * @param {import('playwright').Page} page   a page already on the order page
 * @param {object} opts
 * @param {string} opts.optionId             must equal FREE_OPTION_ID
 * @param {number} opts.observedCost         must be exactly 0
 * @param {Function} opts.onSubmissionStarted  awaited BEFORE the click lands
 * @returns {Promise<object>}
 */
export async function selectAndSubmitFreeReport(page, opts = {}) {
    const { optionId, observedCost, onSubmissionStarted } = opts;

    const report = {
        tool: ORDER_FREE_REPORT_VERSION,
        submissionEnabled: isSubmissionEnabled(),
        optionId: optionId ?? null,
        observedCost: observedCost ?? null,
        liveVerification: null,
        optionSelected: false,
        submitClicked: false,
        error_code: null,
        failureReason: null,
    };

    // ---- GATE 0: THE FEATURE FLAG ----------------------------------------
    //
    // First statement in the only function that can click. Nothing below runs
    // in observe mode, so the Submit control is never located and no handle to
    // it exists.
    if (!report.submissionEnabled) {
        report.error_code = "SUBMISSION_DISABLED";
        report.failureReason =
            "ENABLE_FREE_REPORT_SUBMISSION is not \"true\". Observation only — nothing was " +
            "selected and nothing was submitted.";
        return report;
    }

    // ---- GATE 1: THE DECISION MUST BE ZERO COST --------------------------
    if (observedCost !== 0) {
        report.error_code = "OBSERVED_COST_NOT_ZERO";
        report.failureReason =
            `Refusing to submit: observed cost is ${observedCost === null ? "unknown" : observedCost}, ` +
            `not 0. An undetermined cost is never the same as free.`;
        return report;
    }

    // ---- GATE 2: THE OPTION MUST BE THE FREE ONE -------------------------
    if (optionId !== FREE_OPTION_ID) {
        report.error_code = "OPTION_NOT_FREE_OPTION";
        report.failureReason = `Refusing to submit: "${optionId}" is not the free option.`;
        return report;
    }

    // ---- GATE 3: RE-PROVE IT ON THE LIVE PAGE ----------------------------
    let targetFrame = null;

    for (const f of page.frames()) {
        const found = await f.locator(idSelector(optionId)).count().catch(() => 0);
        if (found > 0) {
            targetFrame = f;
            break;
        }
    }

    if (!targetFrame) {
        report.error_code = "FREE_OPTION_NOT_ON_PAGE";
        report.failureReason = `Option "${optionId}" was not found on the live order page.`;
        return report;
    }

    const verified = await verifyFreeOptionLive(targetFrame, optionId);
    report.liveVerification = verified;

    if (!verified.ok) {
        report.error_code = "LIVE_VERIFICATION_FAILED";
        report.failureReason = verified.reason;
        return report;
    }

    // ---- RECORD THE INTENT BEFORE ACTING ---------------------------------
    //
    // The caller's hook writes `submission_started` to Supabase. If it fails, we
    // do NOT proceed — an unrecorded submission is exactly the crash-then-
    // reorder scenario report_acquisition_intents exists to prevent.
    if (typeof onSubmissionStarted === "function") {
        const marked = await onSubmissionStarted();

        if (!marked?.ok) {
            report.error_code = "INTENT_NOT_MARKED_STARTED";
            report.failureReason =
                "The acquisition intent could not be moved to submission_started, so the " +
                "submission was not attempted. Nothing was clicked.";
            return report;
        }
    }

    // ---- SELECT -----------------------------------------------------------
    const radio = targetFrame.locator(idSelector(optionId)).first();

    await radio.check({ timeout: LINK_TIMEOUT });
    report.optionSelected = true;

    console.log(`Selected the FREE option "${optionId}" (verified $0 on the live page).`);

    // ---- SUBMIT -----------------------------------------------------------
    const submit = targetFrame
        .locator('input[type="submit"], button[type="submit"]')
        .first();

    if (!(await submit.count().catch(() => 0))) {
        report.error_code = "SUBMIT_CONTROL_NOT_FOUND";
        report.failureReason =
            "The free option was selected but no submit control was found. Nothing was clicked. " +
            "The intent remains unresolved and will be recovered on a later run.";
        return report;
    }

    await submit.click({ timeout: LINK_TIMEOUT });
    report.submitClicked = true;

    console.log("Free report submitted. Effect is NOT yet confirmed.");

    return report;
}
