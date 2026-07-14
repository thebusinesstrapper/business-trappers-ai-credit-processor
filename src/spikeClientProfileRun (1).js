/**
 * spikeClientProfileRun.js
 *
 * Orchestrates the read-only CRC client profile discovery spike.
 *
 * Route: POST /spike-client-profile
 * Body:  { "clientName": "Elizabeth Kelley" }   (optional; defaults below)
 *
 * Reuses the proven M1/M2 path — login -> Clients -> open client — then reads.
 * It writes nothing, submits nothing, and guesses no selectors.
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { spikeClientProfile } from "./spikeClientProfile.js";

// The client we are validating against. Ground truth is supplied so the spike
// can PROVE it reached the right page, rather than reporting a confident
// inventory of the wrong one.
const DEFAULT_CLIENT_NAME = "Elizabeth Kelley";
const EXPECTED_CRC_CLIENT_ID = "15";

const GROUND_TRUTH = {
    firstName: "Elizabeth",
    middleName: "Suzanne",
    lastName: "Kelley",
    address: "5084 Louvinia Dr",
    city: "Tallahassee",
    state: "FL",
    zip: "32311",
};

export async function runClientProfileSpike(data = {}) {
    let browser;

    try {
        const clientName = data.clientName || DEFAULT_CLIENT_NAME;

        const session = await launchBrowser();
        browser = session.browser;

        const page = session.page;
        const replayUrl = `https://www.browserbase.com/sessions/${session.session.id}`;

        console.log(`Browserbase replay: ${replayUrl}`);

        // ---- Login and open the client ------------------------------------
        await loginToCRC(page);

        const client = await openClient(page, clientName);

        if (!client.clientFound || !client.clientOpened) {
            return {
                success: false,
                spike: "CRC_CLIENT_PROFILE_DISCOVERY",
                readOnly: true,
                error_code: "CLIENT_NOT_OPENED",
                error_message: `Could not open client "${clientName}".`,
                client,
                replayUrl,
                timestamp: new Date().toISOString(),
            };
        }

        console.log(`Client opened. CRC client ID: ${client.crcClientId}`);

        // ---- Confirm we are on the RIGHT client ----------------------------
        //
        // The whole spike is worthless if it inventories the wrong client's
        // profile — worse than worthless, because it would look correct. We
        // report the mismatch rather than proceeding on a name match alone.
        const clientIdMatches = String(client.crcClientId) === EXPECTED_CRC_CLIENT_ID;

        if (!clientIdMatches) {
            console.log(
                `WARNING: expected CRC client ID ${EXPECTED_CRC_CLIENT_ID}, ` +
                    `opened ${client.crcClientId}. Ground truth will not apply.`
            );
        }

        // ---- Discover ------------------------------------------------------
        const discovery = await spikeClientProfile(page, {
            groundTruth: clientIdMatches ? GROUND_TRUTH : null,
        });

        return {
            success: true,
            spike: "CRC_CLIENT_PROFILE_DISCOVERY",
            readOnly: true,
            writesPerformed: 0,

            crcClientId: client.crcClientId,
            expectedCrcClientId: EXPECTED_CRC_CLIENT_ID,
            crcClientIdMatches: clientIdMatches,
            clientName: client.clientName,
            clientSearch: clientName,

            discovery,

            replayUrl,
            timestamp: new Date().toISOString(),
        };

    } catch (error) {
        console.error("CRC profile spike failed:", error);

        return {
            success: false,
            spike: "CRC_CLIENT_PROFILE_DISCOVERY",
            readOnly: true,
            error_code: "SPIKE_ERROR",
            error_message: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
        };

    } finally {
        if (browser) {
            await browser.close();
        }
    }
}
