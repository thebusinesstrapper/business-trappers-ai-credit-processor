/**
 * processControlledClient.js
 *
 * Temporary one-client-at-a-time bridge for the five controlled production
 * validations. It always generates a FRESH M7 package for the requested client
 * and passes that exact in-memory result directly to M8.
 */

import { runMilestone7 } from "./milestone7.js";
import { runMilestone8 } from "./milestone8.js";

function normalizeClientName(value) {
    return typeof value === "string"
        ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")
        : "";
}

export const CONTROLLED_CLIENTS = Object.freeze({
    "181": "Tonya Sekona",
    "180": "Sitiseni Tasila",
    "179": "Joshua Thornton",
    "178": "Telisha Jones",
    "177": "Gwendolyn Tipton",
});

export async function runControlledClient(data = {}) {
    const clientName = typeof data.clientName === "string" ? data.clientName.trim() : "";
    const crcClientId = data.crcClientId == null ? "" : String(data.crcClientId).trim();
    const processingApproved = data.processingApproved === true;
    const submitApproved = data.submitApproved === true;

    const base = {
        milestone: "CONTROLLED_CLIENT_M7_TO_M8",
        tool: "BT-CONTROLLED-CLIENT-1.0",
        clientName,
        crcClientId,
        processingApproved,
        submitApproved,
    };

    if (!processingApproved) {
        return {
            ...base,
            ok: false,
            stage: "authorization",
            blockedReason: "processing_not_approved",
        };
    }

    const allowedName = CONTROLLED_CLIENTS[crcClientId] ?? "";

    if (!allowedName || normalizeClientName(allowedName) !== normalizeClientName(clientName)) {
        return {
            ...base,
            ok: false,
            stage: "authorization",
            blockedReason: "client_not_in_controlled_allowlist",
        };
    }

    const m7 = await runMilestone7({ clientName });

    const m7LettersOk = m7?.lettersOk === true || m7?.letters_ok === true;

    if (!m7 || m7.success === false || !m7LettersOk) {
        return {
            ...base,
            ok: false,
            stage: "m7",
            blockedReason: "fresh_m7_not_client_ready",
            m7,
        };
    }

    const m8 = await runMilestone8({
        clientName,
        crcClientId,
        submitApproved,
        letterResult: { ...m7, lettersOk: m7LettersOk },
    });

    const ok = submitApproved
        ? m8?.messageSuccessConfirmed === true &&
          m8?.deliveryMarkerPersisted === true &&
          m8?.statusUpdateResult?.ok === true
        : m8?.finalStatus === "READY_NOT_SENT" && m8?.readyToSubmit === true;

    return {
        ...base,
        ok,
        stage: "complete",
        m7Summary: {
            success: m7.success !== false,
            lettersOk: m7LettersOk,
            letterCount: Array.isArray(m7.letters) ? m7.letters.length : 0,
            withheldCount: Array.isArray(m7.withheld) ? m7.withheld.length : 0,
        },
        m8,
    };
}
