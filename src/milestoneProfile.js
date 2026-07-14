/**
 * milestoneProfile.js
 *
 * Reads the authoritative CRC client identity.
 *
 * Route: POST /read-client-profile   { "clientName": "Elizabeth Kelley" }
 *
 * READ ONLY. This runner imports only crcClientProfile.js, which has no write
 * path. The status writer is a separate module and is NOT imported here — so
 * this endpoint is structurally incapable of modifying a client record.
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { readClientProfile } from "./crcClientProfile.js";
import { verifyIdentity } from "./intelligence/clientIdentity.js";

export async function runProfileRead(data = {}) {
    let browser;

    try {
        const clientName = data.clientName || "Elizabeth Kelley";

        const session = await launchBrowser();
        browser = session.browser;

        const page = session.page;
        const replayUrl = `https://www.browserbase.com/sessions/${session.session.id}`;

        console.log(`Browserbase replay: ${replayUrl}`);

        await loginToCRC(page);

        const client = await openClient(page, clientName);

        if (!client.clientFound || !client.clientOpened) {
            return {
                success: false,
                error_code: "CLIENT_NOT_OPENED",
                error_message: `Could not open client "${clientName}".`,
                replayUrl,
            };
        }

        const profile = await readClientProfile(page, client.crcClientId);

        if (!profile.ok) {
            return {
                success: false,
                readOnly: true,
                fieldsModified: 0,
                error_code: profile.error_code,
                error_message: profile.error,
                missing: profile.missing ?? null,
                partial: profile.partial ?? null,
                crcClientId: client.crcClientId,
                replayUrl,
            };
        }

        // The identity must pass the SAME provenance gate the Letter Engine uses.
        // If it cannot, we find out here — not when a letter fails to generate.
        const verified = verifyIdentity(profile.identity);

        return {
            success: true,
            readOnly: true,
            fieldsModified: 0,

            crcClientId: client.crcClientId,
            identity: profile.identity,

            identityVerified: verified.ok,
            verificationErrors: verified.errors,

            optionalMissing: profile.optionalMissing,
            modalClosed: profile.modalClosed,

            replayUrl,
            timestamp: new Date().toISOString(),
        };

    } catch (error) {
        console.error("Profile read failed:", error);

        return {
            success: false,
            readOnly: true,
            fieldsModified: 0,
            error_code: "PROFILE_READ_ERROR",
            error_message: error.message,
            stack: error.stack,
        };

    } finally {
        if (browser) await browser.close();
    }
}
