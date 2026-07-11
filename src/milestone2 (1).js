import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";

export async function runMilestone2(data = {}) {

    let browser;

    try {

        const clientName = data.clientName || "Elizabeth Kelley";

        console.log(`Starting Milestone 2 for "${clientName}"`);

        const session = await launchBrowser();

        browser = session.browser;

        const page = session.page;

        await loginToCRC(page);

        const result = await openClient(page, clientName);

        if (!result.clientFound) {
            return successResponse({
                milestone: "M2_OPEN_CLIENT",
                client_search: clientName,
                client_found: false,
                client_opened: false,
                current_url: result.currentUrl,
                page_title: result.pageTitle,
                message: `No matching client found for "${clientName}".`,
            });
        }

        return successResponse({
            milestone: "M2_OPEN_CLIENT",
            client_search: clientName,
            client_found: true,
            client_opened: true,
            current_url: result.currentUrl,
            page_title: result.pageTitle,
            client_name: result.clientName,
            client_status: result.clientStatus,
        });

    } catch (error) {

        return errorResponse(
            "MILESTONE_2_ERROR",
            error.message
        );

    } finally {

        if (browser) {

            await browser.close();

        }

    }

}
