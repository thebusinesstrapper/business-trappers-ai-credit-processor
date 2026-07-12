import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { openCreditHero } from "./openCreditHero.js";
import { openOrderPage } from "./openOrderPage.js";
import { discoverOrderPage } from "./spikeOrderPage.js";

/**
 * ORDER PAGE DISCOVERY SPIKE — DISPOSABLE SCAFFOLDING.
 *
 * Reuses M2 (openClient) and M3 (openCreditHero) unchanged, deliberately opens
 * the report ORDER page, and reads its structure.
 *
 * READ-ONLY. Per the AI Memory Standard v1.1 Addendum, Version 1 may determine
 * report availability and recommend acquisition. It shall NEVER select an
 * option, submit an order, consume a free report, or spend money.
 *
 * Clicks performed by this run, in total:
 *   - the client name link (M2, previously approved)
 *   - the "View CreditHeroScore Account" link (M3, previously approved)
 *
 * Clicks performed ON THE ORDER PAGE: none. Navigation to it is by goto().
 */

function buildReplayUrl(sessionId) {
    return `https://www.browserbase.com/sessions/${sessionId}`;
}

export async function runOrderPageSpike(data = {}) {

    let browser;
    let sessionId = null;

    try {

        const clientName = data.clientName || "Elizabeth Kelley";

        console.log(`Starting Order Page discovery spike for "${clientName}"`);

        const session = await launchBrowser();

        browser = session.browser;
        sessionId = session.session.id;

        const page = session.page;
        const context = session.context;

        await loginToCRC(page);

        const clientResult = await openClient(page, clientName);

        if (!clientResult.clientFound) {
            return successResponse({
                milestone: "SPIKE_ORDER_PAGE",
                client_search: clientName,
                client_found: false,
                discovery: null,
                message: `No matching client found for "${clientName}".`,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        // M3, unchanged. Lands on the Credit Hero Member Dashboard.
        const creditHeroResult = await openCreditHero(page, context);

        // Deliberate, opted-in navigation to the order page. Read-only.
        const orderPageResult = await openOrderPage(creditHeroResult.page);

        const discovery = await discoverOrderPage(orderPageResult.page);

        const screenshot = await orderPageResult.page.screenshot();

        return successResponse({
            milestone: "SPIKE_ORDER_PAGE",
            client_search: clientName,
            client_found: true,
            crc_client_id: clientResult.crcClientId,

            order_page: {
                opened: orderPageResult.orderPageOpened,
                url: orderPageResult.orderPageUrl,
                title: orderPageResult.pageTitle,
            },

            screenshot_base64: screenshot.toString("base64"),

            discovery,

            // Invariant, asserted in the response itself. Version 1 has no code
            // path that can set these true.
            submitted: false,
            selected_any_option: false,

            browserbase_session_id: sessionId,
            replay_url: buildReplayUrl(sessionId),
        });

    } catch (error) {

        console.error("Order page spike failed:", error.message);

        return errorResponse(
            "SPIKE_ORDER_PAGE_ERROR",
            error.message
        );

    } finally {

        if (browser) {

            await browser.close();

        }

    }

}
