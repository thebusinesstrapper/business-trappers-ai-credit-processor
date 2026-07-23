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

/**
 * Set CRC status to "Waiting For Bureau" via the existing verified status-only
 * helper, then persist the exact confirmed status. Shared by BOTH places this
 * module can determine WAITING_FOR_FREE_REPORT:
 *   - capture_result.result (an M6 blocked/landing-page classification)
 *   - m7.capture.eligibilityHint (Phase A, on an otherwise-successful M7 run)
 *
 * Never touches M8, current_round, or letters. Persists crc_client_status
 * only when statusOnlyUpdate() reports both statusUpdated === true AND a
 * non-blank statusWritten — never the requested targetStatus as a substitute.
 *
 * @returns {Promise<{status: object, memoryWritten: boolean}>}
 *   status         — the unmodified report returned by statusOnlyUpdate()
 *   memoryWritten  — true ONLY when the crc_client_status Supabase write
 *                     itself reported success (recordCreditHeroState().ok
 *                     === true). Not merely whether a write was attempted.
 */
async function routeToWaitingForBureau(clientName, crcClientId, nowIso) {
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

    return { status, memoryWritten };
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

    // Gates computed ONCE, above every routing branch, so no branch can act
    // without them. operationalRoutingApproved gates WHETHER we act at all;
    // inactiveWorkflowApproved additionally gates the inactive workflow's writes.
    const classification = capture?.result ?? null;
    const routingApproved = data.operationalRoutingApproved === true;
    const nowIso = new Date().toISOString();
    const routeCrcId = capture?.crcClientId ?? findCrcClientId(m7);

    // CHS_NOT_ACTIVATED -> inactive workflow. NOW GATED on operationalRoutingApproved,
    // exactly like PAYMENT_REQUIRED — previously this branch entered the inactive
    // workflow with no routing gate, which is how a blocked classification could
    // reach write-capable code before approval.
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
        });

        // Persist the exact CRC status runInactiveWorkflow() confirmed it wrote —
        // its own report.statusWritten, passed through from updateClientStatus()'s
        // read-back, never the planned/target string. Only on confirmed success.
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

    // ---- STAGE 2: OPERATIONAL ROUTING OF BLOCKED CLASSIFICATIONS -----------
    //
    // The landing/order classifications are M6 successResponses that carry no
    // report model, so M7 wraps them as NO_REPORT_MODEL with capture_result = the
    // M6 object. The real classification is capture.result (computed above).
    //
    // GATING. operationalRoutingApproved must be explicitly true to write. When
    // false (the default, and forced false under diagnosticOnly), each branch
    // recognizes the state and returns a proposedAction, writing NOTHING.
    //
    // M8 PREVENTION. Every branch here RETURNS. runMilestone8 is called far below,
    // so a blocked classification can never reach it.

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

        // Same confirmed-status persistence as the CHS_NOT_ACTIVATED branch above.
        if (inactive?.statusUpdated === true && inactive?.statusWritten) {
            await recordCreditHeroState(String(inactive.crcClientId), {
                crc_client_status: inactive.statusWritten,
            }).catch(() => {});
        }

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

            // Persist the exact CRC status statusOnlyUpdate() confirmed it wrote —
            // its own report.statusWritten, passed through from updateClientStatus()'s
            // read-back, never the requested targetStatus. Only on confirmed success.
            if (status?.statusUpdated === true && status?.statusWritten) {
                await recordCreditHeroState(String(routeCrcId), {
                    crc_client_status: status.statusWritten,
                }).catch(() => {});
            }
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

        const { status, memoryWritten } = await routeToWaitingForBureau(clientName, routeCrcId, nowIso);

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

    // ---- PHASE A: STALE-REPORT ELIGIBILITY BLOCK ---------------------------
    //
    // The temporary July-1 rollout rule was previously computed and REPORTED but
    // never enforced, so a client whose existing report predates the cutoff would
    // still flow into M8 and have letters delivered off a stale report.
    //
    // The gate lives here, immediately before runMilestone8, rather than inside
    // any acquisition flow. That placement is deliberate: a free-report
    // acquisition that fails, stays pending, or lands on an unrecognized page can
    // never bypass it, because delivery is gated on the VERIFIED eligibility of
    // the report actually in hand.
    //
    // FAIL CLOSED. Only ELIGIBLE_EXISTING_REPORT proceeds. WAITING_FOR_FREE_REPORT,
    // ELIGIBLE_FREE_REPORT (acquisition not built), ELIGIBILITY_UNKNOWN, and a
    // missing hint all stop here. Returning BEFORE runMilestone8 means no delivery
    // lock is taken, no round advances, and no letters are sent.
    //
    // M7's success response carries these under `capture` (its failure branches
    // use `capture_result`), so the success-path hint is read from there.
    const successCapture = m7?.capture ?? null;
    const eligibilityHint = successCapture?.eligibilityHint ?? null;

    // ---- WAITING_FOR_FREE_REPORT, DETECTED ON THE SUCCESS PATH -------------
    //
    // M6 can determine, even on an otherwise-successful M7 run, that the
    // existing report is outside the eligible window and a new free report is
    // required but not yet available. This is the SAME outcome as the
    // capture_result-based WAITING_FOR_FREE_REPORT classification handled far
    // above (routeToWaitingForBureau) — just surfaced through
    // m7.capture.eligibilityHint instead of capture_result.result. It MUST
    // route the same way and MUST NOT fall through to the generic "not
    // eligible" manual-review return below, which has no way to distinguish
    // "waiting on a free report" from any other ineligibility reason.
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

        const { status, memoryWritten } = await routeToWaitingForBureau(clientName, crcClientId, nowIso);

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

    // ---- CORRECTION 2: NO ACTIONABLE DISPUTE ITEMS -------------------------
    //
    // M7 can succeed (success:true, lettersOk:true — both already guaranteed
    // by the "if (!m7 || m7.success === false || !m7LettersOk)" gate above)
    // and still have generated zero letters and withheld zero items — e.g. no
    // negative accounts are present, or the only negative item present (such
    // as a bankruptcy) is intentionally outside the current processing scope
    // and was never surfaced by M7 as either a letter or a withheld item. That
    // is a legitimate business outcome, not a capture failure and not a
    // letter-generation failure. It must never reach M8, which would
    // otherwise reject it as "m7_letters_missing" — a message meant for a
    // genuine pipeline defect, not for "there was nothing to dispute".
    //
    // NO CRC status change. Current business rules do not define a target CRC
    // status for this condition, so CRC is left exactly as it was: no
    // statusOnlyUpdate call, no block_reason write, no crc_client_status
    // write. current_round is untouched, no delivery lock is taken, and M8 is
    // never invoked.
    const letterCount = Array.isArray(m7.letters) ? m7.letters.length : 0;
    const withheldCount = Array.isArray(m7.withheld) ? m7.withheld.length : 0;

    if (letterCount === 0 && withheldCount === 0) {
        return {
            ...base,
            ok: true,
            stage: "no_actionable_dispute_items",
            outcome: "NO_ACTIONABLE_DISPUTE_ITEMS",
            blockedReason: null,
            failureReason: null,
            crcClientId,
            m7Summary: {
                success: m7.success !== false,
                lettersOk: m7LettersOk,
                letterCount,
                withheldCount,
            },
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

    // ---- ITEM 5: PERSIST THE EXACT STATUS M8 CONFIRMED IT WROTE -----------
    //
    // milestone8.js's contract (see report.statusUpdateResult in
    // runMilestone8()) is:
    //
    //   report.statusUpdateResult = {
    //       ok: statusResult?.ok === true,
    //       statusWritten: statusResult?.statusWritten ?? null,
    //       error_code: statusResult?.error_code ?? null,
    //   };
    //
    // So the ONLY value ever persisted here is m8.statusUpdateResult.statusWritten
    // (never .status — that key does not exist on this contract), and ONLY when
    // m8.statusUpdateResult.ok === true. There is no fallback to a requested or
    // proposed status string: if ok is not exactly true, or statusWritten is
    // absent/blank, nothing is written — recordCreditHeroState()'s own
    // crc_client_status guard would reject a blank/non-string value anyway, but
    // the check here means we never even attempt a write on a failed update.
    if (m8?.statusUpdateResult?.ok === true && m8.statusUpdateResult.statusWritten) {
        await recordCreditHeroState(String(crcClientId), {
            crc_client_status: m8.statusUpdateResult.statusWritten,
        }).catch(() => {});
    }

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
