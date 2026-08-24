/**
 * processProductionClient.js
 *
 * Production bridge: fresh M7 -> same-client M8.
 */

import { runMilestone7 } from "./milestone7.js";
import { runInactiveWorkflow } from "./inactiveWorkflow.js";
import { statusOnlyUpdate } from "./statusOnlyUpdate.js";
import {
    recordCreditHeroState, readClientState, decideDailyPreflight, PREFLIGHT,
    markProcessComplete, FINAL_ROUND,
} from "./clientMemory.js";
import {
    advanceAfterFreshReportDelivery,
    recordFinalFreshReportDelivery,
} from "./freshReportLifecycle.js";
import { runMilestone8 } from "./milestone8.js";

function safeWithheldValue(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/\d{9,}/g, "[redacted]").replace(/\s+/g, " ").trim();
    return cleaned ? cleaned.slice(0, 120) : null;
}

export function projectWithheldItems(withheld) {
    if (!Array.isArray(withheld)) return [];
    return withheld.slice(0, 50).map((entry) => ({
        creditor:
            safeWithheldValue(entry?.creditor) ??
            safeWithheldValue(entry?.creditorName) ??
            safeWithheldValue(entry?.furnisher) ??
            safeWithheldValue(entry?.furnisher_norm) ??
            safeWithheldValue(entry?.accountName) ??
            safeWithheldValue(entry?.account_name) ??
            null,
        bureau:
            safeWithheldValue(entry?.bureau) ??
            safeWithheldValue(entry?.bureau_name) ??
            safeWithheldValue(entry?.creditBureau) ??
            null,
        itemType:
            safeWithheldValue(entry?.itemType) ??
            safeWithheldValue(entry?.item_type) ??
            safeWithheldValue(entry?.type) ??
            safeWithheldValue(entry?.accountType) ??
            safeWithheldValue(entry?.account_type) ??
            null,
        withheldReason:
            safeWithheldValue(entry?.reasonCode) ??
            safeWithheldValue(entry?.code) ??
            safeWithheldValue(entry?.reason) ??
            safeWithheldValue(entry?.reasonText) ??
            "unspecified",
        stableItemKey:
            safeWithheldValue(entry?.stable_item_key) ??
            safeWithheldValue(entry?.stableItemKey) ??
            safeWithheldValue(entry?.key) ??
            null,
        signatureTiers: Array.isArray(entry?.signatures)
            ? entry.signatures
                  .map((s) => safeWithheldValue(typeof s === "string" ? s.split("|")[0] : s?.tier))
                  .filter(Boolean)
                  .slice(0, 8)
            : null,
    }));
}

function findCrcClientId(value, seen = new Set()) {
    if (value == null || typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const preferredKeys = ["identityCrcClientId", "crcClientId", "crc_client_id"];

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

function validIsoDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function routeToWaitingForBureau(clientName, crcClientId, nowIso, nextFreeReportAt = null) {
    const status = await statusOnlyUpdate({
        clientName, crcClientId,
        targetStatus: "Waiting For Bureau",
        blockReason: "WAITING_FOR_FREE_REPORT",
    });

    let memoryWritten = false;

    if (status.statusUpdated) {
        await recordCreditHeroState(String(crcClientId), {
            block_reason: "WAITING_FOR_FREE_REPORT",
            last_credit_hero_check_at: nowIso,
        }).catch(() => {});

        if (status?.statusUpdated === true && status?.statusWritten) {
            const write = await recordCreditHeroState(String(crcClientId), {
                crc_client_status: status.statusWritten,
            }).catch(() => null);
            memoryWritten = write?.ok === true;
        }
    }

    return { status, memoryWritten, nextFreeReportAt };
}

const CRC_STATUS_COMPLETE = "Complete";

async function routeToComplete(clientName, crcClientId, reason, opts = {}) {
    const status = await statusOnlyUpdate({
        clientName, crcClientId,
        targetStatus: CRC_STATUS_COMPLETE,
        blockReason: reason,
    });

    let memory = { ok: false, reason: "crc_status_not_confirmed" };

    if (status.statusUpdated === true) {
        memory = await markProcessComplete(crcClientId, reason, opts).catch((error) => ({
            ok: false, reason: "complete_write_failed", detail: error.message,
        }));

        if (status.statusWritten) {
            await recordCreditHeroState(String(crcClientId), {
                crc_client_status: status.statusWritten,
            }).catch(() => {});
        }
    }

    return { status, memory };
}

function traceApproval(data, stage, values) {
    const trace = data?.approvalTrace;
    if (!Array.isArray(trace)) return;

    const limit = Number.isInteger(data.approvalTraceLimit) ? data.approvalTraceLimit : 200;
    if (trace.length >= limit) return;

    trace.push({
        jobId: values.jobId ?? null,
        clientName: values.clientName ?? null,
        processingApproved: values.processingApproved ?? null,
        diagnosticOnly: values.diagnosticOnly ?? null,
        submitApproved: values.submitApproved ?? null,
        operationalRoutingApproved: values.operationalRoutingApproved ?? null,
        inactiveWorkflowApproved: values.inactiveWorkflowApproved ?? null,
        executionMode: values.executionMode ?? null,
        stage,
        timestamp: new Date().toISOString(),
    });
}

export async function runProductionClient(data = {}) {
    const clientName =
        typeof data.clientName === "string"
            ? data.clientName.trim().replace(/\s+/g, " ")
            : "";
    const processingApproved = data.processingApproved === true;
    const submitApproved = data.submitApproved === true;

    traceApproval(data, "process_production_client", {
        clientName: data.clientName ?? null,
        processingApproved,
        submitApproved,
        operationalRoutingApproved: data.operationalRoutingApproved === true,
        inactiveWorkflowApproved: data.inactiveWorkflowApproved === true,
    });

    const base = {
        milestone: "PRODUCTION_CLIENT_M7_TO_M8",
        tool: "BT-PRODUCTION-CLIENT-1.1-FRESH-REPORT",
        clientName,
        processingApproved,
        submitApproved,
    };

    if (!processingApproved) {
        return { ...base, ok: false, stage: "authorization", blockedReason: "processing_not_approved" };
    }

    if (!clientName) {
        return { ...base, ok: false, stage: "authorization", blockedReason: "client_name_required" };
    }

    const preflightId =
        data.crcClientId != null && /^\d+$/.test(String(data.crcClientId).trim())
            ? String(data.crcClientId).trim()
            : null;

    let storedState = null;

    if (preflightId) {
        storedState = await readClientState(preflightId).catch(() => null);
        const todayIso = new Date().toISOString().slice(0, 10);
        const preflight = decideDailyPreflight(storedState, todayIso);

        // Complete is still terminal. The old SKIP_NOT_YET_ELIGIBLE timing gate
        // is deliberately ignored: future-cycle readiness is now governed by a
        // strictly newer Credit Hero report, not an elapsed-day date.
        if (preflight.action === PREFLIGHT.SKIP_COMPLETE) {
            return {
                ...base, ok: true, stage: "complete_terminal",
                outcome: "ALREADY_COMPLETE",
                crcClientId: preflightId,
                finalRound: preflight.finalRound ?? null,
                preflight,
                browserOpened: false,
                m7: null, m8: null,
            };
        }
    }

    const m7 = await runMilestone7({
        clientName,
        crcClientId: preflightId,
        crcClientStatus: data.crcClientStatus ?? null,
        submitApproved,
        operationalRoutingApproved: data.operationalRoutingApproved === true,
        approvalTrace: data.approvalTrace,
        approvalTraceLimit: data.approvalTraceLimit,
        currentRound: storedState?.current_round != null && Number.isInteger(Number(storedState.current_round)) && Number(storedState.current_round) > 0
            ? Number(storedState.current_round)
            : null,
    });
    const m7LettersOk = m7?.lettersOk === true || m7?.letters_ok === true;
    const capture = m7?.capture_result ?? null;
    const classification = capture?.result ?? null;
    const routingApproved = data.operationalRoutingApproved === true;
    const nowIso = new Date().toISOString();
    const routeCrcId = capture?.crcClientId ?? findCrcClientId(m7);

    if (capture?.error_code === "CHS_NOT_ACTIVATED" && capture?.requiresInactiveWorkflow === true) {
        if (!routingApproved) {
            return {
                ...base, ok: false, stage: "credit_hero_inactive",
                blockedReason: "credit_monitoring_inactive",
                classification: "CHS_NOT_ACTIVATED", crcClientId: routeCrcId,
                creditHeroAccessState: "CHS_NOT_ACTIVATED",
                proposedAction: "ENTER_INACTIVE_WORKFLOW",
                statusUpdated: false, m7,
            };
        }

        const inactive = await runInactiveWorkflow({
            clientName,
            crcClientId: routeCrcId,
            inactiveWorkflowApproved: data.inactiveWorkflowApproved === true,
            noticeDiagnosticOnly: data.noticeDiagnosticOnly === true,
        });

        if (inactive?.statusUpdated === true && inactive?.statusWritten) {
            await recordCreditHeroState(String(inactive.crcClientId), {
                crc_client_status: inactive.statusWritten,
            }).catch(() => {});
        }

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

    if (classification === "PAYMENT_REQUIRED" || classification === "CREDENTIALS_OR_AUTH_FAILED") {
        if (!routingApproved) {
            return {
                ...base, ok: false, stage: "credit_hero_inactive",
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
            noticeDiagnosticOnly: data.noticeDiagnosticOnly === true,
        });

        if (inactive?.statusUpdated === true && inactive?.statusWritten) {
            await recordCreditHeroState(String(inactive.crcClientId), {
                crc_client_status: inactive.statusWritten,
            }).catch(() => {});
        }

        return {
            ...base,
            ok: inactive.noticeSent || inactive.reminderSent || inactive.statusUpdated,
            stage: "credit_hero_inactive",
            blockedReason: "credit_monitoring_inactive",
            classification, crcClientId: inactive.crcClientId,
            inactive, m7,
        };
    }

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

        const { status, memoryWritten } = await routeToWaitingForBureau(
            clientName, routeCrcId, nowIso, capture?.nextFreeReportAvailableAt ?? null
        );

        return {
            ...base, ok: status.statusUpdated,
            stage: "waiting_for_free_report",
            blockedReason: "waiting_for_free_report",
            classification, crcClientId: routeCrcId,
            memoryWritten,
            status, m7,
        };
    }

    if (!m7 || m7.success === false || !m7LettersOk) {
        const specificCode =
            m7?.capture_result?.error_code ??
            m7?.error_code ??
            "m7_failed";

        return {
            ...base,
            ok: false,
            stage: "m7",
            blockedReason: String(specificCode).toLowerCase(),
            failureReason:
                m7?.capture_result?.error_message ??
                m7?.error_message ??
                null,
            requiresHumanReview:
                m7?.capture_result?.requiresHumanReview === true ||
                m7?.requiresHumanReview === true,
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

    const successCapture = m7?.capture ?? null;
    const eligibilityHint = successCapture?.eligibilityHint ?? null;

    if (eligibilityHint === "WAITING_FOR_FREE_REPORT") {
        if (!routingApproved) {
            return {
                ...base, ok: false, stage: "waiting_for_free_report",
                blockedReason: "waiting_for_free_report",
                classification: successCapture?.classification ?? null,
                eligibilityHint, crcClientId,
                proposedAction: "SET_WAITING_FOR_BUREAU",
                statusUpdated: false, m7,
            };
        }

        const { status, memoryWritten } = await routeToWaitingForBureau(
            clientName, crcClientId, nowIso, successCapture?.nextFreeReportAvailableAt ?? null
        );

        return {
            ...base, ok: status.statusUpdated,
            stage: "waiting_for_free_report",
            blockedReason: "waiting_for_free_report",
            classification: successCapture?.classification ?? null,
            eligibilityHint,
            lastReportDate: successCapture?.lastReportDate ?? null,
            crcClientId,
            memoryWritten,
            status, m7,
        };
    }

    if (eligibilityHint !== "ELIGIBLE_EXISTING_REPORT") {
        return {
            ...base,
            ok: false,
            stage: "eligibility_blocked",
            blockedReason: "report_not_eligible_for_delivery",
            classification: successCapture?.classification ?? null,
            eligibilityHint,
            lastReportDate: successCapture?.lastReportDate ?? null,
            temporaryOverrideApplied: successCapture?.temporaryOverrideApplied ?? null,
            crcClientId,
            m7,
            m8: null,
        };
    }

    const lettersKnown = Array.isArray(m7.letters);
    const withheldKnown = Array.isArray(m7.withheld);
    const letterCount = lettersKnown ? m7.letters.length : null;
    const withheldCount = withheldKnown ? m7.withheld.length : null;
    const reviewRequired = m7.review_required === true || m7.reviewRequired === true;
    const reviewReason = m7.review_reason ?? m7.reviewReason ?? null;
    const reviewResolvedOrBenign = !reviewRequired || reviewReason === "FIRST_PRODUCTION_VALIDATION";

    const noEligibleNegatives =
        lettersKnown && withheldKnown &&
        letterCount === 0 && withheldCount === 0 &&
        reviewResolvedOrBenign;

    if (noEligibleNegatives) {
        let completion = null;

        if (routingApproved) {
            completion = await routeToComplete(
                clientName, crcClientId, "no_eligible_negative_items",
                { negativeItemsRemaining: 0 }
            );
        }

        return {
            ...base,
            ok: true,
            stage: "no_eligible_negative_items",
            outcome: "NO_ELIGIBLE_NEGATIVE_ITEMS",
            blockedReason: null,
            failureReason: null,
            crcClientId,
            proposedAction: routingApproved ? null : "SET_COMPLETE",
            completionReason: "no_eligible_negative_items",
            completion,
            statusUpdated: completion?.status?.statusUpdated === true,
            processComplete: completion?.memory?.ok === true,
            manualReviewCleared: completion?.memory?.ok === true,
            m7Summary: {
                success: m7.success !== false,
                lettersOk: m7LettersOk,
                letterCount,
                withheldCount,
            },
            m8: null,
        };
    }

    // The exact report date being delivered is mandatory. This is what becomes
    // the baseline for the next round's strictly-newer freshness gate.
    const reportDateUsed =
        successCapture?.reportSelected?.date ??
        successCapture?.lastReportDate ??
        null;

    if (!validIsoDate(reportDateUsed)) {
        return {
            ...base,
            ok: false,
            stage: "report_date_guard",
            blockedReason: "report_date_used_missing",
            failureReason: "A dispute package cannot be delivered unless the exact Credit Hero report date used is known.",
            crcClientId,
            m7,
            m8: null,
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

    if (m8?.statusUpdateResult?.ok === true && m8.statusUpdateResult.statusWritten) {
        await recordCreditHeroState(String(crcClientId), {
            crc_client_status: m8.statusUpdateResult.statusWritten,
        }).catch(() => {});
    }

    const deliveryConfirmed =
        submitApproved &&
        duplicatePrevented !== true &&
        m8?.messageSuccessConfirmed === true &&
        m8?.deliveryMarkerPersisted === true &&
        m8?.statusUpdateResult?.ok === true;

    let roundOutcome = null;
    const deliveredRound = Number(m8?.round);

    if (deliveryConfirmed && Number.isInteger(deliveredRound) && deliveredRound >= 1) {
        if (deliveredRound >= FINAL_ROUND) {
            const reportMemory = await recordFinalFreshReportDelivery(
                crcClientId, deliveredRound, reportDateUsed
            ).catch((error) => ({ ok: false, reason: "final_report_memory_failed", detail: error.message }));

            if (!reportMemory?.ok) {
                roundOutcome = {
                    action: "final_report_memory_failed",
                    deliveredRound,
                    reportDateUsed,
                    reportMemory,
                    processComplete: false,
                };
            } else {
                const completion = routingApproved
                    ? await routeToComplete(clientName, crcClientId, "final_round_delivered", {
                        expectedRound: deliveredRound,
                    })
                    : null;

                roundOutcome = {
                    action: "completed_final_round",
                    deliveredRound,
                    reportDateUsed,
                    reportMemory,
                    completionReason: "final_round_delivered",
                    completion,
                    processComplete: completion?.memory?.ok === true,
                    crcStatusWritten: completion?.status?.statusWritten ?? null,
                    proposedAction: routingApproved ? null : "SET_COMPLETE",
                };
            }
        } else {
            const advanced = await advanceAfterFreshReportDelivery(
                crcClientId, deliveredRound, reportDateUsed
            ).catch((error) => ({ ok: false, reason: "round_advance_failed", detail: error.message }));

            roundOutcome = {
                action: "advanced_round",
                deliveredRound,
                reportDateUsed,
                newRound: advanced?.newRound ?? null,
                roundAdvanced: advanced?.ok === true,
                advanceResult: advanced,
            };
        }
    }

    return {
        ...base,
        crcClientId,
        ok,
        stage: "complete",
        duplicatePrevented,
        deliveryConfirmed,
        reportDateUsed,
        roundOutcome,
        m7Summary: {
            success: m7.success !== false,
            lettersOk: m7LettersOk,
            letterCount: Array.isArray(m7.letters) ? m7.letters.length : 0,
            withheldCount: Array.isArray(m7.withheld) ? m7.withheld.length : 0,
            withheldItems: projectWithheldItems(m7.withheld),
        },
        m8,
    };
}
