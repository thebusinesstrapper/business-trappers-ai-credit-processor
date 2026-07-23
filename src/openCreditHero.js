/**
 * openCreditHero.js
 *
 * Responsible ONLY for:
 *   1. Clicking the "View CreditHeroScore Account" link on an already-open
 *      client dashboard.
 *   2. Following the resulting page (new tab OR same tab).
 *   3. Capturing URL, title, and a screenshot of whatever loaded.
 *
 * Opening the client dashboard stays in openClient.js.
 * Auth/navigation stays in crcLogin.js.
 *
 * ---------------------------------------------------------------------------
 * SAFETY INVARIANT — DO NOT VIOLATE
 *
 * This module clicks EXACTLY ONE element: the "View CreditHeroScore Account"
 * entry link. Nothing on the resulting CreditHeroScore page is ever clicked.
 *
 * That page may present controls that order a new report, reactivate
 * monitoring, or otherwise charge the client money. Those actions are
 * irreversible and are forbidden by project business rules. This module
 * OBSERVES the CreditHeroScore page and reports what it sees. It never acts
 * on it.
 *
 * If a future milestone needs to click something over there, it belongs in a
 * different module with an explicit, deliberate decision behind it.
 * ---------------------------------------------------------------------------
 *
 * There is no standalone CreditHeroScore login. Credit Repair Cloud
 * authenticates the user automatically when the account is active, so this
 * module implements NO login logic.
 *
 * Two outcomes are both considered SUCCESS:
 *   1. The active CreditHeroScore account loads.
 *   2. A reactivation/activation page loads (account inactive).
 *
 * An inactive account is a normal business condition, not an error. We capture
 * it and report it. We do not attempt to resolve it.
 */

// How long to give CRC to spawn a new tab after the click before we conclude
// it navigated in the current tab instead.
const NEW_TAB_TIMEOUT = 15000;

// How long to wait for the CreditHeroScore page to reach the "load" state.
const PAGE_LOAD_TIMEOUT = 60000;

/**
 * TEMPORARY — MILESTONE 3 DISCOVERY SCAFFOLDING.
 *
 * This is the one bounded, unconditional wait in the codebase, and it exists
 * only because Milestone 3 is a discovery milestone: we do not yet know what
 * element on the CreditHeroScore page reliably signals "rendered and ready."
 * Finding that signal is the entire point of capturing this screenshot.
 *
 * "load" can fire before a client-rendered page has painted, which would give
 * us a blank screenshot and defeat the purpose of the milestone. This short
 * settle makes the capture legible.
 *
 * REMOVE THIS IN MILESTONE 4, once the Browserbase replay and screenshot from
 * this milestone tell us the real readiness signal to wait on instead.
 */
const DISCOVERY_SETTLE_MS = 2000;

const CREDIT_HERO_LABEL = "View CreditHeroScore Account";

// Tolerates "CreditHeroScore" / "Credit Hero Score" spacing variants.
const CREDIT_HERO_PATTERN = /view\s*credit\s*hero\s*score\s*account/i;

/**
 * Resolve the "View CreditHeroScore Account" link.
 *
 * Built as a UNION rather than probe-and-fall-through, for the same reason
 * openClient.js does it: CRC renders href-less anchors, and an <a> with no
 * href carries NO ARIA "link" role — so a role-based query silently never
 * matches it. .or() resolves against whichever shape the real DOM uses.
 *
 *   1. Role-based — correct if CRC gives the anchor an href.
 *   2. Tag-based  — catches the href-less anchor case.
 *   3. Exact text — catches the label being a styled <div>/<span>.
 */
function getCreditHeroLink(page) {
    return page
        .getByRole("link", { name: CREDIT_HERO_PATTERN })
        .or(page.locator("a", { hasText: CREDIT_HERO_PATTERN }))
        .or(page.getByText(CREDIT_HERO_LABEL, { exact: true }))
        .first();
}

/**
 * Click the CreditHeroScore link and return the page it actually landed on.
 *
 * CRC is expected to open CreditHeroScore in a NEW TAB, but the inactive /
 * reactivation path may navigate in place instead. If we assumed "new tab" and
 * CRC navigated in place, we would sit waiting on an event that never fires;
 * if we assumed "same tab" and CRC opened a new one, every subsequent read
 * would query the stale CRC dashboard while the real page sat in a tab we were
 * ignoring.
 *
 * So we race both: listen for the new page while clicking, and fall back to the
 * current page if no new tab appears.
 *
 * @returns {Promise<{ page: import('playwright').Page, openedInNewTab: boolean }>}
 */
async function clickAndFollow(page, context) {
    const link = getCreditHeroLink(page);

    console.log(`Clicking "${CREDIT_HERO_LABEL}"...`);

    // Start listening BEFORE the click, or we can miss a fast-opening tab.
    const newTabPromise = context
        .waitForEvent("page", { timeout: NEW_TAB_TIMEOUT })
        .catch(() => null);

    await link.click();

    const newTab = await newTabPromise;

    if (newTab) {
        console.log("CreditHeroScore opened in a new tab.");
        return { page: newTab, openedInNewTab: true };
    }

    console.log("No new tab appeared — CreditHeroScore navigated in the current tab.");
    return { page, openedInNewTab: false };
}

/**
 * ---------------------------------------------------------------------------
 * IS THIS CONTROL ACTUALLY ACTIONABLE?
 *
 * THE PROBLEM THIS SOLVES. A client who never enrolled can be shown a GREY,
 * LOCKED "View CreditHeroScore Account" link: the element exists, the text
 * matches, it is visible, and it has no usable href. Playwright's isEnabled()
 * reports it as ENABLED — that method reasons about form-control disabled state
 * and knows nothing about an anchor with nowhere to go. So the click fires,
 * nothing navigates, three attempts produce three identical failures, and the
 * client is reported as CREDIT_HERO_UNAVAILABLE: a technical fault requiring
 * manual review. The truth is simpler and not a fault at all — there is no
 * account.
 *
 * WHY "NO HREF" IS NOT ON ITS OWN PROOF, AND MUST NOT BE TREATED AS PROOF.
 *
 * This codebase already documents (see getCreditHeroLink above, and
 * openClient.js) that CRC renders HREF-LESS ANCHORS THAT WORK — they carry a
 * JavaScript click handler instead. Treating "no href" alone as "disabled"
 * would therefore declare working, paying clients inactive and message them
 * about lapsed monitoring. That is the single most damaging error available
 * here, and it is worse than the bug being fixed.
 *
 * So the signals are graded:
 *
 *   DEFINITIVE (any one is sufficient, and we do not even click):
 *     aria-disabled="true"   — the page positively asserts it is disabled
 *     disabled attribute     — likewise
 *     pointer-events: none   — the page has made it structurally unclickable
 *
 *   CORROBORATING (never sufficient alone):
 *     an <a> with no usable href — only meaningful once a click has ALSO been
 *     shown not to navigate, on every attempt. That pairing is exactly what
 *     separates a dead link from a working href-less one.
 *
 * Fails OPEN: an unreadable probe returns nothing definitive, and the ordinary
 * click path proceeds unchanged.
 * ---------------------------------------------------------------------------
 */
async function probeActionability(link) {
    return link
        .evaluate((el) => {
            const style = window.getComputedStyle(el);
            const href = el.getAttribute("href");
            const trimmedHref = typeof href === "string" ? href.trim() : "";

            return {
                tag: el.tagName.toLowerCase(),
                // "#" and "javascript:void(0)" are placeholders, not destinations.
                hasUsableHref:
                    trimmedHref !== "" &&
                    trimmedHref !== "#" &&
                    !/^javascript:\s*void/i.test(trimmedHref),
                ariaDisabled: el.getAttribute("aria-disabled") === "true",
                hasDisabledAttribute: el.hasAttribute("disabled"),
                pointerEventsNone: style.pointerEvents === "none",
            };
        })
        .catch(() => null);
}

/** A signal the page itself asserts. Sufficient on its own. */
function definitivelyDisabled(probe) {
    if (!probe) return null;

    if (probe.ariaDisabled) return 'aria-disabled="true"';
    if (probe.hasDisabledAttribute) return "disabled attribute";
    if (probe.pointerEventsNone) return "computed pointer-events: none";

    return null;
}

/** An anchor with nowhere to go. Corroborating only — never sufficient alone. */
function anchorWithoutDestination(probe) {
    return Boolean(probe && probe.tag === "a" && !probe.hasUsableHref);
}

const MAX_OPEN_ATTEMPTS = 3;

// How long to wait for the dashboard to still be there, and for the control to
// become visible and enabled. Both are waits on REAL STATE, not sleeps.
const DASHBOARD_TIMEOUT = 15000;
const CONTROL_TIMEOUT = 15000;

/**
 * ONE attempt at opening CreditHero. Everything is re-located from scratch.
 *
 * ===========================================================================
 * NO STALE LOCATORS BETWEEN ATTEMPTS.
 *
 * A locator captured on attempt 1 may point at a detached node by attempt 2 —
 * the page re-rendered, the link was replaced, the frame swapped. Clicking a
 * detached handle either throws something unhelpful or silently hits nothing,
 * and we would retry against the same dead reference three times and conclude
 * CreditHero was down.
 *
 * So each attempt re-queries the DOM from the page handle. Nothing is carried
 * across.
 * ===========================================================================
 */
async function attemptOpen(page, context, attempt) {
    console.log(`CreditHero open attempt ${attempt}/${MAX_OPEN_ATTEMPTS}...`);

    // ---- 1. VERIFY THE DASHBOARD IS ACTIVE --------------------------------
    //
    // If a previous attempt navigated us somewhere unexpected, clicking blindly
    // would click whatever happens to be under the cursor on a page we have not
    // confirmed. We check we are still where we think we are.
    const dashboardLink = page.getByText(CREDIT_HERO_LABEL, { exact: false }).first();

    const onDashboard = await dashboardLink
        .waitFor({ state: "attached", timeout: DASHBOARD_TIMEOUT })
        .then(() => true)
        .catch(() => false);

    if (!onDashboard) {
        return {
            ok: false,
            reason: `The "${CREDIT_HERO_LABEL}" link is not present — the client dashboard does not appear to be active. Current URL: ${page.url()}`,
        };
    }

    // ---- 2. RE-LOCATE, FRESH ----------------------------------------------
    const link = getCreditHeroLink(page);

    // ---- 3. WAIT UNTIL VISIBLE --------------------------------------------
    try {
        await link.waitFor({ state: "visible", timeout: CONTROL_TIMEOUT });
    } catch {
        return { ok: false, reason: `The "${CREDIT_HERO_LABEL}" control never became visible.` };
    }

    // ---- 4. WAIT UNTIL ENABLED --------------------------------------------
    //
    // Visible is not clickable. CRC renders the control before the dashboard has
    // finished wiring it up, and a click that lands on a not-yet-enabled control
    // is swallowed — no error, no navigation, nothing. That silent no-op is
    // exactly what an intermittent failure looks like.
    const enabled = await link
        .isEnabled({ timeout: CONTROL_TIMEOUT })
        .catch(() => false);

    if (!enabled) {
        return { ok: false, reason: `The "${CREDIT_HERO_LABEL}" control is visible but not enabled.` };
    }

    // ---- 4b. IS IT ACTUALLY ACTIONABLE? -----------------------------------
    //
    // isEnabled() has just returned true for a control that may have nowhere to
    // go. Probe the DOM properties it does not consider.
    const probe = await probeActionability(link);
    const definitive = definitivelyDisabled(probe);

    if (definitive) {
        // The page ASSERTS this control is disabled. Do not click it — clicking
        // a control the page has positively disabled tells us nothing we do not
        // already know, and three of them look like an outage.
        return {
            ok: false,
            nonActionable: true,
            definitive: true,
            probe,
            reason:
                `The "${CREDIT_HERO_LABEL}" control is present but positively disabled ` +
                `(${definitive}). Not clicking it.`,
        };
    }

    const noDestination = anchorWithoutDestination(probe);

    // ---- 5. CLICK AND FOLLOW ----------------------------------------------
    let landed;

    try {
        landed = await clickAndFollow(page, context);
    } catch (error) {
        return { ok: false, reason: `Click failed: ${error.message}` };
    }

    // ---- 6. VERIFY CREDITHERO ACTUALLY OPENED -----------------------------
    //
    // A click landing is not CreditHero opening. Without this we would hand
    // Milestone 6 a handle to the CRC dashboard and every downstream read would
    // fail in a way that looks like Credit Hero being broken.
    try {
        await landed.page.waitForLoadState("load", { timeout: PAGE_LOAD_TIMEOUT });
    } catch {
        return { ok: false, reason: "The page never finished loading after the click." };
    }

    const url = landed.page.url();

    // Still on CRC means the click did nothing. This is the silent no-op above,
    // and it is the failure mode a naive "did we click?" check cannot see.
    if (!landed.openedInNewTab && /app\.creditrepaircloud\.com/i.test(url)) {
        // THE CORROBORATION PAIRS HERE, and only here. An anchor with no
        // destination that ALSO did not navigate is a dead control. An anchor
        // with no destination that DID navigate is CRC's ordinary href-less
        // link working exactly as designed, and never reaches this branch.
        return {
            ok: false,
            nonActionable: noDestination,
            definitive: false,
            probe,
            reason: noDestination
                ? `The "${CREDIT_HERO_LABEL}" control has no usable href and the click did not ` +
                  `navigate — still on CRC (${url}). The control is present but dead.`
                : `The click did not navigate — still on CRC (${url}). The control was likely not yet wired up.`,
        };
    }

    return { ok: true, ...landed };
}

/**
 * Open the CreditHeroScore account from an already-open client dashboard.
 *
 * Milestone 3 ends here: the tab is open, the page has loaded, and we have
 * captured the URL, title, and screenshot. We do not classify the page, infer
 * account status, or click anything.
 *
 * The returned `page` handle is the CreditHeroScore page, so Milestone 4 can
 * adopt it without re-navigating.
 *
 * @param {import('playwright').Page} page    - the open client dashboard
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<{
 *   page: import('playwright').Page,
 *   openedInNewTab: boolean,
 *   currentUrl: string,
 *   pageTitle: string,
 *   screenshotBase64: string
 * }>}
 */
export async function openCreditHero(page, context) {
    const attempts = [];

    // ---- BOUNDED RETRY — READ-ONLY OPERATIONS ONLY --------------------------
    //
    // Retrying is safe HERE and nowhere else, and the reason is not "we approved
    // it": opening CreditHero is READ-ONLY AND IDEMPOTENT. Clicking the link twice
    // costs the client nothing. Nothing is written, ordered, or spent.
    //
    // THIS AUTHORITY DOES NOT GENERALISE. It must never be extended to Save, a
    // Status update, an Order Report, a purchase, or any write — where a retry
    // after an ambiguous outcome is precisely how a client gets charged twice.
    // See the Report Acquisition Authority §5: a run that submits and then crashes
    // leaves no record, and the "safe" retry spends a second entitlement.
    //
    // The boundary is the idempotence of the action, not the convenience of the
    // caller.
    for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt++) {
        const result = await attemptOpen(page, context, attempt);

        if (result.ok) {
            const creditHeroPage = result.page;

            console.log(`CreditHero opened on attempt ${attempt}.`);

            // Milestone 3 discovery scaffolding, preserved. Not my call to remove
            // it in a retry change.
            await creditHeroPage.waitForTimeout(DISCOVERY_SETTLE_MS);

            const currentUrl = creditHeroPage.url();
            const pageTitle = await creditHeroPage.title();

            console.log("CreditHeroScore URL:", currentUrl);
            console.log("CreditHeroScore title:", pageTitle);

            const screenshotBuffer = await creditHeroPage.screenshot();

            return {
                ok: true,                       // <- THE CONTRACT. See below.
                page: creditHeroPage,
                openedInNewTab: result.openedInNewTab,
                currentUrl,
                pageTitle,
                screenshotBase64: screenshotBuffer.toString("base64"),
                attempts: attempt,
                attemptLog: attempts,
            };
        }

        attempts.push({
            attempt,
            reason: result.reason,
            nonActionable: result.nonActionable === true,
            definitive: result.definitive === true,
        });

        console.error(`Attempt ${attempt} failed: ${result.reason}`);

        if (attempt < MAX_OPEN_ATTEMPTS) {
            // Let the dashboard settle before re-locating. We are waiting for CRC
            // to finish whatever it was doing, not padding for luck.
            await page.waitForTimeout(2000);
        }
    }

    // ---- WAS THIS A DEAD CONTROL, OR A GENUINE FAILURE? --------------------
    //
    // EVERY attempt must agree. One attempt finding a dead control while another
    // found a slow page is not agreement — it is an unstable dashboard, and that
    // is a technical failure, not a business state.
    //
    // A single DEFINITIVE attempt is enough on its own: attemptOpen() returns
    // immediately without clicking when the page asserts the control is
    // disabled, so there is nothing further to corroborate.
    const nonActionable =
        attempts.length > 0 &&
        (attempts.some((a) => a.definitive) || attempts.every((a) => a.nonActionable));

    if (nonActionable) {
        return {
            ok: false,
            // A BUSINESS STATE, NOT A FAULT. The caller maps this onto the
            // existing CHS_NOT_ACTIVATED path — the same one the dashboard
            // invite banner already produces — so a client whose control is
            // dead is handled exactly like a client who never enrolled.
            nonActionable: true,
            error_code: "CHS_CONTROL_NOT_ACTIONABLE",
            error:
                `The "${CREDIT_HERO_LABEL}" control is present on the dashboard but is not ` +
                `actionable: every attempt found it either positively disabled, or without a ` +
                `usable destination and unable to navigate. This is an inactive CreditHeroScore ` +
                `account, not a technical failure.`,
            attempts: attempts.length,
            attemptLog: attempts,
            requiresHumanReview: false,
            page: null,
        };
    }

    return {
        ok: false,
        nonActionable: false,
        error_code: "CREDIT_HERO_UNAVAILABLE",
        error:
            `CreditHeroScore could not be opened after ${MAX_OPEN_ATTEMPTS} attempts. Each attempt ` +
            `re-verified the dashboard, re-located the control, and waited for it to be visible and ` +
            `enabled before clicking. Requires human review.`,
        attempts: MAX_OPEN_ATTEMPTS,
        attemptLog: attempts,
        requiresHumanReview: true,
        page: null,
    };
}
