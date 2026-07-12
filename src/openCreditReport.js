/**
 * openCreditReport.js
 *
 * Responsible ONLY for navigating from the Credit Hero Member Dashboard to the
 * credit report page, and verifying it loaded.
 *
 * It parses NO report content. That is the Capture Engine's job, and the
 * Capture Engine cannot be designed until this navigation is proven.
 *
 * ---------------------------------------------------------------------------
 * SAFETY INVARIANT — THE ORDER PAGE IS FORBIDDEN
 *
 * mcc_order_select_v2.asp is the report ORDER page. Reaching it and interacting
 * with it can order a report and charge the client money. Per the Project
 * Constitution, the AI must never perform an action that could charge a client,
 * never order a new Credit Hero Score report, and never reactivate monitoring.
 *
 * This module therefore treats that URL as a hard, non-negotiable boundary:
 *
 *   1. We NAVIGATE BY URL, NOT BY CLICKING. We read the report link's resolved
 *      href, verify it, and page.goto() it. Clicking would execute whatever
 *      onclick handler Credit Hero attached to that element — and on a page
 *      that sits next door to the order flow, we run no handlers we did not
 *      write.
 *
 *   2. The destination URL is checked BEFORE we navigate.
 *
 *   3. The landed URL is checked AFTER we navigate. This is not paranoia: if no
 *      report is available, Credit Hero may REDIRECT us to the order page. We
 *      would arrive somewhere forbidden without ever having asked to go there.
 *      If that happens we stop immediately and touch nothing.
 *
 *   4. We NEVER construct the report URL ourselves. We know the filename, not
 *      the directory. A guessed path is a guessed navigation, and this project
 *      does not guess. If the link is not on the page, we fail closed.
 * ---------------------------------------------------------------------------
 */

const REPORT_PAGE = "mcc_creditreports_v2.asp";

/**
 * Pages the processor must never navigate to. Not a warning list — a hard stop.
 */
const FORBIDDEN_PAGES = [
    "mcc_order_select_v2.asp", // report ORDER page. Costs the client money.
];

const NAV_TIMEOUT = 60000;
const LINK_TIMEOUT = 20000;

/**
 * Throw if a URL points at a forbidden destination.
 *
 * Called both before navigating and after landing.
 */
function assertUrlIsAllowed(url, stage) {
    const lower = (url || "").toLowerCase();

    for (const forbidden of FORBIDDEN_PAGES) {
        if (lower.includes(forbidden.toLowerCase())) {
            throw new Error(
                `BLOCKED (${stage}): URL points at the forbidden page "${forbidden}". ` +
                `This is the report ORDER page and could charge the client. ` +
                `Navigation refused. URL: ${url}`
            );
        }
    }
}

/**
 * Find the report link and return its RESOLVED ABSOLUTE href.
 *
 * Searches every frame — the Credit Hero dashboard may render its navigation
 * inside an iframe, and a main-frame-only search would silently find nothing.
 *
 * Reading `el.href` (the property, not the attribute) gives the browser's own
 * absolute resolution, so we never have to build a URL ourselves.
 *
 * @returns {Promise<string|null>} absolute URL, or null if the link is absent
 */
async function findReportUrl(page) {
    for (const frame of page.frames()) {
        let href = null;

        try {
            href = await frame.evaluate((reportPage) => {
                const anchors = Array.from(document.querySelectorAll("a[href]"));

                const match = anchors.find((a) =>
                    (a.getAttribute("href") || "").toLowerCase().includes(reportPage.toLowerCase())
                );

                // `.href` is the browser-resolved absolute URL.
                return match ? match.href : null;
            }, REPORT_PAGE);
        } catch {
            // Frame detached or cross-origin. Try the next one.
            continue;
        }

        if (href) {
            console.log(`Found report link in frame: ${frame.url()}`);
            return href;
        }
    }

    return null;
}

/**
 * Navigate from the Credit Hero Member Dashboard to the credit report page.
 *
 * @param {import('playwright').Page} page - the Credit Hero Member Dashboard
 * @returns {Promise<{
 *   reportOpened: boolean,
 *   reportUrl: string,
 *   pageTitle: string,
 *   page: import('playwright').Page
 * }>}
 */
export async function openCreditReport(page) {
    console.log("Locating the credit report link on the Member Dashboard...");

    // Give the dashboard a chance to finish rendering its navigation before we
    // conclude the link is absent. We poll for the link itself — a real state
    // change — rather than sleeping for a fixed period.
    const deadline = Date.now() + LINK_TIMEOUT;

    let reportUrl = null;

    while (Date.now() < deadline) {
        reportUrl = await findReportUrl(page);

        if (reportUrl) break;

        await page.waitForTimeout(250);
    }

    if (!reportUrl) {
        // FAIL CLOSED. Do NOT fall back to constructing a URL from the origin —
        // we know the filename, not the path, and a guessed path is a guessed
        // navigation on a site with an order page on it.
        throw new Error(
            `Could not find a link to "${REPORT_PAGE}" on the Credit Hero Member Dashboard. ` +
            `Refusing to construct the URL. Re-run the discovery spike and review ` +
            `navigation_candidates to identify the correct link.`
        );
    }

    console.log("Resolved report URL:", reportUrl);

    // Guard 1: before we go anywhere.
    assertUrlIsAllowed(reportUrl, "pre-navigation");

    console.log("Navigating to the credit report page...");

    await page.goto(reportUrl, {
        waitUntil: "load",
        timeout: NAV_TIMEOUT,
    });

    const landedUrl = page.url();

    // Guard 2: after landing. Credit Hero may redirect to the ORDER page when
    // no report is available — we would arrive somewhere forbidden without ever
    // having asked to. Stop here, having clicked nothing.
    assertUrlIsAllowed(landedUrl, "post-navigation");

    // Verify we actually arrived where we intended, rather than at some other
    // page that merely was not forbidden.
    if (!landedUrl.toLowerCase().includes(REPORT_PAGE.toLowerCase())) {
        throw new Error(
            `Navigation did not land on the credit report page. ` +
            `Expected a URL containing "${REPORT_PAGE}", got: ${landedUrl}`
        );
    }

    const pageTitle = await page.title();

    console.log("Credit report page loaded.");
    console.log("Report URL:  ", landedUrl);
    console.log("Report title:", pageTitle);

    // No report content is read here. Verification only.
    return {
        reportOpened: true,
        reportUrl: landedUrl,
        pageTitle,
        page,
    };
}
