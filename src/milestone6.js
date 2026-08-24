/**
 * milestone6.js — verified CRC identity + Credit Hero report capture.
 *
 * Permanent future-round rule: once a prior report has been used, a later
 * dispute cycle may proceed only from a strictly newer report. If the selector
 * still shows the previously-used report, the existing governed free-report
 * acquisition path is invoked. Paid reports remain forbidden.
 */

import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { readClientProfile } from "./crcClientProfile.js";
import { verifyIdentity } from "./clientIdentity.js";
import { openCreditHero } from "./openCreditHero.js";
import { recognizeDashboardBlocker } from "./importAuditState.js";
import { recognizeCreditHeroLanding, CH_LANDING_STATE } from "./creditHeroLandingState.js";
import {
    readOrderPage, readOrderPageOptions, ORDER_STATE, computeEligibilityHint,
} from "./orderPageReader.js";
import { decideAcquisition, DECISIONS } from "./acquisitionDecision.js";
import {
    navigateToOrderPage, selectAndSubmitFreeReport, describeSubmissionFlag,
} from "./orderFreeReport.js";
import {
    readOpenIntent, createIntent, markSubmissionStarted, markSubmitted,
    resolveIntent, decideIntentRecovery, INTENT_STATUS, RECOVERY,
} from "./acquisitionIntent.js";
import { readClientState, ensureClientStateExists } from "./clientMemory.js";
import { randomUUID } from "node:crypto";
import { openCreditReport } from "./openCreditReport.js";
import { normalizeReport } from "./reportNormalize.js";
import { readReportSelector, selectReport, verifyActiveReport } from "./reportSelector.js";
import { captureReportedAddresses } from "./captureReportedAddresses.js";
import { decideFreshness, hasNewerReport, ACTION } from "./reportFreshness.js";
import { analyzeReportShape, buildSkeleton } from "./spikeReportJson.js";

export async function runMilestone6(data = {}) {
    const identityState = { crcClientId: null };
    const result = await captureAndNormalize(data, identityState);
    const resolvedId = identityState.crcClientId;

    if (
        result && result.success === false && resolvedId != null &&
        (result.crcClientId === undefined || result.crcClientId === null)
    ) {
        result.crcClientId = String(resolvedId);
    }

    return result;
}

async function captureAndNormalize(data = {}, identityState = {}) {
    let browser;
    let acquisitionEvidence = null;
    let creditHeroAccessVerified = false;

    try {
        const clientName = data.clientName || "Elizabeth Kelley";
        const session = await launchBrowser();
        browser = session.browser;
        const page = session.page;
        const context = session.context;
        const replayUrl = `https://www.browserbase.com/sessions/${session.session.id}`;

        console.log(`Browserbase replay: ${replayUrl}`);
        await loginToCRC(page);

        const client = await openClient(page, clientName, data.crcClientId ?? null);
        if (!client.clientFound || !client.clientOpened) {
            return errorResponse("CLIENT_NOT_OPENED", `Could not open client "${clientName}".`, { milestone: "M6_CAPTURE" });
        }

        identityState.crcClientId = client.crcClientId ?? null;

        if (Array.isArray(data.approvalTrace)) {
            const limit = Number.isInteger(data.approvalTraceLimit) ? data.approvalTraceLimit : 200;
            if (data.approvalTrace.length < limit) {
                data.approvalTrace.push({
                    jobId: null,
                    clientName: data.clientName ?? null,
                    processingApproved: null,
                    diagnosticOnly: null,
                    submitApproved: data.submitApproved === true,
                    operationalRoutingApproved: data.operationalRoutingApproved === true,
                    inactiveWorkflowApproved: null,
                    executionMode: null,
                    stage: "milestone6_identity",
                    timestamp: new Date().toISOString(),
                });
            }
        }

        const initialized = await ensureClientStateExists(client.crcClientId, {
            clientDisplayName: clientName,
            crcClientStatus: data.crcClientStatus ?? null,
        }).catch((error) => ({
            ok: false,
            reason: "client_state_init_exception",
            detail: error.message,
        }));

        if (!initialized.ok) {
            return errorResponse(
                "CLIENT_STATE_INIT_FAILED",
                "The client was identified in CRC but its client_state row could not be established, so processing stopped before anything was changed.",
                {
                    milestone: "M6_CAPTURE",
                    stage: "client_state_initialization",
                    crcClientId: client.crcClientId,
                    persistenceReason: initialized.reason ?? null,
                    persistenceError: initialized.detail ?? null,
                    requiresHumanReview: true,
                }
            );
        }

        const blocker = await recognizeDashboardBlocker(page);
        if (blocker.blocked) {
            return errorResponse(
                "CHS_NOT_ACTIVATED",
                "Credit Hero Score monitoring is not active for this client.",
                {
                    milestone: "M6_CAPTURE",
                    stage: "credit_hero",
                    crcClientId: client.crcClientId,
                    creditHeroAccessState: "CHS_NOT_ACTIVATED",
                    importAuditState: blocker.state,
                    observed: blocker.observed,
                    requiresInactiveWorkflow: true,
                    openCreditHeroAttempted: false,
                    requiresHumanReview: true,
                }
            );
        }

        const profile = await readClientProfile(page, client.crcClientId);
        if (!profile.ok) {
            return errorResponse(profile.error_code,
                `Identity could not be established: ${profile.error} Extraction does not proceed without a verified CRC identity.`,
                {
                    milestone: "M6_CAPTURE",
                    missing: profile.missing ?? null,
                    partial: profile.partial ?? null,
                    cancelAttempts: profile.cancelAttempts ?? null,
                    modalHeaderHtml: profile.modalHeaderHtml ?? null,
                });
        }

        const identityCheck = verifyIdentity(profile.identity);
        if (!identityCheck.ok) {
            return errorResponse("IDENTITY_VERIFICATION_FAILED",
                `The CRC profile was read but did not pass verification: ${identityCheck.errors.join(" ")}`,
                { milestone: "M6_CAPTURE" });
        }

        const identity = Object.freeze({ ...profile.identity });
        const clientState = await readClientState(client.crcClientId).catch((error) => {
            console.warn(`client_state read failed (continuing without memory): ${error.message}`);
            return null;
        });

        const currentRound = Number(clientState?.current_round ?? data.currentRound ?? 1);
        const lastReportDateUsed = clientState?.last_report_date_used ?? null;

        // Legacy protection. A later-round client with no report baseline cannot
        // prove whether the selector report is fresh or the one already used.
        if (Number.isInteger(currentRound) && currentRound > 1 && !lastReportDateUsed) {
            return errorResponse(
                "HISTORICAL_REPORT_BASELINE_UNKNOWN",
                "This client is on Round 2 or later but AI Memory does not contain the report date used for the prior successful round. Processing stops rather than guessing whether the current report is fresh.",
                {
                    milestone: "M6_CAPTURE",
                    stage: "report_freshness_baseline",
                    crcClientId: client.crcClientId,
                    currentRound,
                    requiresHumanReview: true,
                }
            );
        }

        const processingRunId = randomUUID();
        const browserbaseSessionId = session.session?.id ?? null;
        const sessionStartedMs = Date.now();
        const captured = capturePayloads(context);

        const creditHero = await openCreditHero(page, context);

        if (!creditHero.ok && creditHero.nonActionable === true) {
            return errorResponse(
                "CHS_NOT_ACTIVATED",
                "The View CreditHeroScore Account control is present but not actionable, so there is no monitoring account to import from.",
                {
                    milestone: "M6_CAPTURE",
                    stage: "credit_hero",
                    crcClientId: client.crcClientId,
                    creditHeroAccessState: "CHS_NOT_ACTIVATED",
                    importAuditState: blocker.state,
                    observed: blocker.observed,
                    requiresInactiveWorkflow: true,
                    openCreditHeroAttempted: true,
                    controlNotActionable: true,
                    attempts: creditHero.attempts ?? null,
                    attemptLog: creditHero.attemptLog ?? null,
                    requiresHumanReview: false,
                }
            );
        }

        if (!creditHero.ok) {
            return errorResponse(creditHero.error_code ?? "CREDIT_HERO_UNAVAILABLE",
                creditHero.error ?? "Could not open Credit Hero.",
                {
                    milestone: "M6_CAPTURE",
                    attempts: creditHero.attempts ?? null,
                    attemptLog: creditHero.attemptLog ?? null,
                    requiresHumanReview: true,
                });
        }

        const chPage = creditHero.page;
        const chLanding = await recognizeCreditHeroLanding(chPage).catch(() => null);

        if (chLanding && chLanding.state === CH_LANDING_STATE.PAYMENT_REQUIRED) {
            return successResponse({
                milestone: "M6_CAPTURE",
                result: "PAYMENT_REQUIRED",
                stage: "credit_hero_landing",
                crcClientId: client.crcClientId,
                creditHeroLandingState: "PAYMENT_REQUIRED",
                classificationReason: chLanding.reason,
                evidence: chLanding.evidence,
                requiresInactiveWorkflow: true,
                diagnosticOnly: true,
                replayUrl,
            });
        }

        if (chLanding && chLanding.state === CH_LANDING_STATE.CREDENTIALS_OR_AUTH_FAILED) {
            return successResponse({
                milestone: "M6_CAPTURE",
                result: "CREDENTIALS_OR_AUTH_FAILED",
                stage: "credit_hero_landing",
                crcClientId: client.crcClientId,
                creditHeroLandingState: "CREDENTIALS_OR_AUTH_FAILED",
                classificationReason: chLanding.reason,
                evidence: chLanding.evidence,
                requiresInactiveWorkflow: true,
                diagnosticOnly: true,
                replayUrl,
            });
        }

        const memberDashboardUrl = chPage.url();
        let reportPage;
        let reportAcquiredInCatch = false;

        try {
            reportPage = await openCreditReport(chPage);
        } catch (error) {
            const orderRead = await readOrderPage(chPage).catch(() => null);

            if (orderRead && orderRead.classification === ORDER_STATE.WAITING_FOR_FREE_REPORT) {
                return successResponse({
                    milestone: "M6_CAPTURE",
                    result: "WAITING_FOR_FREE_REPORT",
                    stage: "order_page",
                    crcClientId: client.crcClientId,
                    classification: "WAITING_FOR_FREE_REPORT",
                    freeReportEnabled: orderRead.freeReportEnabled,
                    nextFreeReportAvailableAt: orderRead.nextFreeReportAvailableAt,
                    paidReportPresent: orderRead.paidReportPresent,
                    paidReportPrice: orderRead.paidReportPrice,
                    lastReportDate: orderRead.lastReportDate,
                    eligibilityHint: orderRead.eligibilityHint,
                    temporaryOverrideApplied: orderRead.temporaryOverrideApplied,
                    diagnosticOnly: true,
                    replayUrl,
                });
            }

            if (orderRead && orderRead.classification === ORDER_STATE.FREE_REPORT_AVAILABLE) {
                const acqBaselineReportDate = orderRead.lastReportDate ?? null;
                const acqOpenIntent = await readOpenIntent(client.crcClientId).catch(() => null);
                const acqRecovery = decideIntentRecovery(acqOpenIntent, acqBaselineReportDate);

                const acquisition = await runAcquisitionPath({
                    chPage,
                    crcClientId: client.crcClientId,
                    processingRunId,
                    browserbaseSessionId,
                    sessionStartedMs,
                    baselineReportDate: acqBaselineReportDate,
                    eligibilityHint: "FRESH_REPORT_REQUIRED",
                    reportPageUrl: null,
                    memberDashboardUrl,
                    openIntent: acqOpenIntent,
                    recovery: acqRecovery,
                    replayUrl,
                    submitApproved: data.submitApproved === true,
                    operationalRoutingApproved: data.operationalRoutingApproved === true,
                    clientName: data.clientName ?? null,
                    approvalTrace: data.approvalTrace,
                    approvalTraceLimit: data.approvalTraceLimit,
                });
                acquisitionEvidence = acquisition.evidence ?? acquisitionEvidence;
                if (!acquisition.proceedWithCapture) return acquisition.response;

                try {
                    reportPage = await openCreditReport(chPage);
                } catch (reopenError) {
                    return errorResponse("REPORT_REOPEN_FAILED_AFTER_ACQUISITION",
                        `A new free report was acquired but the report page could not be re-opened: ${reopenError.message}`,
                        { milestone: "M6_CAPTURE", stage: "post_acquisition", crcClientId: client.crcClientId, requiresHumanReview: true });
                }

                reportAcquiredInCatch = true;
            }

            if (!reportAcquiredInCatch) {
                return errorResponse("CREDIT_REPORT_PAGE_UNAVAILABLE",
                    `Could not reach the credit report page: ${error.message}`,
                    {
                        milestone: "M6_CAPTURE",
                        creditHeroLandingUrl: creditHero.currentUrl,
                        orderPageClassification: orderRead ? orderRead.classification : null,
                        requiresHumanReview: true,
                    });
            }
        }

        let selector = await readReportSelector(chPage);
        if (!selector.ok) {
            return errorResponse("REPORT_SELECTOR_UNREADABLE",
                `Could not read the report selector: ${selector.error} Freshness is read from the selector and never inferred, so this is a hard stop.`,
                {
                    milestone: "M6_CAPTURE",
                    selectsSeen: selector.selectsSeen ?? null,
                    creditHeroLandingUrl: creditHero.currentUrl,
                    reportPageUrl: reportPage.reportUrl,
                    currentUrl: selector.currentUrl ?? chPage.url(),
                    openedInNewTab: creditHero.openedInNewTab,
                });
        }

        let parsed = selector.selector;
        let baselineReportDate = parsed.newest?.reportDate ?? null;

        let openIntent = await readOpenIntent(client.crcClientId).catch(() => null);
        let recovery = decideIntentRecovery(openIntent, baselineReportDate);

        if (recovery.action === RECOVERY.RESOLVE_REPORT_AVAILABLE) {
            await resolveIntent(openIntent.id, INTENT_STATUS.REPORT_AVAILABLE, {
                reportDateAfter: recovery.reportDateAfter,
            }).catch(() => {});
        }

        const freshnessMemory = {
            last_report_date_used: lastReportDateUsed,
            newer_report_required: Number.isInteger(currentRound) && currentRound > 1,
        };

        let freshness = decideFreshness(parsed, data.memory ?? freshnessMemory);
        console.log(`Freshness decision: ${freshness.action} — ${freshness.reason}`);

        if (freshness.action === ACTION.MANUAL_REVIEW) {
            return errorResponse("FRESHNESS_MANUAL_REVIEW", freshness.reason, { milestone: "M6_CAPTURE" });
        }

        // Permanent future-round handoff: stale/same selector report goes into
        // the already-proven free-only acquisition path. No paid option can pass
        // decideAcquisition/selectAndSubmitFreeReport.
        if (freshness.action === ACTION.ACQUISITION_REQUIRED) {
            const acquisition = await runAcquisitionPath({
                chPage,
                crcClientId: client.crcClientId,
                processingRunId,
                browserbaseSessionId,
                sessionStartedMs,
                baselineReportDate,
                eligibilityHint: "FRESH_REPORT_REQUIRED",
                reportPageUrl: reportPage.reportUrl,
                memberDashboardUrl,
                openIntent,
                recovery,
                replayUrl,
                submitApproved: data.submitApproved === true,
                operationalRoutingApproved: data.operationalRoutingApproved === true,
                clientName: data.clientName ?? null,
                approvalTrace: data.approvalTrace,
                approvalTraceLimit: data.approvalTraceLimit,
            });
            acquisitionEvidence = acquisition.evidence ?? acquisitionEvidence;
            if (!acquisition.proceedWithCapture) return acquisition.response;

            selector = await readReportSelector(chPage);
            if (!selector.ok) {
                return errorResponse("REPORT_SELECTOR_UNREADABLE",
                    "A new report was acquired but the selector could not be re-read.",
                    { milestone: "M6_CAPTURE", stage: "post_acquisition", crcClientId: client.crcClientId, requiresHumanReview: true });
            }

            parsed = selector.selector;
            freshness = decideFreshness(parsed, data.memory ?? freshnessMemory);

            if (freshness.action !== ACTION.USE_NEWEST) {
                return errorResponse(
                    "FRESH_REPORT_NOT_VERIFIED",
                    freshness.reason ?? "A strictly newer report was not verified after acquisition.",
                    { milestone: "M6_CAPTURE", stage: "post_acquisition_freshness", crcClientId: client.crcClientId, requiresHumanReview: true }
                );
            }
        }

        if (freshness.action === ACTION.NO_ACTION_REQUIRED) {
            return errorResponse(
                "FRESH_REPORT_REQUIRED",
                "The newest report has already been used. A new dispute cycle cannot reuse it.",
                { milestone: "M6_CAPTURE", crcClientId: client.crcClientId, requiresHumanReview: false }
            );
        }

        const target = freshness.select;
        if (!target) {
            return errorResponse("NO_REPORT_SELECTED",
                `Freshness returned ${freshness.action} but supplied no report to select. ${freshness.reason}`,
                { milestone: "M6_CAPTURE" });
        }

        const selected = await selectReport(chPage, target);
        if (!selected.ok) {
            return errorResponse("REPORT_SELECT_FAILED", selected.error, { milestone: "M6_CAPTURE" });
        }

        const active = await verifyActiveReport(chPage, target);
        if (!active.ok) {
            return errorResponse("REPORT_NOT_VERIFIED_ACTIVE",
                `The report was selected but could not be VERIFIED as active: ${active.error}.`,
                { milestone: "M6_CAPTURE" });
        }

        creditHeroAccessVerified = true;
        await chPage.waitForTimeout(5000);

        const reportPayloads = captured.filter((c) => c.looksLikeCreditReport);
        if (reportPayloads.length === 0) {
            return errorResponse(
                "NO_REPORT_PAYLOAD_CAPTURED",
                `Captured ${captured.length} JSON response(s), but none looks like a credit report.`,
                { milestone: "M6_CAPTURE", creditHeroAccessVerified }
            );
        }

        const report = reportPayloads.sort((a, b) => b.size - a.size)[0];
        const addressCapture = await captureReportedAddresses(chPage);
        if (!addressCapture.ok) {
            return errorResponse("REPORTED_ADDRESS_CAPTURE_FAILED",
                `The report JSON was captured, but bureau-reported addresses could not be extracted (${addressCapture.stage}): ${addressCapture.reason}`,
                {
                    milestone: "M6_CAPTURE",
                    stage: `address_capture:${addressCapture.stage}`,
                    crcClientId: client.crcClientId,
                    requiresHumanReview: true,
                    creditHeroAccessVerified,
                });
        }

        const normalized = normalizeReport(report.payload, {
            crcClientId: client.crcClientId,
            previousReport: null,
            reportedAddresses: addressCapture.addresses,
        });

        if (!normalized.extraction_ok) {
            return errorResponse("EXTRACTION_FAILED",
                "The report was captured but could not be normalized with confidence. Nothing downstream runs on a report we do not fully trust.",
                {
                    milestone: "M6_CAPTURE",
                    extraction_errors: normalized.errors,
                    key_resolution: normalized.key_resolution,
                    completeness: normalized.completeness,
                    counts: normalized.counts,
                    requiresHumanReview: true,
                    creditHeroAccessVerified,
                    payload: report.payload,
                });
        }

        const verifiedReportDate = freshness.newestReportDate;

        return successResponse({
            milestone: "M6_CAPTURE",
            result: "CAPTURED",
            creditHeroAccessVerified,
            crcClientId: client.crcClientId,
            identity,
            identityVerified: true,
            creditHeroLandingUrl: creditHero.currentUrl,
            reportPageUrl: reportPage.reportUrl,
            reportSelected: {
                text: target.text,
                date: verifiedReportDate,
                verifiedActive: true,
            },
            selectorOptions: parsed.reports.map((r) => ({ text: r.text, date: r.reportDate })),
            selectorRejected: parsed.rejected,
            freshness: { action: freshness.action, reason: freshness.reason },
            // Once the report is proven strictly new for this client, it is
            // eligible for delivery. The old temporary July cutoff no longer
            // governs future-cycle freshness.
            classification: "ELIGIBLE_EXISTING_REPORT",
            lastReportDate: verifiedReportDate,
            eligibilityHint: "ELIGIBLE_EXISTING_REPORT",
            temporaryOverrideApplied: false,
            freeReportEnabled: null,
            nextFreeReportAvailableAt: null,
            paidReportPresent: null,
            paidReportPrice: null,
            capturedPayload: {
                url: report.url,
                size: report.size,
                topLevelKeys: report.topLevelKeys,
                analysis: report.analysis,
                skeleton: report.skeleton,
            },
            normalized: {
                extraction_ok: normalized.extraction_ok,
                model_version: normalized.report.model_version,
                report_metadata: normalized.report.report_metadata,
                counts: normalized.counts,
                key_resolution: normalized.key_resolution,
                completeness: normalized.completeness,
            },
            btCreditReportModel: normalized.report,
            allJsonResponses: captured.map((c) => ({
                url: c.url,
                size: c.size,
                topLevelKeys: c.topLevelKeys,
                looksLikeCreditReport: c.looksLikeCreditReport,
            })),
            payload: report.payload,
            normalized: false,
            reconciled: false,
            lettersGenerated: 0,
            message: "Report captured and verified active. Fresh-report gate passed.",
            replayUrl,
        });

    } catch (error) {
        console.error("Milestone 6 failed:", error);
        const message = String(error?.message ?? error);
        const isSessionClosed =
            /target.*closed|context or browser has been closed|browser has been closed|page.*closed/i.test(message);

        if (isSessionClosed) {
            return successResponse({
                milestone: "M6_CAPTURE",
                stage: "report_acquisition",
                result: "WAITING_FOR_FREE_REPORT",
                classification: "WAITING_FOR_FREE_REPORT",
                sessionEndedBeforeReport: true,
                sessionClosedError: message,
                ...(acquisitionEvidence ? acquisitionEvidence : {}),
                waitingForReportReadiness: true,
                message: "The Browserbase session closed before the new report was confirmed. Nothing was resubmitted.",
                diagnosticOnly: true,
            });
        }

        return errorResponse("MILESTONE_6_ERROR", error.message, { milestone: "M6_CAPTURE", creditHeroAccessVerified });
    } finally {
        if (browser) await browser.close();
    }
}

function capturePayloads(context) {
    const captured = [];

    context.on("response", async (response) => {
        try {
            const url = response.url();
            const contentType = (response.headers()["content-type"] || "").toLowerCase();
            if (!contentType.includes("json") && !/json/i.test(url)) return;

            const body = await response.text().catch(() => null);
            if (!body) return;

            let payload;
            try { payload = JSON.parse(body); } catch { return; }

            const topLevelKeys = payload && typeof payload === "object" ? Object.keys(payload) : [];
            captured.push({
                url,
                size: body.length,
                topLevelKeys,
                looksLikeCreditReport: looksLikeCreditReport(body),
                analysis: analyzeReportShape(payload),
                skeleton: buildSkeleton(payload),
                payload,
            });
        } catch {
            // Passive capture must never break the run.
        }
    });

    return captured;
}

function looksLikeCreditReport(body) {
    const markers = [
        /tradeline/i,
        /creditliability/i,
        /credit_?liability/i,
        /transunion/i,
        /experian/i,
        /equifax/i,
        /CREDIT_RESPONSE/i,
        /inquiry/i,
    ];
    return markers.filter((m) => m.test(body)).length >= 2;
}

const ACQUISITION_POLL_MS = 180000;
const ACQUISITION_POLL_INTERVAL_MS = 15000;
const BROWSERBASE_SESSION_BUDGET_MS = 300000;
const SESSION_SAFETY_MARGIN_MS = 30000;

async function runAcquisitionPath(ctx) {
    const {
        chPage, crcClientId, processingRunId, browserbaseSessionId,
        sessionStartedMs,
        baselineReportDate, eligibilityHint, reportPageUrl, memberDashboardUrl,
        replayUrl,
        submitApproved, operationalRoutingApproved,
        clientName: traceClientName, approvalTrace, approvalTraceLimit,
    } = ctx;

    let openIntent = ctx.openIntent;
    let recovery = ctx.recovery;

    const base = {
        milestone: "M6_CAPTURE",
        stage: "report_acquisition",
        crcClientId,
        processingRunId,
        lastReportDate: baselineReportDate,
        eligibilityHint,
        replayUrl,
    };

    if (recovery.action === RECOVERY.RESOLVE_FALSE_UNCONFIRMED) {
        await resolveIntent(openIntent.id, INTENT_STATUS.CANCELLED, {
            failureReason: recovery.reason ?? "unconfirmed_intent_resolved_false",
        }).catch(() => {});
        openIntent = null;
        recovery = { action: RECOVERY.NO_OPEN_INTENT, reason: "Prior unconfirmed intent resolved; proceeding." };
    }

    if (recovery.action === RECOVERY.WAIT_WITHIN_GRACE) {
        return {
            proceedWithCapture: false,
            response: successResponse({
                ...base,
                result: "WAITING_FOR_FREE_REPORT",
                classification: "WAITING_FOR_FREE_REPORT",
                acquisitionIntentOpen: true,
                acquisitionRecovery: recovery.action,
                acquisitionRecoveryReason: recovery.reason,
                freeReportEnabled: null,
                nextFreeReportAvailableAt: null,
                paidReportPresent: null,
                paidReportPrice: null,
                temporaryOverrideApplied: false,
                diagnosticOnly: true,
            }),
        };
    }

    if (recovery.action === RECOVERY.MANUAL_REVIEW) {
        return {
            proceedWithCapture: false,
            response: errorResponse("ACQUISITION_INTENT_UNRESOLVED", recovery.reason, {
                ...base,
                acquisitionIntentOpen: true,
                acquisitionRecovery: recovery.action,
                requiresHumanReview: true,
            }),
        };
    }

    const navigated = await navigateToOrderPage(chPage, { memberDashboardUrl });
    if (!navigated.ok) {
        return {
            proceedWithCapture: false,
            response: errorResponse(
                navigated.error_code ?? "ORDER_PAGE_UNREACHABLE",
                navigated.error ?? "Could not reach the Credit Hero order page.",
                {
                    ...base,
                    searchedPage: navigated.searchedPage ?? null,
                    memberDashboardSearched: navigated.memberDashboardSearched ?? false,
                    candidateControls: navigated.candidateControls ?? null,
                    requiresHumanReview: true,
                }
            ),
        };
    }

    const orderState = await readOrderPageOptions(chPage).catch(() => null);
    if (!orderState || !orderState.page_read) {
        return {
            proceedWithCapture: false,
            response: errorResponse(
                "ORDER_PAGE_UNREADABLE",
                "The order page was reached but its purchase options could not be read. A page we cannot fully account for is a page we do not act on.",
                { ...base, requiresHumanReview: true }
            ),
        };
    }

    const decision = decideAcquisition(orderState, {
        newer_report_required: true,
        open_acquisition_intent: openIntent ?? null,
    });

    const decisionRecord = {
        decision: decision.decision,
        reason: decision.reason,
        freeAvailable: decision.free_available,
        paidAvailable: decision.paid_available,
        selectedOption: decision.selected_option ?? null,
        excludedPaidOption: decision.excluded_paid_option ?? null,
        optionsObserved: orderState.options.map((o) => ({
            id: o.id,
            cost: o.cost,
            disabled: o.disabled,
            visible: o.visible,
            visibilityEvidence: o.visibility_evidence ?? null,
            available_from: o.available_from,
        })),
        unaccountedOptionIds: orderState.unaccounted_option_ids,
    };

    if (decision.decision === DECISIONS.FREE_REPORT_NOT_YET_AVAILABLE) {
        return {
            proceedWithCapture: false,
            response: successResponse({
                ...base,
                result: "WAITING_FOR_FREE_REPORT",
                classification: "WAITING_FOR_FREE_REPORT",
                freeReportEnabled: false,
                nextFreeReportAvailableAt: decision.available_from ?? null,
                paidReportPresent: decision.paid_available === true,
                paidReportPrice: decisionRecord.optionsObserved.find((o) => o.cost > 0)?.cost ?? null,
                temporaryOverrideApplied: false,
                acquisitionDecision: decisionRecord,
                diagnosticOnly: true,
            }),
        };
    }

    if (decision.decision === DECISIONS.MANUAL_REVIEW) {
        return {
            proceedWithCapture: false,
            response: errorResponse("ACQUISITION_MANUAL_REVIEW", decision.reason, {
                ...base,
                acquisitionDecision: decisionRecord,
                requiresHumanReview: true,
            }),
        };
    }

    if (decision.decision !== DECISIONS.SUBMIT_FREE_REPORT) {
        return {
            proceedWithCapture: false,
            response: errorResponse(
                "ACQUISITION_DECISION_UNEXPECTED",
                `The decision engine returned "${decision.decision}", which is not a basis for acquiring or proceeding.`,
                { ...base, acquisitionDecision: decisionRecord, requiresHumanReview: true }
            ),
        };
    }

    const submissionFlag = describeSubmissionFlag();
    const gateState = {
        environmentFlag: submissionFlag.enabled,
        submitApproved: submitApproved === true,
        operationalRoutingApproved: operationalRoutingApproved === true,
    };
    const blockedGates = Object.keys(gateState).filter((gate) => gateState[gate] !== true);

    if (Array.isArray(approvalTrace)) {
        const limit = Number.isInteger(approvalTraceLimit) ? approvalTraceLimit : 200;
        if (approvalTrace.length < limit) {
            approvalTrace.push({
                jobId: null,
                clientName: traceClientName ?? null,
                processingApproved: null,
                diagnosticOnly: null,
                submitApproved: gateState.submitApproved,
                operationalRoutingApproved: gateState.operationalRoutingApproved,
                inactiveWorkflowApproved: null,
                executionMode: null,
                stage: "acquisition_gate",
                timestamp: new Date().toISOString(),
            });
        }
    }

    if (blockedGates.length > 0) {
        return {
            proceedWithCapture: false,
            response: successResponse({
                ...base,
                result: "FREE_REPORT_OBSERVATION_ONLY",
                classification: "FREE_REPORT_AVAILABLE",
                submissionEnabled: submissionFlag.enabled,
                blockedGates,
                gateState,
                submissionFlagReason: submissionFlag.reason,
                submissionFlagWasQuoted: submissionFlag.wasQuoted ?? null,
                wouldSubmit: true,
                acquisitionDecision: decisionRecord,
                freeReportEnabled: true,
                intentCreated: false,
                reportOrdered: false,
                submissionAttempted: false,
                submissionConfirmed: false,
                safelyBlocked: true,
                waitingForReportReadiness: false,
                diagnosticOnly: true,
            }),
        };
    }

    const intent = await createIntent({
        crcClientId,
        processingRunId,
        decision: decision.decision,
        creditHeroOptionId: decision.selected_option?.id ?? null,
        observedCost: decision.selected_option?.cost ?? null,
        reportDateBefore: baselineReportDate,
        browserbaseSessionId,
        metadata: { cost_evidence: decision.selected_option?.cost_evidence ?? null },
    });

    if (!intent.ok) {
        return {
            proceedWithCapture: false,
            response: errorResponse(
                "ACQUISITION_INTENT_NOT_CREATED",
                intent.detail ?? intent.reason,
                { ...base, acquisitionDecision: decisionRecord, intentBlockedReason: intent.reason, requiresHumanReview: true }
            ),
        };
    }

    const submission = await selectAndSubmitFreeReport(chPage, {
        optionId: decision.selected_option.id,
        observedCost: decision.selected_option.cost,
        approvals: {
            submitApproved: gateState.submitApproved,
            operationalRoutingApproved: gateState.operationalRoutingApproved,
        },
        onSubmissionStarted: () => markSubmissionStarted(intent.intent.id),
    });

    if (!submission.submitClicked) {
        if (!submission.optionSelected) {
            await resolveIntent(intent.intent.id, INTENT_STATUS.CANCELLED, {
                failureReason: submission.failureReason ?? submission.error_code ?? "not_submitted",
            }).catch(() => {});
        }

        return {
            proceedWithCapture: false,
            response: errorResponse(
                submission.error_code ?? "FREE_REPORT_NOT_SUBMITTED",
                submission.failureReason ?? "The free report was not submitted.",
                { ...base, acquisitionDecision: decisionRecord, submission, requiresHumanReview: true }
            ),
        };
    }

    if (submission.submissionConfirmed !== true) {
        const failureReason = submission.error_code
            ? `${submission.error_code}: ${submission.failureReason ?? "submission not confirmed"}`
            : submission.failureReason ?? "submission_not_confirmed";

        await resolveIntent(intent.intent.id, INTENT_STATUS.FAILED, { failureReason }).catch(() => {});

        return {
            proceedWithCapture: false,
            response: successResponse({
                ...base,
                result: "WAITING_FOR_FREE_REPORT",
                classification: "WAITING_FOR_FREE_REPORT",
                reportOrdered: false,
                submissionAttempted: true,
                submissionConfirmed: false,
                acquisitionIntentOpen: false,
                acquisitionIntentResolvedAs: INTENT_STATUS.FAILED,
                intentId: intent.intent.id,
                intentFailureReason: failureReason,
                acquisitionDecision: decisionRecord,
                gateState,
                diagnosticOnly: true,
            }),
        };
    }

    await markSubmitted(intent.intent.id).catch(() => {});

    const confirmedEvidence = {
        intentId: intent.intent.id,
        intentStatus: INTENT_STATUS.SUBMITTED,
        preInvokeCheck: submission.preInvokeCheck ?? null,
        orderSelectInvoked: submission.orderSelectInvoked ?? true,
        orderSelectError: submission.orderSelectError ?? null,
        reachedOrderPost: submission.reachedOrderPost ?? true,
        ajaxErrorShown: submission.ajaxErrorShown ?? null,
        reachedConfirmPaymentPage: submission.reachedConfirmPaymentPage ?? null,
        confirmProductMatched: submission.confirmProductMatched ?? null,
        confirmedPrice: submission.confirmedPrice ?? null,
        secondSubmitPresent: submission.secondSubmitPresent ?? null,
        secondSubmitClicked: submission.secondSubmitClicked ?? null,
        orderPostObserved: submission.orderPostObserved ?? null,
        orderPostHttpStatus: submission.orderPostHttpStatus ?? null,
        reachedThankYouPage: submission.reachedThankYouPage ?? null,
        submissionConfirmed: true,
        urlBefore: submission.urlBefore ?? null,
        urlAfter: submission.urlAfter ?? null,
        reportOrdered: true,
    };

    const safeSessionDeadline =
        (Number.isFinite(sessionStartedMs) ? sessionStartedMs : Date.now()) +
        BROWSERBASE_SESSION_BUDGET_MS - SESSION_SAFETY_MARGIN_MS;
    const deadline = Math.min(Date.now() + ACQUISITION_POLL_MS, safeSessionDeadline);

    while (Date.now() < deadline) {
        if (chPage.isClosed()) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(ACQUISITION_POLL_INTERVAL_MS, remaining)));
        if (chPage.isClosed()) break;

        if (reportPageUrl) {
            await chPage.goto(reportPageUrl, { waitUntil: "load" }).catch(() => {});
        } else {
            await openCreditReport(chPage).catch(() => {});
        }

        if (chPage.isClosed()) break;
        const fresh = await readReportSelector(chPage).catch(() => ({ ok: false }));
        if (!fresh.ok) continue;

        const newer = hasNewerReport(fresh.selector, baselineReportDate);
        if (newer.appeared) {
            await resolveIntent(intent.intent.id, INTENT_STATUS.REPORT_AVAILABLE, {
                reportDateAfter: newer.reportDate,
            }).catch(() => {});

            return {
                proceedWithCapture: true,
                evidence: { ...confirmedEvidence, submissionConfirmed: true },
                acquisitionOutcome: {
                    submissionAttempted: true,
                    submissionConfirmed: true,
                    safelyBlocked: false,
                    waitingForReportReadiness: false,
                    reportDateAfter: newer.reportDate,
                },
            };
        }
    }

    return {
        proceedWithCapture: false,
        evidence: confirmedEvidence,
        response: successResponse({
            ...base,
            result: "WAITING_FOR_FREE_REPORT",
            classification: "WAITING_FOR_FREE_REPORT",
            reportOrdered: true,
            acquisitionIntentOpen: true,
            intentId: intent.intent.id,
            intentStatus: INTENT_STATUS.SUBMITTED,
            acquisitionDecision: decisionRecord,
            analyzedOlderReport: false,
            submissionAttempted: true,
            submissionConfirmed: true,
            reachedOrderPost: true,
            safelyBlocked: false,
            waitingForReportReadiness: true,
            sessionEndedBeforeReport: chPage.isClosed() || Date.now() >= safeSessionDeadline,
            gateState,
            freeReportEnabled: false,
            nextFreeReportAvailableAt: null,
            paidReportPresent: null,
            paidReportPrice: null,
            temporaryOverrideApplied: false,
            message: "The free report was submitted but no strictly newer report appeared before the safe session deadline. The older report was NOT analyzed.",
        }),
    };
}
