/**
 * openOrderPage.js
 *
 * Responsible ONLY for navigating from the Credit Hero Member Dashboard to the
 * report ORDER page, so its options can be READ.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE OPENS THE PAGE THAT CAN SPEND THE CLIENT'S MONEY.
 *
 * Per the AI Memory Standard v1.1 Addendum (Report Acquisition Authority), the
 * Version 1 processor may NAVIGATE to and READ this page. It may NEVER:
 *
 *   - select an option
 *   - click submit
 *   - order a report
 *   - consume a free report
 *   - spend money
 *
 * The distinction that matters is not free vs. paid. It is READ vs. SUBMIT.
 * A free report is still a rationed entitlement; consuming one on the client's
 * behalf, unasked, spends something they may have wanted for another purpose.
 * Version 1 recommends. A human acts.
 *
 * Accordingly this module:
 *
 *   1. Navigates by page.goto() on a RESOLVED href — never by clicking. A click
 *      executes whatever onclick handler Credit Hero attached. On THIS page, we
 *      run no handlers we did not write.
 *
 *   2. Never constructs the URL. We read the link's browser-resolved absolute
 *      href off the dashboard. If the link is absent, we FAIL CLOSED rather than
 *      guessing a path into a checkout flow.
 *
 *   3. Contains ZERO interaction calls. No click, fill, check, selectOption,
 *      press, or tap. Not on any element. This is verifiable by grep, and it
 *      should be verified.
 *
 * NOTE ON RESIDUAL RISK: the page is named "order_select", and selection pages
 * do not normally charge on load. But that is an inference, not a proof. Merely
 * loading this page is the smallest action that could possibly answer the
 * question, and a human should review the resulting screenshot before any code
 * is ever written that touches a control here.
 * ---------------------------------------------------------------------------
 *
 * This module does NOT weaken the hard block in openCreditReport.js. That block
 * guards against UNINTENDED ARRIVAL (e.g. Credit Hero redirecting us here when
 * no report exists). This module is DELIBERATE, OPTED-IN arrival for the sole
 * purpose of reading. Two doors, two keys.
 */

const ORDER_PAGE = "mcc_order_select_v2.asp";

const NAV_TIMEOUT = 60000;
const LINK_TIMEOUT = 20000;

/**
 * Find the order-page link and return its RESOLVED ABSOLUTE href.
 *
 * Searches every frame. Reading `el.href` (the property, not the attribute)
 * gives the browser's own absolute resolution, so we never build a URL.
 */
async function findOrderPageUrl(page) {
    for (const frame of page.frames()) {
        let href = null;

        try {
            href = await frame.evaluate((orderPage) => {
                const anchors = Array.from(document.querySelectorAll("a[href]"));

                const match = anchors.find((a) =>
                    (a.getAttribute("href") || "").toLowerCase().includes(orderPage.toLowerCase())
                );

                return match ? match.href : null;
            }, ORDER_PAGE);
        } catch {
            continue; // detached or cross-origin frame
        }

        if (href) {
            console.log(`Found order-page link in frame: ${frame.url()}`);
            return href;
        }
    }

    return null;
}

/**
 * Navigate to the report order page for READ-ONLY inspection.
 *
 * @param {import('playwright').Page} page - the Credit Hero Member Dashboard
 * @returns {Promise<{ orderPageOpened: boolean, orderPageUrl: string, pageTitle: string, page: object }>}
 */
export async function openOrderPage(page) {
    console.log("Locating the order-page link on the Member Dashboard...");
    console.log("READ-ONLY: this module will not select, submit, or order anything.");

    const deadline = Date.now() + LINK_TIMEOUT;

    let orderUrl = null;

    while (Date.now() < deadline) {
        orderUrl = await findOrderPageUrl(page);

        if (orderUrl) break;

        await page.waitForTimeout(250);
    }

    if (!orderUrl) {
        // FAIL CLOSED. Do not construct a URL into a checkout flow.
        throw new Error(
            `Could not find a link to "${ORDER_PAGE}" on the Credit Hero Member Dashboard. ` +
            `Refusing to construct the URL. Review the dashboard discovery output ` +
            `(navigation_candidates) to identify the correct link.`
        );
    }

    console.log("Resolved order-page URL:", orderUrl);
    console.log("Navigating (goto, not click — no onclick handlers will run)...");

    await page.goto(orderUrl, {
        waitUntil: "load",
        timeout: NAV_TIMEOUT,
    });

    const landedUrl = page.url();

    if (!landedUrl.toLowerCase().includes(ORDER_PAGE.toLowerCase())) {
        throw new Error(
            `Navigation did not land on the order page. ` +
            `Expected a URL containing "${ORDER_PAGE}", got: ${landedUrl}`
        );
    }

    const pageTitle = await page.title();

    console.log("Order page loaded (read-only).");
    console.log("Order page URL:  ", landedUrl);
    console.log("Order page title:", pageTitle);

    return {
        orderPageOpened: true,
        orderPageUrl: landedUrl,
        pageTitle,
        page,
    };
}
