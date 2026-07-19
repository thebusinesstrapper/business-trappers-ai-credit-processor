/**
 * processProductionClient.js
 *
 * Production bridge: fresh M7 -> same-client M8.
 *
 * Unlike the temporary controlled-client bridge, this module has no five-client
 * allowlist. It derives the authoritative CRC Client ID from the fresh M7 result
 * and passes that exact ID into M8. A name is never used as the memory key.
 */

import { runMilestone7 } from "./milestone7.js";
import { runMilestone8 } from "./milestone8.js";

function findCrcClientId(value, seen = new Set()) {
    if (value == null || typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const preferredKeys = [
        "identityCrcClientId",
        "crcClientId",
        "crc_client_id",
    ];

    for (const key of preferredKeys) {
        const candidate = value[key];
        if (candidate != null && /^\d+$/.test(String(candidate).trim())) {
            return String(candidate).trim();
        }
    }

    for (const child of Object.values(value)) {
        const found = findCrcClientId(child, seen);
        if (found) return found;
    }

    return null;
}

export async function runProductionClient(data = {}) {
    const clientName =
        typeof data.clientName === "string"
            ? data.clientName.trim().replace(/\s+/g, " ")
            : "";
    const processingApproved = data.processingApproved === true;
    const submitApproved = data.submitApproved === true;

    const base = {
        milestone: "PRODUCTION_CLIENT_M7_TO_M8",
        tool: "BT-PRODUCTION-CLIENT-1.0",
        clientName,
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

    if (!clientName) {
        return {
            ...base,
            ok: false,
            stage: "authorization",
            blockedReason: "client_name_required",
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
            crcClientId: findCrcClientId(m7),
            m7,
        };
    }

    const crcClientId = findCrcClientId(m7);

    if (!crcClientId) {
        return {
            ...base,
            ok: false,
            stage: "identity",
            blockedReason: "authoritative_crc_client_id_not_found_in_m7",
            m7Summary: {
                success: m7.success !== false,
                lettersOk: m7LettersOk,
                letterCount: Array.isArray(m7.letters) ? m7.letters.length : 0,
                withheldCount: Array.isArray(m7.withheld) ? m7.withheld.length : 0,
            },
        };
    }

    const m8 = await runMilestone8({
        clientName,
        crcClientId,
        submitApproved,
        letterResult: { ...m7, lettersOk: m7LettersOk },
    });

    const duplicatePrevented =
        m8?.duplicatePrevented === true ||
        m8?.blockedReason === "duplicate_delivery_prevented";

    const ok = submitApproved
        ? (
            m8?.messageSuccessConfirmed === true &&
            m8?.deliveryMarkerPersisted === true &&
            m8?.statusUpdateResult?.ok === true
          ) || duplicatePrevented
        : m8?.finalStatus === "READY_NOT_SENT" && m8?.readyToSubmit === true;

    return {
        ...base,
        crcClientId,
        ok,
        stage: "complete",
        duplicatePrevented,
        m7Summary: {
            success: m7.success !== false,
            lettersOk: m7LettersOk,
            letterCount: Array.isArray(m7.letters) ? m7.letters.length : 0,
            withheldCount: Array.isArray(m7.withheld) ? m7.withheld.length : 0,
        },
        m8,
    };
}
