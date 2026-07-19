/**
 * milestone8.js — M8 secure-delivery orchestrator.
 *
 * Consumes one already-finalized M7 result for the SAME client. For a live send,
 * it acquires a durable, round-specific Supabase lock before Submit and marks
 * the delivery complete immediately after CRC confirms success.
 *
 * It never advances current_round.
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { getCrcClientId } from "./crcClientId.js";
import { updateClientStatus } from "./crcClientStatus.js";
import { buildBureauPdfs } from "./m8Pdf.js";
import { sendSecureMessage } from "./crcSecureMessage.js";
import {
    acquireDeliveryLock,
    markDeliveryCompleted,
    releaseDeliveryLock,
} from "./clientMemory.js";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const MILESTONE8_VERSION = "BT-M8-DELIVERY-1.2";

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
        deliveryLockAcquired: false,
        deliveryMarkerPersisted: false,
        blockedReason: null,
        failureReason: null,
        ...overrides,
    };
}

function exactText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeClientName(value) {
    return exactText(value).replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function findLetterMismatch(letters, clientName, crcClientId) {
    return letters.find((letter) => {
        const letterId = letter?.crcClientId ?? letter?.crc_client_id ?? null;
        const letterName = letter?.clientName ?? letter?.client_name ?? null;

        return (
            (letterId !== null && String(letterId) !== String(crcClientId)) ||
            (letterName !== null && normalizeClientName(letterName) !== normalizeClientName(clientName))
        );
    });
}

/**
 * @param {object} data
 * @param {string} data.clientName
 * @param {string|number} data.crcClientId       expected authoritative CRC id
 * @param {boolean} data.submitApproved
 * @param {object} data.letterResult             finalized M7 result for this client
 */
export async function runMilestone8(data = {}) {
    const clientName = exactText(data?.clientName);
    const expectedClientId = data?.crcClientId == null ? "" : String(data.crcClientId).trim();
    const submitApproved = data?.submitApproved === true;
    const letterResult = data?.letterResult ?? null;
    const report = buildReport({ clientName, crcClientId: expectedClientId || null, submitApproved });

    if (!clientName || !expectedClientId) {
        report.blockedReason = "client_identity_required";
        report.failureReason = "Both clientName and crcClientId are required.";
        report.finalStatus = "blocked";
        return report;
    }

    if (!letterResult || typeof letterResult !== "object") {
        report.blockedReason = "m7_output_not_supplied";
        report.failureReason = "No finalized M7 letterResult supplied in the request body.";
        report.finalStatus = "blocked";
        return report;
    }

    const lettersOk = letterResult.lettersOk === true || letterResult.letters_ok === true;

    if (!lettersOk) {
        report.blockedReason = "m7_result_not_ok";
        report.failureReason = "Supplied M7 result has neither lettersOk nor letters_ok set to true.";
        report.finalStatus = "blocked";
        return report;
    }

    if (!Array.isArray(letterResult.letters) || letterResult.letters.length === 0) {
        report.blockedReason = "m7_letters_missing";
        report.failureReason = "Supplied M7 result has no letters.";
        report.finalStatus = "blocked";
        return report;
    }

    if (findLetterMismatch(letterResult.letters, clientName, expectedClientId)) {
        report.blockedReason = "m7_result_client_mismatch";
        report.failureReason = "Supplied M7 letters do not all belong to the requested client.";
        report.finalStatus = "blocked";
        return report;
    }

    const pdfBuild = await buildBureauPdfs(letterResult);
    report.round = pdfBuild.round;
    report.bureausGenerated = pdfBuild.pdfs.map((pdf) => pdf.bureau);
    report.pdfFiles = pdfBuild.pdfs.map((pdf) => pdf.filename);
    report.pdfSizes = Object.fromEntries(pdfBuild.pdfs.map((pdf) => [pdf.filename, pdf.bytes]));
    report.expectedAttachmentCount = pdfBuild.pdfs.length;

    if (!pdfBuild.ok) {
        report.failureReason = `PDF build failed: ${pdfBuild.failureReason}`;
        report.finalStatus = "manual_review_required";
        return report;
    }

    let browser;
    let deliveryLock = null;

    try {
        const session = await launchBrowser();
        browser = session.browser;
        const page = session.page;

        await loginToCRC(page);
        await openClient(page, clientName);

        const actualClientId = String(await getCrcClientId(page));
        report.crcClientId = actualClientId;

        if (actualClientId !== expectedClientId) {
            report.blockedReason = "wrong_client_opened";
            report.failureReason =
                `Opened client id ${actualClientId}, expected ${expectedClientId}. Aborting.`;
            report.finalStatus = "blocked";
            return report;
        }

        // Dry runs never acquire or alter a delivery marker.
        if (submitApproved) {
            deliveryLock = await acquireDeliveryLock(
                actualClientId,
                clientName,
                pdfBuild.round
            );

            if (!deliveryLock.ok) {
                report.duplicatePrevented = [
                    "duplicate_delivery_prevented",
                    "delivery_already_in_progress",
                    "delivery_lock_conflict",
                ].includes(deliveryLock.reason);
                report.blockedReason = deliveryLock.reason;
                report.failureReason =
                    `Live delivery lock was not acquired: ${deliveryLock.reason}.`;
                report.finalStatus = "blocked";
                report.deliveryLock = deliveryLock;
                return report;
            }

            report.deliveryLockAcquired = true;
        }

        const send = await sendSecureMessage(
            page,
            {
                clientName,
                crcClientId: actualClientId,
                pdfs: pdfBuild.pdfs,
                submitApproved,
            },
            { fs, path, os }
        );

        report.selectedRecipient = send.selectedRecipient;
        report.expectedAttachmentCount = send.expectedAttachmentCount;
        report.verifiedAttachmentCount = send.verifiedAttachmentCount;
        report.messageSubmitted = send.messageSubmitted;
        report.messageSuccessConfirmed = send.messageSuccessConfirmed;

        if (send.stoppedBeforeSubmit) {
            report.readyToSubmit = send.readyToSubmit === true;
            report.finalStatus = "READY_NOT_SENT";
            report.note = "Readiness report only. No delivery marker or CRC status was changed.";
            return report;
        }

        if (!send.messageSuccessConfirmed) {
            // Safe to release only when Submit was definitely not clicked.
            if (deliveryLock?.ok && send.messageSubmitted !== true) {
                report.deliveryLockReleased = await releaseDeliveryLock(
                    actualClientId,
                    pdfBuild.round,
                    deliveryLock.lockedState,
                    deliveryLock.previousState
                );
            }

            report.failureReason =
                `Send failed at stage "${send.failedStage}": ${send.failureReason}`;
            report.finalStatus = send.messageSubmitted
                ? "manual_review_required_submit_unconfirmed"
                : "manual_review_required";
            return report;
        }

        // Persist the duplicate-prevention marker immediately after exact CRC
        // success confirmation, before any later status-write failure can occur.
        const completed = await markDeliveryCompleted(
            actualClientId,
            pdfBuild.round,
            deliveryLock.lockedState
        );
        report.deliveryCompletionResult = completed;

        if (!completed.ok) {
            report.failureReason =
                "Message sent and confirmed, but the durable delivery marker could not be persisted. " +
                "Do NOT resend; route to manual review.";
            report.finalStatus = "critical_partial_completion_delivery_marker";
            return report;
        }

        report.deliveryMarkerPersisted = true;

        const statusResult = await updateClientStatus(
            page,
            actualClientId,
            WAITING_FOR_BUREAU,
            { processingCycleComplete: true }
        );

        report.statusUpdateResult = {
            ok: statusResult?.ok === true,
            statusWritten: statusResult?.statusWritten ?? null,
            error_code: statusResult?.error_code ?? null,
        };

        if (statusResult?.ok !== true) {
            report.statusUpdateFailed = true;
            report.failureReason =
                `Message sent, confirmed, and duplicate-protected, but status update failed ` +
                `(${statusResult?.error_code ?? "unknown"}). Do NOT resend; set status manually.`;
            report.finalStatus = "critical_partial_completion";
            return report;
        }

        report.finalStatus = WAITING_FOR_BUREAU;
        report.failureReason = null;
        return report;
    } catch (error) {
        report.failureReason = error.message;
        report.finalStatus = report.finalStatus ?? "manual_review_required";
        return report;
    } finally {
        try {
            if (browser) await browser.close();
        } catch {
            // ignore browser-close errors
        }
    }
}
