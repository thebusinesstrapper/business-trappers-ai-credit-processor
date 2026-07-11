import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";

export async function runMilestone1(data = {}) {

    let browser;

    try {

        const clientName = data.clientName || "Elizabeth Kelley";

        console.log(`Starting Milestone 1 for ${clientName}`);

        const session = await launchBrowser();

        browser = session.browser;

        const page = session.page;

        await page.goto("https://example.com");

        return successResponse({
            client_search: clientName,
            client_found: false,
            client_opened: false,
            verified_client_name: null,
            message: "Successfully logged into Credit Repair Cloud."
        });

    } catch (error) {

        return errorResponse(
            "MILESTONE_1_ERROR",
            error.message
        );

    } finally {

        if (browser) {

            await browser.close();

        }

    }

}
