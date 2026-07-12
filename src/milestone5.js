import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { recognizeImportAuditState } from "./importAuditState.js";
import { classifyEligibility } from "./eligibility.js";
import { loadOrCreateClientMemory } from "./clientMemory.js";

/**
 * Milestone 5B — AI Memory Integration.
 *
 * This is Milestone 4 plus memory. The browser automation behaves EXACTLY as it
 * did before: same login, same client open, same Import/Audit recognition, same
 * eligibility decision. Milestone 4 remains frozen and untouched.
 *
 * The only new behavior: after the client dashboard opens, read the client's
 * AI memory record — creating it with Version 1 defaults if this is the first
 * time we have ever seen this client.
 *
 * This milestone performs NO Import, NO Reimport, and does NOT open Credit
 * Hero. It writes NO processing history, NO item history, and advances NO
 * rounds.
 */

function buildReplayUrl(sessionId) {
    return `https://www.browserbase.com/sessions/${sessionId}`;
}

export async function runMilestone5(data = {}) {

    let browser;
    let sessionId = null;

    try {

        // Elizabeth Kelley is the project's baseline regression client.
        // Expected: eligibility not_eligible / existing. On the FIRST run,
        // memory.created = true. On every run after, memory.exists = true.
        const clientName = data.clientName || "Elizabeth Kelley";

        console.log(`Starting Milestone 5 for "${clientName}"`);

        const session = await launchBrowser();

        browser = session.browser;
        sessionId = session.session.id;

        const page = session.page;

        await loginToCRC(page);

        const clientResult = await openClient(page, clientName);

        if (!clientResult.clientFound) {
            return successResponse({
                milestone: "M5_MEMORY",
                client_search: clientName,
                client_found: false,
                client_opened: false,
                eligibility: "manual_review",
                reason: "client_not_found",
                client_type: "unknown",
                memory: { exists: false, created: false },
                current_url: clientResult.currentUrl,
                page_title: clientResult.pageTitle,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        // --- AI Memory: read, or initialize on first sighting. -------------
        //
        // FAILS CLOSED. If we could not derive an authoritative crc_client_id
        // from the dashboard URL, we do NOT write memory. We never substitute
        // the display name as a key — that would collide same-named clients and
        // orphan a client's history if they ever change their name.
        //
        // A memory failure must NOT change eligibility behavior (this milestone
        // is explicitly "no behavior change"), so we record the problem and
        // carry on classifying exactly as Milestone 4 does.

        let memory = { exists: false, created: false };

        if (!clientResult.crcClientId) {
            memory = {
                exists: false,
                created: false,
                error: "crc_client_id_not_derived",
            };
        } else {
            try {
                memory = await loadOrCreateClientMemory(
                    clientResult.crcClientId,
                    clientResult.clientName
                );
            } catch (memoryError) {
                console.error("AI Memory error:", memoryError.message);

                memory = {
                    exists: false,
                    created: false,
                    error: memoryError.message,
                };
            }
        }

        // --- Eligibility: unchanged from Milestone 4. ----------------------

        const { state, observed } = await recognizeImportAuditState(page);

        const decision = classifyEligibility(state);

        console.log(
            `Eligibility: ${decision.eligibility} (${decision.reason}) — client_type: ${decision.client_type}`
        );

        return successResponse({
            milestone: "M5_MEMORY",
            client_search: clientName,
            client_found: true,
            client_opened: true,
            client_name: clientResult.clientName,
            crc_client_id: clientResult.crcClientId,

            eligibility: decision.eligibility,
            reason: decision.reason,
            client_type: decision.client_type,

            memory,

            crc_state: state,
            observed_markers: observed,

            current_url: page.url(),
            page_title: await page.title(),
            browserbase_session_id: sessionId,
            replay_url: buildReplayUrl(sessionId),
        });

    } catch (error) {

        console.error("Milestone 5 failed:", error.message);

        return errorResponse(
            "MILESTONE_5_ERROR",
            error.message
        );

    } finally {

        if (browser) {

            await browser.close();

        }

    }

}
