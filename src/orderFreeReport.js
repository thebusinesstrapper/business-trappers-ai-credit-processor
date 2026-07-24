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
/** Budget for ONE selection interaction. Bounded so a hidden control fails fast. */
const SELECT_TIMEOUT = 15000;
/** How long to watch for the page reacting to Submit. Observation only. */
const POST_SUBMIT_STATE_TIMEOUT_MS = 15000;
const POST_SUBMIT_POLL_MS = 500;
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
function attrEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function idSelector(optionId) {
    return `input[type="radio"][id="${attrEscape(optionId)}"]`;
}

/** The label explicitly bound to an input by id — the element a user clicks. */
function labelSelector(optionId) {
    return `label[for="${attrEscape(optionId)}"]`;
}

/**
 * Is live submission switched on?
 *
 * STRICT EQUALITY TO THE STRING "true". Not truthiness — "false" is a truthy
 * string, and an env var that says false must never enable an irreversible
 * action. Unset means observe.
 */
export function isSubmissionEnabled() {
    return describeSubmissionFlag().enabled;
}

/**
 * Read ENABLE_FREE_REPORT_SUBMISSION and explain what was found.
 *
 * WHY THIS RETURNS A DESCRIPTION RATHER THAN A BOOLEAN. When Marcos Lopez ran
 * with every approval true and the flag set, the result said only
 * "submissionEnabled: false" — which is the symptom, not the cause. There was no
 * way to tell an unset variable from one set to something the parser rejected,
 * so the run had to be repeated to learn anything.
 *
 * WRAPPING QUOTES ARE STRIPPED, and that is not speculative tolerance: this
 * project's own supabase.js already documents it — "Railway values are
 * sometimes pasted with wrapping quotes. Those quotes become part of the
 * hostname/key unless removed." A value pasted as "true" WITH the quotes reads
 * as `"true"` including them, which is not equal to true, and the flag silently
 * stays off. That is the single most likely reason a correctly-set variable did
 * not activate submission.
 *
 * EVERYTHING ELSE STAYS STRICT. After trimming and unwrapping, only the exact
 * lowercase string "true" enables submission. "TRUE", "1", "yes" and "on" are
 * all rejected — an ambiguous value must never arm an irreversible action — but
 * they are now reported as REJECTED rather than treated as absent.
 */
export function describeSubmissionFlag() {
    const raw = process.env.ENABLE_FREE_REPORT_SUBMISSION;

    if (raw === undefined || raw === null) {
        return { enabled: false, present: false, reason: "env_var_not_set", normalized: null };
    }

    let value = String(raw).trim();

    const wasQuoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));

    if (wasQuoted && value.length >= 2) {
        value = value.slice(1, -1).trim();
    }

    if (value === "true") {
        return { enabled: true, present: true, reason: "enabled", normalized: value, wasQuoted };
    }

    return {
        enabled: false,
        present: true,
        // The VALUE is not echoed. It is an operator-supplied string and this
        // object travels into a job result; the shape is enough to fix it.
        reason: value === ""
            ? "env_var_present_but_empty"
            : "env_var_present_but_not_exactly_true",
        normalizedLength: value.length,
        wasQuoted,
        normalized: null
    };
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
 * Snapshot the controls that LOOK like the order entry point, for diagnostics.
 *
 * PRIVACY. CreditHero URLs carry tGUID transaction tokens. Per the rule already
 * enforced in creditHeroLandingState.js — token-like identifiers are never read,
 * returned, logged or persisted — this returns the href's FILENAME ONLY
 * (everything before "?" and after the last "/"). "mcc_order_select_v2.asp"
 * leaves; "?tGUID=..." never does.
 *
 * Read-only: querySelectorAll and property reads. Nothing is clicked.
 */
async function snapshotOrderCandidates(page) {
    const seen = [];

    for (const frame of page.frames()) {
        try {
            const found = await frame.evaluate((needle) => {
                const fileOnly = (raw) => {
                    if (!raw) return null;
                    // Strip the query string FIRST — that is where the token is.
                    const noQuery = String(raw).split("?")[0].split("#")[0];
                    return noQuery.split("/").filter(Boolean).pop() ?? null;
                };

                const nodes = Array.from(
                    document.querySelectorAll("a, button, input[type=button], input[type=submit]")
                );

                return nodes
                    .filter((el) => {
                        const label = (el.innerText || el.value || "").trim();
                        const href = el.getAttribute ? el.getAttribute("href") : null;
                        return (
                            /order/i.test(label) ||
                            /report/i.test(label) ||
                            (href && href.toLowerCase().includes(needle.toLowerCase()))
                        );
                    })
                    .slice(0, 12)
                    .map((el) => ({
                        tag: el.tagName.toLowerCase(),
                        // Label only, trimmed and capped. No digits of any length
                        // are expected in these labels, but cap anyway.
                        label: (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 60),
                        hasHref: Boolean(el.getAttribute && el.getAttribute("href")),
                        hrefFile: fileOnly(el.getAttribute && el.getAttribute("href")),
                        hasOnclick: Boolean(el.getAttribute && el.getAttribute("onclick")),
                        type: el.getAttribute ? el.getAttribute("type") : null,
                    }));
            }, ORDER_PAGE);

            seen.push(...found);
        } catch {
            // detached or cross-origin frame
        }
    }

    return seen;
}

/** The page filename we are currently on, with any token stripped. */
function pageFileOnly(url) {
    if (!url) return null;
    return String(url).split("?")[0].split("#")[0].split("/").filter(Boolean).pop() ?? null;
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
export async function navigateToOrderPage(page, opts = {}) {
    const { memberDashboardUrl = null } = opts;

    /** Poll the CURRENT page for the order link. */
    async function findHere(budgetMs) {
        const deadline = Date.now() + budgetMs;

        while (Date.now() < deadline) {
            const found = await findOrderPageUrl(page);
            if (found) return found;
            await page.waitForTimeout(250);
        }

        return null;
    }

    let orderUrl = await findHere(LINK_TIMEOUT / 2);

    // ---- THE PAGE-IDENTITY FIX --------------------------------------------
    //
    // WHY THIS EXISTS. "ORDER NEW REPORT" lives on the Credit Hero MEMBER
    // DASHBOARD (mcc_creditscores.asp) — the page openCreditHero lands on,
    // alongside "My Reports and Scores", "LAST REPORT DATE" and "VIEW REPORT".
    //
    // But by the time acquisition runs, openCreditReport() has already
    // page.goto()'d this same handle onward to the REPORT page
    // (mcc_creditreports_v2.asp) to reach the report selector. So we were
    // searching the report page for a control that only exists on the page we
    // had just navigated away from, and correctly reporting that no such link
    // was there. The finder was never wrong; it was pointed at the wrong page.
    //
    // THIS IS NOT URL CONSTRUCTION. memberDashboardUrl is captured live from
    // chPage.url() immediately BEFORE openCreditReport() navigates away — an
    // address the browser was actually on, carried forward. Nothing is guessed,
    // assembled from a known filename, or derived from an origin. If the caller
    // supplies none, we do not invent one and the search simply fails closed.
    if (!orderUrl && memberDashboardUrl && page.url() !== memberDashboardUrl) {
        console.log(
            `Order link not on ${pageFileOnly(page.url()) ?? "the current page"} — ` +
            `returning to ${pageFileOnly(memberDashboardUrl) ?? "the member dashboard"} to look there.`
        );

        await page
            .goto(memberDashboardUrl, { waitUntil: "load", timeout: NAV_TIMEOUT })
            .catch(() => {});

        orderUrl = await findHere(LINK_TIMEOUT);
    }

    if (!orderUrl) {
        // FAIL CLOSED — but with EVIDENCE. The previous version reported only
        // that nothing was found, which is what forced a second blind run. The
        // snapshot names the controls that are actually present (tag, label,
        // whether they carry an href or an onclick) so the next decision is made
        // from the live DOM rather than from a guess about it.
        const candidates = await snapshotOrderCandidates(page).catch(() => []);

        return {
            ok: false,
            error_code: "ORDER_PAGE_LINK_NOT_FOUND",
            error:
                `No link to "${ORDER_PAGE}" was found on the Credit Hero member dashboard. ` +
                `The URL is never constructed, so acquisition stops here.`,
            searchedPage: pageFileOnly(page.url()),
            memberDashboardSearched: Boolean(memberDashboardUrl),
            // Diagnostic only. Filenames and labels; never a tGUID-bearing URL.
            candidateControls: candidates,
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
 * POSITIVE VERIFICATION THAT THE FREE OPTION — AND NOTHING ELSE — IS SELECTED.
 *
 * Asserting only "the free radio is checked" would be insufficient. These
 * controls share one radio group, so the question that actually matters before
 * submitting an order is which option the form will POST. Enumerating the group
 * and requiring exactly one checked entry, whose id is FREE_OPTION_ID, answers
 * that directly and makes a paid selection impossible to miss.
 *
 * isChecked() is a state query, not an action, so it reads correctly through a
 * CSS-hidden native input.
 */
async function verifyOnlyFreeIsChecked(frame, optionId) {
    // ENUMERATE FIRST, UNCONDITIONALLY.
    //
    // An earlier version short-circuited on "is the free radio checked?" before
    // reading the group. That returned an empty checkedIds in precisely the case
    // where the answer matters most — a click that checked SOMETHING ELSE — so
    // the most dangerous outcome produced the least evidence. The group read
    // subsumes the single-radio check anyway.
    const radios = frame.locator('input[type="radio"]');
    const count = await radios.count().catch(() => 0);
    const checkedIds = [];

    for (let i = 0; i < count; i += 1) {
        const radio = radios.nth(i);

        if (await radio.isChecked().catch(() => false)) {
            checkedIds.push((await radio.getAttribute("id").catch(() => null)) ?? "(no id)");
        }
    }

    if (checkedIds.length === 0) {
        return {
            ok: false,
            reason: `"${optionId}" did not become checked; no option in the radio group is checked.`,
            checkedIds,
        };
    }

    if (checkedIds.length !== 1 || checkedIds[0] !== optionId) {
        return {
            ok: false,
            reason:
                `Expected exactly one checked option ("${optionId}"); the group reports ` +
                `[${checkedIds.join(", ")}]. Not submitting.`,
            checkedIds,
        };
    }

    return { ok: true, checkedIds };
}

/**
 * ---------------------------------------------------------------------------
 * SELECT THE VERIFIED FREE OPTION.
 *
 * WHY radio.check() ALONE IS NOT ENOUGH. CreditHero CSS-replaces the native
 * <input type="radio">: the input is hidden and a bound <label> is what is drawn
 * and clicked. This was PROVEN on Marcos Lopez's live order page, where
 * visibility resolved via `bound_label_visible` rather than
 * `radio_input_visible`. Playwright's check() waits for actionability, so
 * against a hidden input it does not misfire — it TIMES OUT. Live submission
 * would have failed at the last step, after the acquisition intent was already
 * recorded.
 *
 * WHY NOT force: true. force skips the actionability checks entirely and
 * dispatches the event regardless. On a page whose controls spend a client's
 * entitlement, that trades a clean, diagnosable stop for a synthetic interaction
 * with a control we cannot confirm is behaving. Explicitly forbidden here.
 *
 * THE ORDER IS: real control first, bound label second, nothing third.
 *
 *   1. The native input, IF it is genuinely visible. Unchanged behaviour for any
 *      account where CreditHero does not restyle it.
 *   2. The bound label — the element a human clicks. Required to exist, to be
 *      UNIQUE, and to be visible. Two labels bound to one id is ambiguity, and
 *      we do not resolve ambiguity by picking one.
 *   3. Nothing. No container click, no coordinate click, no force. If neither
 *      the input nor a single visible bound label is available, the option
 *      cannot be selected the way a user would select it, and we stop.
 *
 * Whatever path was taken, selection is then PROVEN by reading the radio group
 * back. A click that appeared to succeed but left the group unchanged — or, far
 * worse, left a different option checked — is a failure.
 * ---------------------------------------------------------------------------
 */
async function selectVerifiedFreeOption(frame, optionId) {
    const outcome = { via: null, clickAttempted: false, verification: null };

    const radio = frame.locator(idSelector(optionId)).first();

    if (await radio.isVisible().catch(() => false)) {
        outcome.via = "native_input";
        outcome.clickAttempted = true;

        const done = await radio
            .check({ timeout: SELECT_TIMEOUT })   // NO force.
            .then(() => true)
            .catch(() => false);

        if (!done) {
            return { ...outcome, ok: false, reason: "check() on the native radio did not complete." };
        }
    } else {
        const labels = frame.locator(labelSelector(optionId));
        const labelCount = await labels.count().catch(() => 0);

        if (labelCount === 0) {
            return {
                ...outcome,
                ok: false,
                reason:
                    `The native radio for "${optionId}" is not actionable and no bound ` +
                    `<label for="${optionId}"> exists to click. Not selecting.`,
            };
        }

        if (labelCount > 1) {
            return {
                ...outcome,
                ok: false,
                reason:
                    `Ambiguous: ${labelCount} labels are bound to "${optionId}". We do not ` +
                    `resolve ambiguity by choosing one. Not selecting.`,
            };
        }

        const label = labels.first();

        if (!(await label.isVisible().catch(() => false))) {
            return {
                ...outcome,
                ok: false,
                reason: `The label bound to "${optionId}" is present but not visible. Not clicking it.`,
            };
        }

        outcome.via = "bound_label";
        outcome.clickAttempted = true;

        const done = await label
            .click({ timeout: SELECT_TIMEOUT })   // NO force.
            .then(() => true)
            .catch(() => false);

        if (!done) {
            return { ...outcome, ok: false, reason: "The bound-label click did not complete." };
        }
    }

    const verification = await verifyOnlyFreeIsChecked(frame, optionId);
    outcome.verification = verification;

    if (!verification.ok) return { ...outcome, ok: false, reason: verification.reason };

    return { ...outcome, ok: true };
}

/**
 * CANDIDATE SUBMIT CONTROLS, most specific first.
 *
 * THE DEFECT THIS FIXES. The lookup was
 * `input[type="submit"], button[type="submit"]`, and CreditHero's order page
 * uses NEITHER. The live control is an anchor:
 *
 *   <a class="btn btn-large btn-primary" onclick="orderSelect();">Submit</a>
 *
 * so the free option was correctly selected and the flow then stopped at
 * SUBMIT_CONTROL_NOT_FOUND with nothing clicked. Fail-closed worked; the
 * selector was simply blind to the element that exists.
 *
 * WHY NOT `.btn-primary`. That class is on Cancel, Back, payment and navigation
 * controls all over this site, and this is the one page where clicking the
 * wrong primary button spends a client's entitlement. Each entry below is
 * anchored on something that identifies THE SUBMIT ACTION — the orderSelect
 * handler, or a real submit input/button — never on styling alone.
 *
 * A CSS selector list matches each element ONCE even when several entries
 * would match it, so the exact-class entry and the handler-only entry cannot
 * make one control look like two.
 */
const SUBMIT_CONTROL_SELECTOR = [
    'a.btn.btn-large.btn-primary[onclick*="orderSelect"]',
    'a[onclick*="orderSelect"]',
    'input[type="submit"]',
    'button[type="submit"]',
].join(", ");

/** The only accepted label, after trim / whitespace collapse / lower-casing. */
const SUBMIT_LABEL = "submit";

/** Cap a UI label before it travels into a job result. */
function safeLabel(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/\s+/g, " ").trim();
    return cleaned ? cleaned.slice(0, 60) : "";
}

/**
 * Find the ONE actionable control whose visible label is exactly "Submit".
 *
 * Three independent conditions, all required:
 *   1. it matches a selector that identifies the submit ACTION, not a style;
 *   2. its visible label normalizes exactly to "Submit" — so a Cancel, Back or
 *      payment control carrying the same classes is rejected on its text;
 *   3. it is visible AND enabled.
 *
 * AMBIGUITY IS REFUSED. Two qualifying controls means we cannot say which one
 * submits the order, and this is not a page on which to find out by clicking.
 */
async function findSubmitControl(frame) {
    const controls = frame.locator(SUBMIT_CONTROL_SELECTOR);
    const matchCount = await controls.count().catch(() => 0);

    const qualifying = [];
    const rejected = [];

    for (let index = 0; index < matchCount; index += 1) {
        const control = controls.nth(index);

        // input[type=submit] carries its label in `value`; anchors and buttons
        // carry it as text.
        const rawLabel = await control
            .evaluate((node) => node.value || node.innerText || node.textContent || "")
            .catch(() => "");

        const label = safeLabel(rawLabel);
        const normalized = (label ?? "").toLowerCase();

        if (normalized !== SUBMIT_LABEL) {
            rejected.push({ index, reason: "label_not_submit", label });
            continue;
        }

        const visible = await control.isVisible().catch(() => false);
        const enabled = await control.isEnabled().catch(() => false);

        if (!visible || !enabled) {
            rejected.push({
                index,
                reason: !visible ? "not_visible" : "not_enabled",
                label,
            });
            continue;
        }

        qualifying.push({ index, control, label });
    }

    return { matchCount, qualifying, rejected };
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

    const flag = describeSubmissionFlag();

    const report = {
        tool: ORDER_FREE_REPORT_VERSION,
        submissionEnabled: flag.enabled,
        submissionFlagReason: flag.reason,
        optionId: optionId ?? null,
        observedCost: observedCost ?? null,
        liveVerification: null,
        optionSelected: false,
        // How the option was selected, and the proof it worked. Diagnostic, and
        // the audit trail for an interaction with a money-spending page.
        selectedVia: null,
        clickAttempted: false,
        selectionVerification: null,
        preSubmitReconfirmed: false,
        submitClicked: false,
        submitControlDiagnostic: null,
        postSubmitStateChanged: null,
        error_code: null,
        failureReason: null,
    };

    // ---- GATE 0: THE FLAG *AND* THE RUN APPROVALS ------------------------
    //
    // First statement in the only function that can click. Nothing below runs
    // unless every gate holds, so in observe mode the Submit control is never
    // located and no handle to it exists.
    //
    // THE APPROVALS ARE CHECKED HERE TOO, not only by the caller. This function
    // is the last thing standing between a decision and a spent entitlement, so
    // it re-proves the conditions rather than trusting that someone upstream
    // did. A caller that forgets to pass them gets a refusal, not a submission.
    const approvals = opts.approvals ?? {};

    report.gateState = {
        environmentFlag: flag.enabled,
        submitApproved: approvals.submitApproved === true,
        operationalRoutingApproved: approvals.operationalRoutingApproved === true
    };

    report.blockedGates = Object.keys(report.gateState).filter(function(gate) {
        return report.gateState[gate] !== true;
    });

    if (report.blockedGates.length > 0) {
        report.error_code = "SUBMISSION_DISABLED";
        report.failureReason =
            "Observation only — nothing was selected and nothing was submitted. " +
            `Blocking gate(s): ${report.blockedGates.join(", ")}. ` +
            `Environment flag: ${flag.reason}.`;
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
    //
    // Label-first when the native input is CSS-replaced, and PROVEN afterwards
    // by reading the radio group back. Never forced.
    const selection = await selectVerifiedFreeOption(targetFrame, optionId);

    report.selectedVia = selection.via;
    report.clickAttempted = selection.clickAttempted;
    report.selectionVerification = selection.verification;

    if (!selection.ok) {
        // optionSelected stays FALSE because no option is selected — which is
        // the literal truth, and is what lets the caller cancel the acquisition
        // intent cleanly. Safe to cancel: the submit control is not even located
        // below this point, so nothing can have been ordered.
        report.error_code = "FREE_OPTION_NOT_SELECTED";
        report.failureReason = `${selection.reason} Submit was not clicked.`;
        return report;
    }

    report.optionSelected = true;

    console.log(
        `Selected the FREE option "${optionId}" via ${selection.via}; ` +
        `radio group confirms it is the only checked option.`
    );

    // ---- PRE-SUBMIT RECONFIRMATION ----------------------------------------
    //
    // THE LAST GATE BEFORE AN IRREVERSIBLE ACTION, deliberately re-proving what
    // was already proven. Every earlier check was made against an earlier state
    // of the page; this one is made against the state we are about to submit.
    //
    // Re-asserting the two constants (identity and cost) is intentionally
    // redundant with GATE 1 and GATE 2. The redundancy is the point: it survives
    // a future refactor that reorders or removes an earlier gate.
    if (optionId !== FREE_OPTION_ID || observedCost !== 0) {
        report.error_code = "PRE_SUBMIT_IDENTITY_OR_COST_CHANGED";
        report.failureReason =
            `Pre-submit reconfirmation failed: option "${optionId}" at cost ` +
            `${observedCost === null ? "unknown" : observedCost} is not the verified free option ` +
            `at cost 0. Submit was not clicked.`;
        return report;
    }

    const reverified = await verifyFreeOptionLive(targetFrame, optionId);

    if (!reverified.ok) {
        report.error_code = "PRE_SUBMIT_VERIFICATION_FAILED";
        report.failureReason = `${reverified.reason} Submit was not clicked.`;
        return report;
    }

    const stillOnlyFree = await verifyOnlyFreeIsChecked(targetFrame, optionId);
    report.selectionVerification = stillOnlyFree;

    if (!stillOnlyFree.ok) {
        report.error_code = "PRE_SUBMIT_SELECTION_CHANGED";
        report.failureReason = `${stillOnlyFree.reason} Submit was not clicked.`;
        return report;
    }

    report.preSubmitReconfirmed = true;

    // ---- SUBMIT -----------------------------------------------------------
    const found = await findSubmitControl(targetFrame);

    report.submitControlDiagnostic = {
        selector: SUBMIT_CONTROL_SELECTOR,
        matchCount: found.matchCount,
        qualifyingCount: found.qualifying.length,
        rejected: found.rejected.slice(0, 6),
    };

    if (found.qualifying.length === 0) {
        report.error_code = "SUBMIT_CONTROL_NOT_FOUND";
        report.failureReason =
            "The free option was selected but no actionable control labelled \"Submit\" was " +
            "found. Nothing was clicked. The intent remains unresolved and will be recovered " +
            "on a later run.";
        return report;
    }

    if (found.qualifying.length > 1) {
        // We cannot say which one submits the order, and this is not a page on
        // which to find out by clicking.
        report.error_code = "SUBMIT_CONTROL_AMBIGUOUS";
        report.failureReason =
            `${found.qualifying.length} controls labelled "Submit" are actionable on this page. ` +
            "Refusing to choose between them. Nothing was clicked.";
        return report;
    }

    await found.qualifying[0].control.click({ timeout: LINK_TIMEOUT });
    report.submitClicked = true;

    // ---- DID THE PAGE ACTUALLY MOVE? --------------------------------------
    //
    // A click landing is not an order being placed. The AUTHORITATIVE proof is
    // a strictly newer report appearing, which milestone6 polls for afterwards;
    // this is the cheap, immediate signal that the page reacted at all.
    //
    // IT NEVER UNDOES submitClicked. The click happened, so the intent stays
    // unresolved and nothing is ever resubmitted on its account — an observation
    // that the page did not visibly change is recorded, not acted upon.
    const stateDeadline = Date.now() + POST_SUBMIT_STATE_TIMEOUT_MS;
    let stateChanged = false;

    while (!stateChanged && Date.now() < stateDeadline) {
        const leftOrderPage = !page.url().toLowerCase().includes(ORDER_PAGE.toLowerCase());

        const controlGone =
            (await targetFrame.locator(SUBMIT_CONTROL_SELECTOR).count().catch(() => 0)) === 0;

        stateChanged = leftOrderPage || controlGone;

        if (!stateChanged) await page.waitForTimeout(POST_SUBMIT_POLL_MS);
    }

    report.postSubmitStateChanged = stateChanged;

    if (!stateChanged) {
        report.postSubmitObservation =
            "Submit was clicked but the order page did not visibly change within the wait " +
            "window. The order may still have been placed; the acquisition intent stays " +
            "unresolved and is reconciled by report appearance, never by resubmitting.";
    }

    console.log("Free report submitted. Effect is NOT yet confirmed.");

    return report;
}
