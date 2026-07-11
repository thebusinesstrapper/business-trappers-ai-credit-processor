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
    const { page: creditHeroPage, openedInNewTab } = await clickAndFollow(page, context);

    console.log("Waiting for the CreditHeroScore page to load...");

    await creditHeroPage.waitForLoadState("load", { timeout: PAGE_LOAD_TIMEOUT });

    // TEMPORARY — Milestone 3 discovery scaffolding. See DISCOVERY_SETTLE_MS
    // above. Remove in Milestone 4 once we know the real readiness signal.
    await creditHeroPage.waitForTimeout(DISCOVERY_SETTLE_MS);

    const currentUrl = creditHeroPage.url();
    const pageTitle = await creditHeroPage.title();

    console.log("CreditHeroScore page loaded.");
    console.log("CreditHeroScore URL:", currentUrl);
    console.log("CreditHeroScore title:", pageTitle);

    console.log("Capturing screenshot...");

    // Viewport-only (not fullPage) to keep the base64 payload small enough to
    // travel comfortably in the JSON response over Railway and into n8n.
    // The viewport is 1440x900 (see playwright.config.js), which is enough to
    // show whether we landed on the account or the reactivation page — the one
    // question this milestone exists to answer.
    const screenshotBuffer = await creditHeroPage.screenshot();

    return {
        page: creditHeroPage,
        openedInNewTab,
        currentUrl,
        pageTitle,
        screenshotBase64: screenshotBuffer.toString("base64"),
    };
}
