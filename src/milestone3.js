import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { openCreditHero } from "./openCreditHero.js";

/**
 * Build the Browserbase replay URL from the session we already have.
 * Derived here rather than in browserbase.js so that module stays untouched.
 */
function buildReplayUrl(sessionId) {
    return `https://www.browserbase.com/sessions/${sessionId}`;
}

export async function runMilestone3(data = {}) {

    let browser;
    let sessionId = null;

    try {

        const clientName = data.clientName || "Elizabeth Kelley";

        console.log(`Starting Milestone 3 for "${clientName}"`);

        const session = await launchBrowser();

        browser = session.browser;
        sessionId = session.session.id;

        const page = session.page;
        const context = session.context;

        await loginToCRC(page);

        const clientResult = await openClient(page, clientName);

        // If the client never opened, there is no dashboard to click through
        // from. Report the reason and stop — do not guess.
        if (!clientResult.clientFound) {
            return successResponse({
                milestone: "M3_OPEN_CREDIT_HERO",
                client_search: clientName,
                client_found: false,
                client_opened: false,
                credit_hero_opened: false,
                current_url: clientResult.currentUrl,
                page_title: clientResult.pageTitle,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
                message: `No matching client found for "${clientName}".`,
            });
        }

        const creditHeroResult = await openCreditHero(page, context);

        // NOTE: credit_hero_opened === true means "the CreditHeroScore page
        // loaded and we captured it" — NOT "the account is active." An inactive
        // account shows a reactivation page, which is a valid, expected outcome
        // of this milestone. We report what loaded; we never act on it.
        return successResponse({
            milestone: "M3_OPEN_CREDIT_HERO",
            client_search: clientName,
            client_found: true,
            client_opened: true,
            client_name: clientResult.clientName,
            client_status: clientResult.clientStatus,
            credit_hero_opened: true,
            opened_in_new_tab: creditHeroResult.openedInNewTab,
            current_url: creditHeroResult.currentUrl,
            page_title: creditHeroResult.pageTitle,
            screenshot_base64: creditHeroResult.screenshotBase64,
            browserbase_session_id: sessionId,
            replay_url: buildReplayUrl(sessionId),
        });

    } catch (error) {

        console.error("Milestone 3 failed:", error.message);

        return errorResponse(
            "MILESTONE_3_ERROR",
            error.message
        );

    } finally {

        if (browser) {

            await browser.close();

        }

    }

}
