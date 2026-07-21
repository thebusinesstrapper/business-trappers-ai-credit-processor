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
import { runInactiveWorkflow } from "./inactiveWorkflow.js";
import { statusOnlyUpdate } from "./statusOnlyUpdate.js";
import { recordCreditHeroState } from "./clientMemory.js";
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

    // ---- CREDIT HERO INACTIVE BRANCH ---------------------------------------
    //
    // Positively confirmed CHS_NOT_ACTIVATED only. A generic
    // CREDIT_HERO_UNAVAILABLE, a click that did not navigate, or a greyed
    // control are NOT proof and keep the ordinary manual-review path below.
    const capture = m7?.capture_result ?? null;

    if (capture?.error_code === "CHS_NOT_ACTIVATED" && capture?.requiresInactiveWorkflow === true) {
        const inactive = await runInactiveWorkflow({
            clientName,
            crcClientId: capture.crcClientId ?? findCrcClientId(m7),
            inactiveWorkflowApproved: data.inactiveWorkflowApproved === true,
        });

        return {
            ...base,
            ok: inactive.noticeSent || inactive.reminderSent || inactive.statusUpdated,
            stage: "credit_hero_inactive",
            blockedReason: "credit_monitoring_inactive",
            crcClientId: inactive.crcClientId,
            creditHeroAccessState: "CHS_NOT_ACTIVATED",
            inactive,
            m7,
        };
    }

    // ---- STAGE 2: OPERATIONAL ROUTING OF BLOCKED CLASSIFICATIONS -----------
    //
    // The landing/order classifications are M6 successResponses that carry no
    // report model, so M7 wraps them as NO_REPORT_MODEL with capture_result = the
    // M6 object. The real classification is capture.result.
    //
    // GATING. operationalRoutingApproved must be explicitly true to write. When
    // false (the default, and forced false under diagnosticOnly), each branch
    // recognizes the state and returns a proposedAction, writing NOTHING.
    //
    // M8 PREVENTION. Every branch here RETURNS. runMilestone8 is called far below,
    // so a blocked classification can never reach it.
    const classification = capture?.result ?? null;
    const routingApproved = data.operationalRoutingApproved === true;
    const nowIso = new Date().toISOString();
    const routeCrcId = capture?.crcClientId ?? findCrcClientId(m7);

    // PAYMENT_REQUIRED -> inactive workflow (needs BOTH gates).
    if (classification === "PAYMENT_REQUIRED") {
        if (!routingApproved) {
            return {
                ...base, ok: false, stage: "payment_required",
                blockedReason: "credit_monitoring_inactive",
                classification, crcClientId: routeCrcId,
                proposedAction: "ENTER_INACTIVE_WORKFLOW",
                statusUpdated: false, m7,
            };
        }

        const inactive = await runInactiveWorkflow({
            clientName,
            crcClientId: routeCrcId,
            inactiveWorkflowApproved: data.inactiveWorkflowApproved === true,
        });

        return {
            ...base,
            ok: inactive.noticeSent || inactive.reminderSent || inactive.statusUpdated,
            stage: "payment_required",
            blockedReason: "credit_monitoring_inactive",
            classification, crcClientId: inactive.crcClientId,
            inactive, m7,
        };
    }

    // CREDENTIALS_OR_AUTH_FAILED -> Manual Review Required (status only).
    if (classification === "CREDENTIALS_OR_AUTH_FAILED") {
        if (!routingApproved) {
            return {
                ...base, ok: false, stage: "credentials_or_auth_failed",
                blockedReason: "credentials_or_auth_failed",
                classification, crcClientId: routeCrcId,
                proposedAction: "SET_MANUAL_REVIEW_REQUIRED",
                statusUpdated: false, m7,
            };
        }

        const status = await statusOnlyUpdate({
            clientName, crcClientId: routeCrcId,
            targetStatus: "Manual Review Required",
            blockReason: "CREDENTIALS_OR_AUTH_FAILED",
        });

        if (status.statusUpdated) {
            await recordCreditHeroState(String(routeCrcId), {
                block_reason: "CREDENTIALS_OR_AUTH_FAILED",
                last_credit_hero_check_at: nowIso,
            }).catch(() => {});
        }

        return {
            ...base, ok: status.statusUpdated,
            stage: "credentials_or_auth_failed",
            blockedReason: "credentials_or_auth_failed",
            classification, crcClientId: routeCrcId,
            status, m7,
        };
    }

    // WAITING_FOR_FREE_REPORT -> Waiting For Bureau (status only) + durable marker.
    if (classification === "WAITING_FOR_FREE_REPORT") {
        if (!routingApproved) {
            return {
                ...base, ok: false, stage: "waiting_for_free_report",
                blockedReason: "waiting_for_free_report",
                classification, crcClientId: routeCrcId,
                proposedAction: "SET_WAITING_FOR_BUREAU",
                statusUpdated: false, m7,
            };
        }

        const status = await statusOnlyUpdate({
            clientName, crcClientId: routeCrcId,
            targetStatus: "Waiting For Bureau",
            blockReason: "WAITING_FOR_FREE_REPORT",
        });

        if (status.statusUpdated) {
            await recordCreditHeroState(String(routeCrcId), {
                block_reason: "WAITING_FOR_FREE_REPORT",
                last_credit_hero_check_at: nowIso,
            }).catch(() => {});
        }

        return {
            ...base, ok: status.statusUpdated,
            stage: "waiting_for_free_report",
            blockedReason: "waiting_for_free_report",
            classification, crcClientId: routeCrcId,
            status, m7,
        };
    }

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
