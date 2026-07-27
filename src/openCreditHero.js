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

import { recognizeCreditHeroLanding, CH_LANDING_STATE, recognizeCrcCredentialModal } from "./creditHeroLandingState.js";

// How long to give CRC to spawn a new tab after the click before we conclude
// it navigated in the current tab instead.
const NEW_TAB_TIMEOUT = 15000;

// How long to wait for the CreditHeroScore page to reach the "load" state.
const PAGE_LOAD_TIMEOUT = 60000;

/**
 * How long the adopted page may take to POSITIVELY leave the CRC host and be a
 * live CreditHero page before we give up and fail closed. Short: the load-state
 * wait above already elapsed, so the URL is expected to have settled; this only
 * absorbs a brief post-load redirect from the CRC domain to CreditHero.
 */
const CH_CONFIRM_TIMEOUT_MS = 8000;
const CH_CONFIRM_POLL_MS = 250;

/**
 * The CRC host. Reused verbatim from the existing same-tab guard below. A page
 * still on this host is, by definition, NOT CreditHero.
 */
const CRC_HOST_PATTERN = /app\.creditrepaircloud\.com/i;

/**
 * POSITIVE CreditHero URL evidence — the exact .asp paths the system already
 * trusts as CreditHero-owned, sourced verbatim from other modules. No host is
 * invented:
 *   - mcc_creditreports_v2.asp  openCreditReport.js REPORT_PAGE (the report page)
 *   - mcc_order_select_v2.asp   openCreditReport.js FORBIDDEN_PAGES (the order page)
 *   - mcc_creditscores.asp      the CreditHero dashboard landing page openCreditHero
 *                               lands on (milestone6.js / orderFreeReport.js)
 *   - customer_login.asp        creditHeroLandingState.js AUTH link
 *   - payment_update.asp        creditHeroLandingState.js PAYMENT form
 *   - mcc_home.asp              the CreditHero member dashboard landing
 *
 * These live under CreditHero's cp6 application; a URL carrying any of them is a
 * CreditHero page. This is ONE of two accepted positive signals — see below.
 */
const CH_URL_PATH_PATTERN =
    /(mcc_creditreports_v2|mcc_order_select_v2|mcc_creditscores|mcc_home|customer_login|payment_update)\.asp/i;

/**
 * URLs that are never a confirmed page, whatever else is true: blank tabs, empty
 * strings, and browser error pages. about:blank is the specific Mary case — a
 * new tab that opened and never completed navigation.
 */
const NON_PAGE_URL_PATTERN = /^(about:blank|about:blank#|chrome-error:|chrome:|data:|edge-error:)/i;

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
 * DIAGNOSTIC ONLY. Which of getCreditHeroLink's three strategies actually
 * matched, reported without changing how the click target is resolved. Counts
 * are read independently; the click still uses getCreditHeroLink().first()
 * exactly as before.
 */
async function whichLocatorMatched(page) {
    const byRole = await page
        .getByRole("link", { name: CREDIT_HERO_PATTERN })
        .count()
        .catch(() => 0);
    if (byRole > 0) return "role_link";

    const byAnchorText = await page
        .locator("a", { hasText: CREDIT_HERO_PATTERN })
        .count()
        .catch(() => 0);
    if (byAnchorText > 0) return "anchor_text";

    const byText = await page
        .getByText(CREDIT_HERO_LABEL, { exact: true })
        .count()
        .catch(() => 0);
    if (byText > 0) return "text_fallback";

    return "none";
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

                // ---- DIAGNOSTIC-ONLY FIELDS (not consulted by any decision) ---
                // Raw values are captured here and SANITIZED in JS below; the raw
                // href/onclick never leave the page unredacted.
                rawHref: typeof href === "string" ? href : null,
                target: el.getAttribute("target"),
                role: el.getAttribute("role"),
                hasOnclick:
                    el.hasAttribute("onclick") ||
                    typeof el.onclick === "function",
                visibleText: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
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

/**
 * Strip a URL down to scheme + host + path for diagnostics. Query string (which
 * carries tGUID and other tokens) and hash are dropped. Non-URL strings like
 * "about:blank" and "chrome-error://…" pass through unchanged but truncated.
 */
function sanitizeUrl(value) {
    if (typeof value !== "string" || value === "") return null;

    // Non-http(s) schemes (about:, chrome-error:, data:, edge-error:) parse in a
    // way that loses their meaning (URL("about:blank").pathname === "blank"), so
    // keep them as-is with the query dropped — that is exactly the diagnostic
    // signal we need for a blank/error tab.
    if (!/^https?:/i.test(value)) {
        return value.split("?")[0].slice(0, 120);
    }

    try {
        const u = new URL(value);
        // origin + pathname only — never search or hash.
        return `${u.origin}${u.pathname}`;
    } catch {
        return value.split("?")[0].slice(0, 120);
    }
}

/** Drop the query string / GUID from an href attribute for diagnostics. */
function sanitizeHref(rawHref) {
    if (typeof rawHref !== "string" || rawHref.trim() === "") return null;
    return rawHref.split("?")[0].split("#")[0].slice(0, 120);
}

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

    // DIAGNOSTIC ONLY — captured before the click so the control's own shape is
    // recorded even if the click then navigates. Failure here never affects the
    // attempt; diagnostics default to null.
    const locatorStrategy = await whichLocatorMatched(page).catch(() => null);
    const originUrlBeforeClick = sanitizeUrl(page.url());

    try {
        landed = await clickAndFollow(page, context);
    } catch (error) {
        return {
            ok: false,
            reason: `Click failed: ${error.message}`,
            diagnostics: {
                locatorStrategy,
                originUrlBeforeClick,
                newPageEventFired: null,
                returnedPageClosed: null,
                finalUrl: null,
                originUrlAfterClick: sanitizeUrl(page.url()),
                controlTag: probe?.tag ?? null,
                controlHref: sanitizeHref(probe?.rawHref),
                controlTarget: probe?.target ?? null,
                controlRole: probe?.role ?? null,
                controlHasOnclick: probe?.hasOnclick ?? null,
                controlVisibleText: probe?.visibleText ?? null,
            },
        };
    }

    // A "page" event firing == CreditHero attempted a new tab. clickAndFollow
    // reports this via openedInNewTab. Reading the returned page's URL and
    // closed-state is diagnostic and must never throw.
    const returnedPageClosed = landed?.page ? landed.page.isClosed() : null;
    const finalUrl = landed?.page && !returnedPageClosed
        ? sanitizeUrl(landed.page.url())
        : null;

    const diagnostics = {
        // Q1: did a new page (tab/popup) event fire on this click?
        newPageEventFired: landed?.openedInNewTab ?? null,
        // Q2/Q3: the URL of the page we followed to, sanitized.
        finalUrl,
        // The ORIGINAL page's URL after the click (did IT navigate / stay on CRC?)
        originUrlAfterClick: sanitizeUrl(page.url()),
        originUrlBeforeClick,
        // Q3: was the followed page already closed?
        returnedPageClosed,
        // Q4/Q10: the control's own shape.
        controlTag: probe?.tag ?? null,
        controlHref: sanitizeHref(probe?.rawHref),
        controlTarget: probe?.target ?? null,
        controlRole: probe?.role ?? null,
        controlHasOnclick: probe?.hasOnclick ?? null,
        controlVisibleText: probe?.visibleText ?? null,
        // Which strategy matched the control.
        locatorStrategy,
    };

    // ---- 6. VERIFY CREDITHERO ACTUALLY OPENED -----------------------------
    //
    // A click landing is not CreditHero opening. Without this we would hand
    // Milestone 6 a handle to the CRC dashboard and every downstream read would
    // fail in a way that looks like Credit Hero being broken.
    try {
        await landed.page.waitForLoadState("load", { timeout: PAGE_LOAD_TIMEOUT });
    } catch {
        return {
            ok: false,
            reason: "The page never finished loading after the click.",
            diagnostics,
        };
    }

    const url = landed.page.url();

    // Still on CRC means the click did nothing. This is the silent no-op above,
    // and it is the failure mode a naive "did we click?" check cannot see.
    if (!landed.openedInNewTab && CRC_HOST_PATTERN.test(url)) {
        // THE CORROBORATION PAIRS HERE, and only here. An anchor with no
        // destination that ALSO did not navigate is a dead control. An anchor
        // with no destination that DID navigate is CRC's ordinary href-less
        // link working exactly as designed, and never reaches this branch.
        return {
            ok: false,
            nonActionable: noDestination,
            definitive: false,
            probe,
            diagnostics,
            reason: noDestination
                ? `The "${CREDIT_HERO_LABEL}" control has no usable href and the click did not ` +
                  `navigate — still on CRC (${url}). The control is present but dead.`
                : `The click did not navigate — still on CRC (${url}). The control was likely not yet wired up.`,
        };
    }

    // ---- 7. POSITIVELY CONFIRM CREDITHERO OPENED --------------------------
    //
    // WHY THIS EXISTS. The CRC-host guard above only runs on the SAME-TAB
    // branch (!openedInNewTab). When CreditHero opens in a NEW TAB, that guard
    // was skipped entirely, so a new tab that opened but never reached
    // CreditHero — blank, an interstitial, opened-then-stalled, or opened and
    // immediately closed — returned ok:true with a page that is not CreditHero.
    // Milestone 6 adopted it, every downstream read failed SOFT, and the run
    // drifted into the acquisition poll until the Browserbase session timed out.
    // That is the Mary Battie 5:14 timeout, and about:blank never completing
    // navigation is a leading explanation for it.
    //
    // "NOT ON CRC" IS NOT ENOUGH — about:blank is off-CRC but is not CreditHero.
    // We require POSITIVE CreditHero evidence, from signals already trusted in
    // this codebase, and we poll within a bounded wait so a briefly-blank tab
    // that COMPLETES navigation to CreditHero is accepted rather than rejected.
    //
    // ACCEPTED when the page is live (not closed, not blank/error, not on CRC)
    // AND either:
    //   (a) its URL carries a known CreditHero .asp path (CH_URL_PATH_PATTERN);
    //       this catches the healthy dashboard, the report page, the order page
    //       and the login/payment pages by their own trusted URLs; OR
    //   (b) recognizeCreditHeroLanding() — the SAME read-only recognizer M6 runs
    //       on this page moments later — returns a NAMED state
    //       (HEALTHY_MEMBER_DASHBOARD / CREDENTIALS_OR_AUTH_FAILED /
    //       PAYMENT_REQUIRED). This catches a CreditHero page whose URL path we
    //       did not enumerate, by its content.
    //
    // The OR is deliberate: a healthy dashboard returns UNKNOWN from the content
    // recognizer unless it hits >=2 markers, but its URL is a cp6/*.asp path, so
    // signal (a) confirms it. Neither signal fires for about:blank.
    const confirmDeadline = Date.now() + CH_CONFIRM_TIMEOUT_MS;
    let confirmed = false;

    while (Date.now() < confirmDeadline) {
        if (landed.page.isClosed()) {
            return {
                ok: false,
                error_code: "CREDIT_HERO_PAGE_NOT_CONFIRMED",
                reason:
                    `The "${CREDIT_HERO_LABEL}" tab opened but was closed before CreditHero could ` +
                    `be confirmed. Failing closed rather than adopting a dead page.`,
                diagnostics,
            };
        }

        const currentUrl = landed.page.url() || "";

        // A live, CreditHero-looking URL is sufficient on its own.
        const urlIsCreditHero =
            currentUrl !== "" &&
            !NON_PAGE_URL_PATTERN.test(currentUrl) &&
            !CRC_HOST_PATTERN.test(currentUrl) &&
            CH_URL_PATH_PATTERN.test(currentUrl);

        if (urlIsCreditHero) {
            confirmed = true;
            break;
        }

        // Otherwise, if the page has settled onto SOMETHING that is not blank,
        // not an error page and not CRC, ask the content recognizer. Only then —
        // running it on a blank page is pointless and running it on CRC would be
        // reading the wrong tab.
        const settledOffCrc =
            currentUrl !== "" &&
            !NON_PAGE_URL_PATTERN.test(currentUrl) &&
            !CRC_HOST_PATTERN.test(currentUrl);

        if (settledOffCrc) {
            const landing = await recognizeCreditHeroLanding(landed.page).catch(() => null);

            if (
                landing &&
                landing.state &&
                landing.state !== CH_LANDING_STATE.UNKNOWN
            ) {
                confirmed = true;
                break;
            }
        }

        await landed.page.waitForTimeout(CH_CONFIRM_POLL_MS);
    }

    if (!confirmed) {
        return {
            ok: false,
            error_code: "CREDIT_HERO_PAGE_NOT_CONFIRMED",
            reason:
                `The "${CREDIT_HERO_LABEL}" control was clicked but the resulting page never showed ` +
                `positive CreditHero evidence (a known CreditHero URL path or a recognized CreditHero ` +
                `page state) within the wait. Failing closed — the run does not read a report, decide ` +
                `freshness, or enter acquisition on an unconfirmed page.`,
            diagnostics,
        };
    }

    return { ok: true, ...landed, diagnostics };
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
            // DIAGNOSTIC ONLY — the full object, untruncated. Present on every
            // post-click return; null on the pre-click early exits (control not
            // present/visible/enabled), which is itself informative.
            diagnostics: result.diagnostics ?? null,
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

    // A recognized CRC "Login Credentials no longer valid" modal is an INACTIVE
    // business state, not a technical fault. Check the CRC page for the exact
    // marker BEFORE returning the generic CREDIT_HERO_UNAVAILABLE fault. When
    // present, the caller routes it into the existing inactive workflow (mapped
    // onto CREDENTIALS_OR_AUTH_FAILED), never Manual Review.
    const credentialModal = await recognizeCrcCredentialModal(page).catch(() => ({ inactive: false }));
    if (credentialModal.inactive) {
        return {
            ok: false,
            nonActionable: true,
            // Mapped by M6 onto the existing inactive path.
            error_code: "CREDENTIALS_OR_AUTH_FAILED",
            requiresInactiveWorkflow: true,
            error:
                "CRC reports the client's Credit Hero Score login credentials are no longer valid " +
                "(Login Credentials modal). Credit monitoring is inactive — routed to the existing " +
                "inactive workflow, not manual review.",
            evidence: credentialModal.evidence,
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
