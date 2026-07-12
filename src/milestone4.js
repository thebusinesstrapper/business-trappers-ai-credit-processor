import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { recognizeImportAuditState } from "./importAuditState.js";
import { classifyEligibility } from "./eligibility.js";

/**
 * Milestone 4 — Eligibility Validation Engine.
 *
 * Determines ONLY whether a client should continue processing.
 *
 * This milestone performs NO Import, NO Reimport, and does NOT open Credit
 * Hero. It classifies and stops. Acting on the classification is Milestone 5's
 * job, and Milestone 5 runs only when this returns "eligible".
 */

/**
 * Build the Browserbase replay URL from the session we already have.
 * Derived here rather than in browserbase.js so that module stays untouched.
 */
function buildReplayUrl(sessionId) {
    return `https://www.browserbase.com/sessions/${sessionId}`;
}

export async function runMilestone4(data = {}) {

    let browser;
    let sessionId = null;

    try {

        // Elizabeth Kelley is the project's baseline regression client.
        // Expected result: not_eligible / existing ("New Report available in
        // 30 days"). A different result is a regression unless the business
        // rules intentionally changed.
        const clientName = data.clientName || "Elizabeth Kelley";

        console.log(`Starting Milestone 4 for "${clientName}"`);

        const session = await launchBrowser();

        browser = session.browser;
        sessionId = session.session.id;

        const page = session.page;

        await loginToCRC(page);

        const clientResult = await openClient(page, clientName);

        // No client, no dashboard, no Import/Audit tab. Report and stop —
        // do not guess at eligibility for a client we never opened.
        if (!clientResult.clientFound) {
            return successResponse({
                milestone: "M4_ELIGIBILITY",
                client_search: clientName,
                client_found: false,
                client_opened: false,
                eligibility: "manual_review",
                reason: "client_not_found",
                client_type: "unknown",
                current_url: clientResult.currentUrl,
                page_title: clientResult.pageTitle,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        // 1. Recognize what CRC is showing (UI fact).
        const { state, observed } = await recognizeImportAuditState(page);

        // 2. Map that fact to a business decision (Business Trappers rule).
        const decision = classifyEligibility(state);

        console.log(
            `Eligibility: ${decision.eligibility} (${decision.reason}) — client_type: ${decision.client_type}`
        );

        return successResponse({
            milestone: "M4_ELIGIBILITY",
            client_search: clientName,
            client_found: true,
            client_opened: true,
            client_name: clientResult.clientName,
            eligibility: decision.eligibility,
            reason: decision.reason,
            client_type: decision.client_type,

            // Recognition detail, kept separate from the decision. Useful for
            // debugging a misclassification without re-running the browser.
            crc_state: state,
            observed_markers: observed,

            current_url: page.url(),
            page_title: await page.title(),
            browserbase_session_id: sessionId,
            replay_url: buildReplayUrl(sessionId),
        });

    } catch (error) {

        console.error("Milestone 4 failed:", error.message);

        return errorResponse(
            "MILESTONE_4_ERROR",
            error.message
        );

    } finally {

        if (browser) {

            await browser.close();

        }

    }

}
