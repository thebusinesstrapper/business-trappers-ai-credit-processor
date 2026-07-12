import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { openCreditHero } from "./openCreditHero.js";
import { openCreditReport } from "./openCreditReport.js";
import {
    captureJsonResponses,
    inventoryReportControls,
    clickViewJson,
} from "./spikeReportJson.js";

/**
 * VIEW JSON DISCOVERY SPIKE — DISPOSABLE SCAFFOLDING.
 *
 * Answers whether the report page's View JSON capability can become the primary
 * Capture Engine input.
 *
 * DEFAULT: fully read-only. Network listeners are attached BEFORE navigation, so
 * if the report page fetches its data as JSON we capture it having touched
 * nothing.
 *
 * OPT-IN: pass { clickViewJson: true } to click the single, named View JSON
 * control. No other control on the report page is ever touched.
 *
 * The order page remains hard-blocked by openCreditReport.js throughout.
 */

function buildReplayUrl(sessionId) {
    return `https://www.browserbase.com/sessions/${sessionId}`;
}

export async function runReportJsonSpike(data = {}) {

    let browser;
    let sessionId = null;

    try {

        const clientName = data.clientName || "Elizabeth Kelley";

        // Explicit opt-in. Defaults to false: the click is approved per-run.
        const shouldClick = data.clickViewJson === true;

        console.log(`Starting View JSON spike for "${clientName}"`);
        console.log(`clickViewJson: ${shouldClick ? "TRUE (one named click)" : "FALSE (fully read-only)"}`);

        const session = await launchBrowser();

        browser = session.browser;
        sessionId = session.session.id;

        const page = session.page;
        const context = session.context;

        await loginToCRC(page);

        const clientResult = await openClient(page, clientName);

        if (!clientResult.clientFound) {
            return successResponse({
                milestone: "SPIKE_REPORT_JSON",
                client_search: clientName,
                client_found: false,
                message: `No matching client found for "${clientName}".`,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        const creditHeroResult = await openCreditHero(page, context);

        // CRITICAL ORDERING: listeners must be attached BEFORE we navigate to
        // the report page, or we miss the very requests we are trying to catch.
        const capturedJson = captureJsonResponses(creditHeroResult.page);

        const reportResult = await openCreditReport(creditHeroResult.page);

        // What arrived without us touching anything.
        const passiveCaptureCount = capturedJson.length;

        const controls = await inventoryReportControls(reportResult.page);

        let clickResult = { clicked: false, reason: "clickViewJson not requested." };

        if (shouldClick) {
            clickResult = await clickViewJson(reportResult.page);
        }

        const screenshot = await reportResult.page.screenshot();

        // Server-returned vs client-side generated: if the payload came down the
        // wire, it is server-returned. If it only appears after a click and no
        // request fired, it is generated in the browser from the DOM — and is
        // therefore no better a source than the DOM itself.
        const jsonAfterClick = capturedJson.length - passiveCaptureCount;

        return successResponse({
            milestone: "SPIKE_REPORT_JSON",
            client_search: clientName,
            client_found: true,
            crc_client_id: clientResult.crcClientId,

            report_url: reportResult.reportUrl,
            report_title: reportResult.pageTitle,

            json_capture: {
                total_json_responses: capturedJson.length,
                captured_passively: passiveCaptureCount,
                captured_after_click: jsonAfterClick,

                origin_verdict:
                    passiveCaptureCount > 0
                        ? "SERVER-RETURNED (payload observed on the wire without any interaction)"
                        : jsonAfterClick > 0
                            ? "SERVER-RETURNED on demand (a request fired when View JSON was clicked)"
                            : "NO JSON OBSERVED ON THE WIRE — likely CLIENT-SIDE generated from the DOM, "
                              + "which would make it no better a source than the DOM itself.",

                responses: capturedJson,
            },

            controls,
            view_json_click: clickResult,

            screenshot_base64: screenshot.toString("base64"),

            browserbase_session_id: sessionId,
            replay_url: buildReplayUrl(sessionId),
        });

    } catch (error) {

        console.error("View JSON spike failed:", error.message);

        return errorResponse(
            "SPIKE_REPORT_JSON_ERROR",
            error.message
        );

    } finally {

        if (browser) {

            await browser.close();

        }

    }

}
