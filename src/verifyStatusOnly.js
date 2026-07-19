/**
 * verifyStatusOnly.js
 *
 * TEMPORARY, LOCKED STATUS-ONLY VERIFICATION.
 *
 * Exact allowed action:
 *   Elizabeth Kelley / CRC Client ID 15
 *   Client -> Waiting For Bureau
 *
 * This module cannot compose messages, upload files, send messages, generate
 * PDFs, or write client memory because it imports none of those capabilities.
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { getCrcClientId } from "./crcClientId.js";
import { updateClientStatus } from "./crcClientStatus.js";

const TEST_CLIENT_NAME = "Elizabeth Kelley";
const TEST_CLIENT_ID = "15";
const TARGET_STATUS = "Waiting For Bureau";

export async function runStatusOnlyVerification(data = {}) {
    let browser;

    try {
        if (data.statusOnlyApproved !== true) {
            return {
                ok: false,
                milestone: "STATUS_ONLY_VERIFICATION",
                blockedReason: "status_only_approval_required",
                message:
                    'Set "statusOnlyApproved": true to authorize the isolated Elizabeth/15 status test.',
            };
        }

        if (data.clientName !== TEST_CLIENT_NAME) {
            return {
                ok: false,
                milestone: "STATUS_ONLY_VERIFICATION",
                blockedReason: "test_client_name_mismatch",
                expectedClientName: TEST_CLIENT_NAME,
            };
        }

        if (data.targetStatus && data.targetStatus !== TARGET_STATUS) {
            return {
                ok: false,
                milestone: "STATUS_ONLY_VERIFICATION",
                blockedReason: "target_status_not_allowed",
                expectedTargetStatus: TARGET_STATUS,
            };
        }

        const session = await launchBrowser();
        browser = session.browser;
        const page = session.page;

        await loginToCRC(page);

        const opened = await openClient(page, TEST_CLIENT_NAME);

        if (!opened?.clientFound || opened?.clientOpened === false) {
            return {
                ok: false,
                milestone: "STATUS_ONLY_VERIFICATION",
                blockedReason: "client_not_opened",
                clientName: TEST_CLIENT_NAME,
                openClientResult: opened ?? null,
            };
        }

        const crcClientId = String(await getCrcClientId(page));

        if (crcClientId !== TEST_CLIENT_ID) {
            return {
                ok: false,
                milestone: "STATUS_ONLY_VERIFICATION",
                blockedReason: "crc_client_id_mismatch",
                expectedCrcClientId: TEST_CLIENT_ID,
                observedCrcClientId: crcClientId,
            };
        }

        const statusResult = await updateClientStatus(
            page,
            TEST_CLIENT_ID,
            TARGET_STATUS,
            { processingCycleComplete: true }
        );

        return {
            milestone: "STATUS_ONLY_VERIFICATION",
            tool: "BT-STATUS-ONLY-1.0",
            clientName: TEST_CLIENT_NAME,
            crcClientId: TEST_CLIENT_ID,
            targetStatus: TARGET_STATUS,
            messageComposerOpened: false,
            attachmentsUploaded: false,
            messageSubmitted: false,
            currentRoundWritten: false,
            otherClientsTouched: false,
            ...statusResult,
        };
    } catch (error) {
        return {
            ok: false,
            milestone: "STATUS_ONLY_VERIFICATION",
            error_code: "STATUS_ONLY_UNHANDLED_ERROR",
            error: error.message,
            clientName: TEST_CLIENT_NAME,
            crcClientId: TEST_CLIENT_ID,
            messageSubmitted: false,
            currentRoundWritten: false,
            otherClientsTouched: false,
        };
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}
