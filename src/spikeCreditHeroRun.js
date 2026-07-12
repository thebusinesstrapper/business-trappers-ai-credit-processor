import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { openCreditHero } from "./openCreditHero.js";
import { openCreditReport } from "./openCreditReport.js";
import { discoverCreditHero } from "./spikeCreditHero.js";

/**
 * CREDIT HERO DISCOVERY SPIKE — DISPOSABLE SCAFFOLDING.
 *
 * Reuses the existing navigation capability (M2 openClient, M3 openCreditHero)
 * unchanged, then runs a strictly read-only DOM inspection.
 *
 * This is NOT Milestone 6. It exists to produce the evidence required to freeze
 * the Capture Engine architecture. Delete it once that is done.
 *
 * PERFORMS NO CLICKS beyond those already approved in Milestones 2 and 3:
 *   - the client name link (M2)
 *   - the "View CreditHeroScore Account" link (M3)
 *
 * It clicks NOTHING on the Credit Hero page itself. If the report lives behind
 * a link, the spike lists that link under navigation_candidates for human
 * approval rather than clicking it. Some controls on that page may order a
 * report or reactivate monitoring; we do not discover which by trying them.
 *
 * NOTE: this spike does NOT check eligibility and does NOT touch AI Memory. It
 * is a read-only observation of page structure, nothing more.
 */

function buildReplayUrl(sessionId) {
    return `https://www.browserbase.com/sessions/${sessionId}`;
}

export async function runCreditHeroSpike(data = {}) {

    let browser;
    let sessionId = null;

    try {

        const clientName = data.clientName || "Elizabeth Kelley";

        console.log(`Starting Credit Hero discovery spike for "${clientName}"`);

        const session = await launchBrowser();

        browser = session.browser;
        sessionId = session.session.id;

        const page = session.page;
        const context = session.context;

        await loginToCRC(page);

        const clientResult = await openClient(page, clientName);

        if (!clientResult.clientFound) {
            return successResponse({
                milestone: "SPIKE_CREDIT_HERO",
                client_search: clientName,
                client_found: false,
                discovery: null,
                message: `No matching client found for "${clientName}".`,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        // Reuses M3 unchanged. Lands on the Credit Hero MEMBER DASHBOARD.
        const creditHeroResult = await openCreditHero(page, context);

        // Navigate Member Dashboard -> credit report page.
        //
        // Reported separately from discovery so navigation can be verified on
        // its own merits. If this throws, the error surfaces and NO discovery
        // runs — we do not attempt to parse a page we did not reach.
        const reportResult = await openCreditReport(creditHeroResult.page);

        // Discovery now runs from the REPORT PAGE, not the dashboard. The
        // Capture Engine architecture is frozen against this.
        const discovery = await discoverCreditHero(reportResult.page);

        const reportScreenshot = await reportResult.page.screenshot();

        return successResponse({
            milestone: "SPIKE_CREDIT_HERO",
            client_search: clientName,
            client_found: true,
            crc_client_id: clientResult.crcClientId,

            // Where M3 landed (the dashboard).
            credit_hero_url: creditHeroResult.currentUrl,
            credit_hero_title: creditHeroResult.pageTitle,
            opened_in_new_tab: creditHeroResult.openedInNewTab,

            // Navigation to the report page — verifiable independently.
            report_navigation: {
                report_opened: reportResult.reportOpened,
                report_url: reportResult.reportUrl,
                report_title: reportResult.pageTitle,
            },

            // Screenshot is of the REPORT PAGE, which is what we now care about.
            screenshot_base64: reportScreenshot.toString("base64"),

            discovery,

            browserbase_session_id: sessionId,
            replay_url: buildReplayUrl(sessionId),
        });

    } catch (error) {

        console.error("Credit Hero spike failed:", error.message);

        return errorResponse(
            "SPIKE_CREDIT_HERO_ERROR",
            error.message
        );

    } finally {

        if (browser) {

            await browser.close();

        }

    }

}
