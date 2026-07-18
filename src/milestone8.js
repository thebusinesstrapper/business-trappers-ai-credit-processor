/**
 * milestone8.js — M8 secure-delivery orchestrator (Elizabeth Kelley test only).
 *
 * Consumes an ALREADY-FINALIZED M7 letterResult supplied in the request body.
 * It NEVER reruns, reanalyzes, or regenerates M7 (M7 persists nothing and is
 * frozen). The supplied result is treated as immutable input.
 *
 * Flow:
 *   validate supplied M7 result (Elizabeth/15, lettersOk, nonempty letters)
 *   -> m8Pdf.buildBureauPdfs
 *   -> launchBrowser -> loginToCRC -> openClient -> getCrcClientId (assert 15)
 *   -> DUPLICATE-PREVENTION GATE:
 *        * Elizabeth Kelley / client 15  -> hard-coded TEST EXCEPTION (allowed)
 *        * any other client              -> BLOCKED (no durable store tonight)
 *   -> crcSecureMessage.sendSecureMessage (STOPS before Submit unless approved)
 *   -> ONLY on exact success confirmation: updateClientStatus("Waiting For Bureau")
 *
 * Preserves Supabase round/memory logic EXACTLY: it does not write current_round,
 * does not advance the round, and creates no new Supabase column or table.
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { getCrcClientId } from "./crcClientId.js";
import { updateClientStatus } from "./crcClientStatus.js";
import { buildBureauPdfs } from "./m8Pdf.js";
import { sendSecureMessage } from "./crcSecureMessage.js";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const MILESTONE8_VERSION = "BT-M8-DELIVERY-1.1";

const AUTHORIZED_CLIENT_ID = "15";
const AUTHORIZED_CLIENT_NAME = "Elizabeth Kelley";
const WAITING_FOR_BUREAU = "Waiting For Bureau";

function buildReport(overrides = {}) {
    return {
        milestone: "M8_SECURE_DELIVERY",
        tool: MILESTONE8_VERSION,
        clientName: null,
        crcClientId: null,
        round: null,
        bureausGenerated: [],
        pdfFiles: [],
        pdfSizes: {},
        placeholdersRemaining: false,
        selectedRecipient: null,
        expectedAttachmentCount: 0,
        verifiedAttachmentCount: 0,
        messageSubmitted: false,
        messageSuccessConfirmed: false,
        finalStatus: null,
        duplicatePrevented: false,
        testClientDuplicateException: false,
        blockedReason: null,
        failureReason: null,
        ...overrides,
    };
}

/**
 * Is this the hard-coded Elizabeth Kelley / client 15 test record? Both the exact
 * name AND the exact id must match. Every other client is treated as production.
 */
function isTestClient(clientName, crcClientId) {
    return clientName === AUTHORIZED_CLIENT_NAME && String(crcClientId) === AUTHORIZED_CLIENT_ID;
}

/**
 * @param {object} data
 * @param {string} data.clientName            must be "Elizabeth Kelley"
 * @param {boolean} data.submitApproved       explicit gate for the live Submit click
 * @param {object} data.letterResult          REQUIRED finalized M7 result:
 *                                             { lettersOk:true, letters:[...], withheld?:[...] }
 */
export async function runMilestone8(data = {}) {
    const clientName = data?.clientName ?? null;
    const submitApproved = data?.submitApproved === true;
    const letterResult = data?.letterResult ?? null;
    const report = buildReport({ clientName, submitApproved });

    // ---- 0) Client identity guard (name only at this stage) ----------------
    if (clientName !== AUTHORIZED_CLIENT_NAME) {
        report.blockedReason = "client_not_authorized_for_m8_test";
        report.failureReason =
            `M8 delivery authorized only for ${AUTHORIZED_CLIENT_NAME} (Client ${AUTHORIZED_CLIENT_ID}).`;
        report.finalStatus = "blocked";
        return report;
    }

    // ---- 1) Validate the SUPPLIED (immutable) M7 result --------------------
    // M7 persists nothing and is frozen. We consume the finalized result from the
    // request body; we never rerun, reanalyze, or regenerate it.
    if (!letterResult || typeof letterResult !== "object") {
        report.blockedReason = "m7_output_not_supplied";
        report.failureReason = "No finalized M7 letterResult supplied in the request body.";
        report.finalStatus = "blocked";
        return report;
    }
    if (letterResult.lettersOk !== true) {
        report.blockedReason = "m7_result_not_ok";
        report.failureReason = "Supplied M7 result has lettersOk !== true.";
        report.finalStatus = "blocked";
        return report;
    }
    if (!Array.isArray(letterResult.letters) || letterResult.letters.length === 0) {
        report.blockedReason = "m7_letters_missing";
        report.failureReason = "Supplied M7 result has no letters.";
        report.finalStatus = "blocked";
        return report;
    }
    // Belt-and-suspenders: the supplied letters must belong to this client if they
    // carry any client identifier. (We do not mutate the result.)
    const mismatched = letterResult.letters.find((l) =>
        (l.crcClientId && String(l.crcClientId) !== AUTHORIZED_CLIENT_ID) ||
        (l.clientName && l.clientName !== AUTHORIZED_CLIENT_NAME)
    );
    if (mismatched) {
        report.blockedReason = "m7_result_client_mismatch";
        report.failureReason = "Supplied M7 letters do not all belong to Elizabeth Kelley / 15.";
        report.finalStatus = "blocked";
        return report;
    }

    // ---- 2) Build the bureau PDFs (fail-closed inside m8Pdf) ---------------
    const pdfBuild = await buildBureauPdfs(letterResult);
    report.round = pdfBuild.round;
    report.bureausGenerated = pdfBuild.pdfs.map((p) => p.bureau);
    report.pdfFiles = pdfBuild.pdfs.map((p) => p.filename);
    report.pdfSizes = Object.fromEntries(pdfBuild.pdfs.map((p) => [p.filename, p.bytes]));
    report.expectedAttachmentCount = pdfBuild.pdfs.length;
    if (!pdfBuild.ok) {
        report.failureReason = `PDF build failed: ${pdfBuild.failureReason}`;
        report.finalStatus = "manual_review_required";
        return report;
    }

    let browser;
    try {
        // ---- 3) Live session: launch -> login -> open -> assert client 15 --
        const session = await launchBrowser();
        browser = session.browser;
        const page = session.page;

        await loginToCRC(page);
        await openClient(page, clientName);

        const crcClientId = String(await getCrcClientId(page));
        report.crcClientId = crcClientId;
        if (crcClientId !== AUTHORIZED_CLIENT_ID) {
            report.blockedReason = "wrong_client_opened";
            report.failureReason =
                `Opened client id ${crcClientId}, expected ${AUTHORIZED_CLIENT_ID}. Aborting.`;
            report.finalStatus = "blocked";
            return report;
        }

        // ---- 4) DUPLICATE-PREVENTION GATE ----------------------------------
        // Durable per-round duplicate prevention would require a Supabase store we
        // are NOT creating tonight. Elizabeth Kelley / client 15 is an explicitly
        // authorized TEST record: repeated end-to-end sends are permitted, so the
        // durable guard is waived FOR THIS RECORD ONLY. Every other client is hard-
        // blocked from live Submit until durable prevention exists.
        if (isTestClient(clientName, crcClientId)) {
            report.testClientDuplicateException = true;
        } else {
            report.blockedReason = "durable_duplicate_prevention_not_available";
            report.failureReason =
                "Live Submit is blocked for non-test clients until durable per-round " +
                "duplicate prevention (CRC Client ID + current round) exists.";
            report.finalStatus = "blocked";
            return report;
        }

        // ---- 5) Deliver (STOPS before Submit unless approved) --------------
        const send = await sendSecureMessage(
            page,
            { clientName, crcClientId, pdfs: pdfBuild.pdfs, submitApproved },
            { fs, path, os }
        );
        report.selectedRecipient = send.selectedRecipient;
        report.expectedAttachmentCount = send.expectedAttachmentCount;
        report.verifiedAttachmentCount = send.verifiedAttachmentCount;
        report.messageSubmitted = send.messageSubmitted;
        report.messageSuccessConfirmed = send.messageSuccessConfirmed;

        // 5a) Dry run: stopped before Submit. CRC status UNCHANGED.
        if (send.stoppedBeforeSubmit) {
            report.readyToSubmit = send.readyToSubmit === true;
            report.finalStatus = "READY_NOT_SENT";
            report.note =
                "Readiness report only. CRC status unchanged. Re-run with submitApproved:true to send.";
            return report;
        }

        // 5b) Failure at/after Submit but success NOT confirmed. Do NOT write
        // Waiting For Bureau. Return manual-review result (CRC status unchanged).
        if (!send.messageSuccessConfirmed) {
            report.failureReason =
                `Send failed at stage "${send.failedStage}": ${send.failureReason}`;
            // If the click happened but confirmation never appeared, the message
            // MAY have been sent — surface that, do not resend.
            report.finalStatus = send.messageSubmitted
                ? "manual_review_required_submit_unconfirmed"
                : "manual_review_required";
            return report;
        }

        // ---- 6) EXACT success confirmed -> update status -------------------
        // updateClientStatus(page, crcClientId, newStatus, { processingCycleComplete })
        // returns { ok: true, ... } on success (confirmed from the real file).
        const statusResult = await updateClientStatus(
            page, crcClientId, WAITING_FOR_BUREAU, { processingCycleComplete: true }
        );
        report.statusUpdateResult = {
            ok: statusResult?.ok === true,
            statusWritten: statusResult?.statusWritten ?? null,
            error_code: statusResult?.error_code ?? null,
        };

        if (statusResult?.ok !== true) {
            // CRITICAL PARTIAL COMPLETION: the secure message WAS sent and
            // confirmed, but the status write failed. Do NOT resend. Human must
            // set the status manually.
            report.statusUpdateFailed = true;
            report.failureReason =
                `Message sent & confirmed, but status update failed ` +
                `(${statusResult?.error_code ?? "unknown"}). Do NOT resend; set status manually.`;
            report.finalStatus = "critical_partial_completion";
            return report;
        }

        // ---- 7) Delivery complete. (No durable delivery marker persisted —
        // test-client exception; round logic untouched.) --------------------
        report.finalStatus = WAITING_FOR_BUREAU;
        report.failureReason = null;
        return report;
    } catch (error) {
        report.failureReason = error.message;
        // Unknown mid-flight error: if we had already confirmed success we would
        // have returned above, so this path did NOT confirm a send.
        report.finalStatus = report.finalStatus ?? "manual_review_required";
        return report;
    } finally {
        try { if (browser) await browser.close(); } catch { /* ignore */ }
    }
}
