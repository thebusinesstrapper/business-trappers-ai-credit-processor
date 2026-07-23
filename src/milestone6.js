/**
 * milestone6.js
 *
 * REAL REPORT CAPTURE — GOALS 1 THROUGH 3 ONLY.
 *
 * ===========================================================================
 * WHAT THIS DOES:
 *
 *   1. Read the verified CRC client profile      (FROZEN — Identity Source Standard)
 *   2. Open Credit Hero                          (M3)
 *   3. Read the report selector                  (Report Selector Authority §1.2)
 *   4. Select the NEWEST report
 *   5. VERIFY the selected report is genuinely ACTIVE before reading anything
 *   6. Passively capture the Array.io MISMO JSON
 *   7. Return the RAW payload and a STRUCTURAL INVENTORY
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *
 *   - Normalize. There is no BT Credit Report Model™ built here.
 *   - Reconcile.
 *   - Generate letters.
 *
 * ===========================================================================
 * WHY IT STOPS AT RAW.
 *
 * The Extraction System §10 is binding: NO SELECTORS ARE GUESSED, NO PARSER IS
 * WRITTEN UNTIL THE REAL STRUCTURE IS KNOWN.
 *
 * Nobody has yet seen the real Array.io MISMO payload for this client. A parser
 * written against an imagined schema would not fail loudly — it would return
 * `null` for every field it guessed wrong, and §6.1 of the Extraction System
 * says exactly what happens next: the Intelligence Engine detects deletions BY
 * ABSENCE, so tradelines we merely failed to parse become **fabricated
 * deletions**, which flow into strategy and then into a letter.
 *
 * So this run produces EVIDENCE, not a model. The normalizer is written against
 * what comes back — exactly as the Milestone 4 eligibility engine was.
 *
 * THE ONE THING THIS RUN MUST NEVER DO: click anything that could cost the
 * client money. The report page carries order and reactivation controls. This
 * run reads. It does not act.
 * ===========================================================================
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
import { navigateToOrderPage, selectAndSubmitFreeReport, isSubmissionEnabled } from "./orderFreeReport.js";
import {
    readOpenIntent, createIntent, markSubmissionStarted, markSubmitted,
    resolveIntent, decideIntentRecovery, INTENT_STATUS, RECOVERY,
} from "./acquisitionIntent.js";
import { readClientState } from "./clientMemory.js";
import { randomUUID } from "node:crypto";
import { openCreditReport } from "./openCreditReport.js";
import { normalizeReport } from "./reportNormalize.js";
import { readReportSelector, selectReport, verifyActiveReport } from "./reportSelector.js";
import { decideFreshness, hasNewerReport, ACTION } from "./reportFreshness.js";
import { analyzeReportShape, buildSkeleton } from "./spikeReportJson.js";

export async function runMilestone6(data = {}) {
    let browser;

    try {
        const clientName = data.clientName || "Elizabeth Kelley";

        const session = await launchBrowser();
        browser = session.browser;

        const page = session.page;

        // openCreditHero() needs the CONTEXT, not just the page: CRC opens
        // CreditHeroScore in a NEW TAB, and that tab arrives as a context-level
        // "page" event. Omitting it is what threw the waitForEvent error —
        // `context` was undefined.
        const context = session.context;
        const replayUrl = `https://www.browserbase.com/sessions/${session.session.id}`;

        console.log(`Browserbase replay: ${replayUrl}`);

        // ---- 1. IDENTITY (frozen, authoritative) ---------------------------
        await loginToCRC(page);

        const client = await openClient(page, clientName);

        if (!client.clientFound || !client.clientOpened) {
            return errorResponse("CLIENT_NOT_OPENED", `Could not open client "${clientName}".`, { milestone: "M6_CAPTURE" });
        }

        const profile = await readClientProfile(page, client.crcClientId);

        if (!profile.ok) {
            return errorResponse(profile.error_code,
                `Identity could not be established: ${profile.error} ` +
                    `Extraction does not proceed without a verified CRC identity.`,
                {
                    milestone: "M6_CAPTURE",

                    // M6 was swallowing these. Without them, "required fields missing"
                    // says nothing about WHICH fields, or what was actually read — which
                    // is why this failure looked like an architectural problem rather
                    // than a race we could see.
                    missing: profile.missing ?? null,
                    partial: profile.partial ?? null,

                    cancelAttempts: profile.cancelAttempts ?? null,
                    modalHeaderHtml: profile.modalHeaderHtml ?? null,
                });
        }

        const identityCheck = verifyIdentity(profile.identity);

        if (!identityCheck.ok) {
            return errorResponse("IDENTITY_VERIFICATION_FAILED",
                `The CRC profile was read but did not pass verification: ${identityCheck.errors.join(" ")}`, { milestone: "M6_CAPTURE" });
        }

        // ---- FREEZE THE VERIFIED IDENTITY ----------------------------------
        //
        // Identity is established ONCE per processing cycle and is not re-read. It
        // is a PREREQUISITE to report acquisition, not a part of it, and reopening
        // the profile after leaving the dashboard would risk a second read
        // disagreeing with the first — at which point we would not know which one
        // signs the letter.
        //
        // Object.freeze makes that structural rather than merely intended: nothing
        // downstream can mutate the identity that goes on a bureau letter.
        const identity = Object.freeze({ ...profile.identity });

        console.log(`Identity verified and FROZEN: ${identity.name} (CRC ${client.crcClientId})`);

        // ---- AI MEMORY: READ ONCE, HERE ------------------------------------
        //
        // The earliest point at which crcClientId is authoritative, and the last
        // point before any decision needs memory. Every earlier failure path
        // (client not opened, profile unreadable, identity unverified) returns
        // above this line, so those runs pay nothing for it.
        //
        // ONE READ PER RUN. The row is threaded through the rest of this
        // function as a local. Nothing below re-reads it — a second read could
        // disagree with the first, and we would not know which one governed the
        // decision that spent a client's entitlement.
        //
        // Failure is non-fatal: memory informs freshness, it does not gate
        // capture. A null row simply means "no prior processing recorded."
        const clientState = await readClientState(client.crcClientId).catch((error) => {
            console.warn(`client_state read failed (continuing without memory): ${error.message}`);
            return null;
        });

        // ONE run id for this entire M6 execution, reused across every
        // acquisition-intent row it writes. Generated here so that a run which
        // never acquires anything still has one, and so no code path can invent
        // a second one mid-run.
        const processingRunId = randomUUID();
        const browserbaseSessionId = session.session?.id ?? null;

        // ---- 2. ATTACH THE PASSIVE LISTENER *BEFORE* NAVIGATING ------------
        //
        // This is a response listener. It catches what the page fetches AS the
        // page fetches it. Attached after the report has loaded, it catches
        // nothing at all — and would report "no payload found" on a page that had
        // already delivered one.
        //
        // Retains the FULL parsed payload, not just a skeleton: the Normalization
        // Engine has to be written against the real structure, and a skeleton
        // tells us the shape without giving us a fixture to test against.
        // ATTACHED TO THE CONTEXT, NOT THE PAGE.
        //
        // CreditHeroScore opens in a NEW TAB. A listener bound to the CRC dashboard
        // page would sit on the wrong tab and capture NOTHING — and the run would
        // report "no report payload captured" with no hint that the listener had
        // been watching an idle page the entire time. A context-level listener sees
        // every page in the session, including tabs that do not exist yet.
        const captured = capturePayloads(context);

        // ---- 2b. CREDIT HERO ACCESS STATE (dashboard, read-only) -----------
        //
        // Read the dashboard BEFORE trying to open CreditHero. A client who never
        // enrolled has a greyed control that is not detectably disabled —
        // openCreditHero's isEnabled() check does not catch CRC's styling, so the
        // link is clicked three times and reported as "click did not navigate".
        // That is indistinguishable from a slow page, and it is the wrong answer:
        // nothing was slow, there is no account.
        //
        // The BANNER is the evidence. This mirrors the rule already stated in
        // importAuditState.js, that the page MESSAGE is authoritative and the
        // button carries no signal.
        //
        // Positive banner only. Greyed styling, aria-disabled, isEnabled(), a
        // click that does not navigate, and CREDIT_HERO_UNAVAILABLE all remain
        // technical results routed to manual review.
        const blocker = await recognizeDashboardBlocker(page);

        if (blocker.blocked) {
            console.log("Credit Hero Score is not activated for this client. Not attempting to open it.");

            // Stop here. No CreditHero click, no report capture, no M7, no M8, no
            // message, no status write, no Supabase write, no round change.
            return errorResponse(
                "CHS_NOT_ACTIVATED",
                "Credit Hero Score monitoring is not active for this client. The client dashboard " +
                    "shows the invite banner, so there is no monitoring account to import from.",
                {
                    milestone: "M6_CAPTURE",
                    stage: "credit_hero",

                    // The inactive workflow keys its Supabase writes on this. It is
                    // already grounded from openClient() above; omitting it made the
                    // whole result unaddressable.
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

        // ---- 3. CREDIT HERO ------------------------------------------------
        const creditHero = await openCreditHero(page, context);

        // ---- THE CONTROL WAS PRESENT BUT DEAD ------------------------------
        //
        // openCreditHero() distinguishes "this control is positively disabled /
        // has no destination and never navigated, on every attempt" from "we
        // could not open CreditHero." The first is a BUSINESS STATE — there is
        // no monitoring account — and is identical in meaning to the dashboard
        // invite banner handled above.
        //
        // It therefore returns the SAME CHS_NOT_ACTIVATED shape, field for
        // field, so the existing inactive workflow picks it up unchanged. No new
        // downstream branch is introduced, and requiresInactiveWorkflow is what
        // processProductionClient.js already keys on.
        if (!creditHero.ok && creditHero.nonActionable === true) {
            console.log(
                "The CreditHeroScore control is present but not actionable. " +
                "Treating as an inactive account, not a technical failure."
            );

            return errorResponse(
                "CHS_NOT_ACTIVATED",
                "The \"View CreditHeroScore Account\" control is present on the client dashboard " +
                    "but is not actionable, so there is no monitoring account to import from.",
                {
                    milestone: "M6_CAPTURE",
                    stage: "credit_hero",
                    crcClientId: client.crcClientId,
                    creditHeroAccessState: "CHS_NOT_ACTIVATED",
                    importAuditState: blocker.state,
                    observed: blocker.observed,
                    requiresInactiveWorkflow: true,
                    openCreditHeroAttempted: true,
                    // How we concluded it, so the classification can be audited
                    // rather than trusted.
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

                    // WHY EACH ATTEMPT FAILED. Without this, three identical retries
                    // produce one identical error and tell us nothing about whether
                    // the control was missing, invisible, disabled, or silently
                    // swallowing the click.
                    attempts: creditHero.attempts ?? null,
                    attemptLog: creditHero.attemptLog ?? null,
                    requiresHumanReview: true,
                });
        }

        // ---- ADOPT THE PAGE CREDIT HERO ACTUALLY LANDED ON ------------------
        //
        // openCreditHero returns the page it landed on. If CreditHero opened in a
        // NEW TAB, `page` still points at the CRC dashboard — and every subsequent
        // read (selector, selection, activation) would query the wrong tab and fail
        // in a way that looks like Credit Hero being broken.
        const chPage = creditHero.page;

        // ---- STAGE 1 (READ-ONLY): CREDIT HERO LANDING STATE ----------------
        //
        // Diagnostic only. Classifies the page CreditHero landed on. No status,
        // message, order, payment, or Supabase write happens here — the result is
        // surfaced for classification and the existing flow continues unchanged.
        const chLanding = await recognizeCreditHeroLanding(chPage).catch(() => null);

        if (chLanding && chLanding.state === CH_LANDING_STATE.PAYMENT_REQUIRED) {
            return successResponse({
                milestone: "M6_CAPTURE",
                result: "PAYMENT_REQUIRED",
                stage: "credit_hero_landing",
                // Verified, in-scope ID from openClient's confirmed dashboard URL.
                // Same value the CHS_NOT_ACTIVATED return already forwards.
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
                requiresHumanReview: true,
                diagnosticOnly: true,
                replayUrl,
            });
        }

        console.log(
            creditHero.openedInNewTab
                ? "CreditHeroScore opened in a NEW TAB — adopting that page handle."
                : "CreditHeroScore navigated in the current tab."
        );

        // ---- 4. NAVIGATE INTO THE REPORT PAGE ------------------------------
        //
        // openCreditHero lands on the Credit Hero MEMBER DASHBOARD
        // (mcc_creditscores.asp). The report selector does not live there — it
        // lives on the REPORT page (mcc_creditreports_v2.asp), reached via the
        // View Report link.
        //
        // M6 was reading the selector straight off the landing page, which has no
        // selector to read, and reporting REPORT_SELECTOR_UNREADABLE. The reader
        // was never wrong; it was pointed at the wrong page.
        //
        // openCreditReport() is the VALIDATED navigator from the acquisition
        // spikes. It finds the link (it never CONSTRUCTS the URL — we know the
        // filename, not the path, and a guessed path is a guessed navigation on a
        // site with an order page on it), and it hard-blocks
        // mcc_order_select_v2.asp both BEFORE navigating and AFTER landing —
        // because Credit Hero redirects to the ORDER page when no report is
        // available, and we would arrive somewhere that costs the client money
        // without ever having asked to go there.
        //
        // NOTE THE CONTRACT: openCreditReport returns { reportOpened: true, ... }
        // and THROWS on failure. It does NOT return `ok`. Checking `!report.ok`
        // would be false-negative on every successful run — exactly the bug that
        // made openCreditHero report CREDIT_HERO_UNAVAILABLE while succeeding.
        // CAPTURED BEFORE WE LEAVE. openCreditReport() navigates this same handle
        // onward to the report page, and "ORDER NEW REPORT" does not exist there
        // — it lives here, on the member dashboard. Read live from the browser,
        // so the acquisition path can return to a page we genuinely visited
        // instead of constructing an address for one.
        const memberDashboardUrl = chPage.url();

        let reportPage;

        try {
            reportPage = await openCreditReport(chPage);
        } catch (error) {
            // The order-page guard throws too. That is NOT a retryable condition —
            // it means Credit Hero tried to send us somewhere that spends the
            // client's money, and the correct response is to stop, not to try again.
            //
            // STAGE 1 (READ-ONLY): before failing, read the order page we were
            // redirected to and classify it. This ONLY reads — the reader has no
            // click/select/submit/goto — and it never removes the guard that
            // brought us here. openCreditReport still refuses to navigate to the
            // order page on the normal path; this classifies a page we already
            // landed on.
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
                return successResponse({
                    milestone: "M6_CAPTURE",
                    result: "FREE_REPORT_AVAILABLE",
                    stage: "order_page",
                    crcClientId: client.crcClientId,
                    classification: "FREE_REPORT_AVAILABLE",
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

            return errorResponse("CREDIT_REPORT_PAGE_UNAVAILABLE",
                `Could not reach the credit report page: ${error.message}`,
                {
                    milestone: "M6_CAPTURE",
                    creditHeroLandingUrl: chPage.url(),
                    orderPageClassification: orderRead ? orderRead.classification : null,
                    requiresHumanReview: true,
                });
        }

        console.log(`On the report page: ${reportPage.reportUrl}`);

        // ---- 5. THE REPORT SELECTOR IS AUTHORITATIVE FOR FRESHNESS ---------
        //
        // Not the CRC timer, not the order page, not elapsed time. Those describe
        // when a report BECOMES ORDERABLE. The selector enumerates WHAT EXISTS.
        // Freshness is READ, never INFERRED.
        const selector = await readReportSelector(chPage);

        if (!selector.ok) {
            return errorResponse("REPORT_SELECTOR_UNREADABLE",
                `Could not read the report selector: ${selector.error} Freshness is read from the ` +
                    `selector and never inferred, so this is a hard stop.`,
                {
                    milestone: "M6_CAPTURE",

                    // EVERY visible <select> we saw, with its options. This is what
                    // separates "we are on the wrong page" (zero selects) from "we are
                    // on the right page but the dropdown had not populated" (selects
                    // present, options not report dates). The old error pointed at
                    // neither, which is why a timing race looked like a broken reader.
                    selectsSeen: selector.selectsSeen ?? null,

                    // BOTH urls. If reportPageUrl is mcc_creditreports_v2.asp and the
                    // selector is still unreadable, the problem is genuinely the
                    // selector — not the navigation. That distinction is the whole
                    // point of recording where we were standing when we looked.
                    creditHeroLandingUrl: creditHero.currentUrl,
                    reportPageUrl: reportPage.reportUrl,
                    currentUrl: selector.currentUrl ?? chPage.url(),
                    openedInNewTab: creditHero.openedInNewTab,
                });
        }

        // `let`, not `const`: a confirmed free-report acquisition below re-reads
        // the selector, and everything after this point must then operate on the
        // NEW report rather than the pre-acquisition snapshot.
        let parsed = selector.selector; // { reports, rejected, newest, count }

        console.log(`Report selector: ${parsed.count} report(s) positively identified.`);
        parsed.reports.forEach((r) => console.log(`  - ${r.text} -> ${r.reportDate}`));

        if (parsed.rejected.length) {
            console.log(`  ${parsed.rejected.length} option(s) rejected as not-a-report:`);
            parsed.rejected.forEach((r) => console.log(`    - "${r.text}" (${r.reason})`));
        }

        // ---- THE ROLLOUT CUTOFF GATE, EVALUATED BEFORE ANYTHING IS READ ----
        //
        // WHY IT LIVES HERE. This rule was previously computed only on the
        // SUCCESS response, far below — after the report had already been
        // selected, captured and normalized. By then it can gate nothing. A
        // client whose newest report predates the cutoff was processed anyway,
        // and the hint was reported as a diagnostic on work already done.
        //
        // The selector is authoritative for what EXISTS (Report Selector
        // Authority §1.2), so its newest date is what the cutoff is applied to.
        // computeEligibilityHint() is reused rather than reimplemented — the
        // order-page reader applies the identical rule, and two copies of a date
        // cutoff is how they drift apart.
        const baselineReportDate = parsed.newest?.reportDate ?? null;
        const eligibilityHint = computeEligibilityHint(baselineReportDate, null);

        // ---- INTENT RECOVERY, BEFORE ANY ACQUISITION DECISION --------------
        //
        // Runs on EVERY path, eligible or not: an intent left open by a previous
        // run must be reconciled against what the selector now shows before this
        // run decides anything. Recovery is confirmation of EFFECT — it never
        // resubmits.
        const openIntent = await readOpenIntent(client.crcClientId).catch((error) => {
            console.warn(`Acquisition-intent read failed: ${error.message}`);
            return null;
        });

        let recovery = decideIntentRecovery(openIntent, baselineReportDate);

        if (recovery.action === RECOVERY.RESOLVE_REPORT_AVAILABLE) {
            console.log(`Recovering open acquisition intent: ${recovery.reason}`);

            await resolveIntent(openIntent.id, INTENT_STATUS.REPORT_AVAILABLE, {
                reportDateAfter: recovery.reportDateAfter,
            }).catch((error) => {
                console.warn(`Intent resolution failed: ${error.message}`);
            });
        }

        if (eligibilityHint !== "ELIGIBLE_EXISTING_REPORT") {
            const acquisition = await runAcquisitionPath({
                chPage,
                crcClientId: client.crcClientId,
                processingRunId,
                browserbaseSessionId,
                baselineReportDate,
                eligibilityHint,
                reportPageUrl: reportPage.reportUrl,
                memberDashboardUrl,
                openIntent,
                recovery,
                replayUrl,
            });

            if (!acquisition.proceedWithCapture) return acquisition.response;

            // A strictly newer report was confirmed. Re-read the selector so
            // every step below sees the NEW report. We do not reuse the
            // pre-acquisition snapshot — that is precisely how a stale report
            // gets analyzed while we believe it is the fresh one.
            const refreshed = await readReportSelector(chPage);

            if (!refreshed.ok) {
                return errorResponse("REPORT_SELECTOR_UNREADABLE",
                    `A new report was acquired but the selector could not be re-read: ` +
                        `${refreshed.error}`,
                    {
                        milestone: "M6_CAPTURE",
                        stage: "post_acquisition",
                        crcClientId: client.crcClientId,
                        requiresHumanReview: true,
                    });
            }

            parsed = refreshed.selector;
        }

        // decideFreshness takes TWO positional arguments: (selector, memory).
        // Passing a single object leaves `newest` and `count` undefined, which
        // resolves to MANUAL_REVIEW — a fail-closed default that would halt every
        // run on every client while looking like a legitimate refusal.
        // REAL MEMORY, not `{}`. last_report_date_used is what lets
        // decideFreshness recognize a report it has already analyzed; passing an
        // empty object made NO_ACTION_REQUIRED and ACQUISITION_REQUIRED
        // unreachable in production. An explicit data.memory still wins, so
        // existing callers and tests are unaffected.
        const freshness = decideFreshness(parsed, data.memory ?? {
            last_report_date_used: clientState?.last_report_date_used ?? null,
            newer_report_required: false,
        });

        console.log(`Freshness decision: ${freshness.action} — ${freshness.reason}`);

        if (freshness.action === ACTION.MANUAL_REVIEW) {
            return errorResponse("FRESHNESS_MANUAL_REVIEW", freshness.reason, { milestone: "M6_CAPTURE" });
        }

        // NO_ACTION_REQUIRED means memory has already analyzed this report. That is
        // a decision about whether a DISPUTE CYCLE is due — not about whether we may
        // read the report. This milestone is capture only, so we proceed.
        if (freshness.action === ACTION.NO_ACTION_REQUIRED) {
            console.log("Memory has seen this report before. Capturing anyway — this run is capture-only.");
        }

        if (freshness.action === ACTION.ACQUISITION_REQUIRED) {
            // The Order Submitter is NOT authorized. We halt exactly where it
            // would have acted, rather than falling back to an older report.
            return successResponse({
                milestone: "M6_CAPTURE",
                result: "CAPABILITY_UNAVAILABLE",
                message:
                    "A newer report is required, but the Order Submitter is not authorized in this " +
                    "version. The processor does not fall back to an older report — analysing a stale " +
                    "report means asserting facts that may no longer be true, in the consumer's voice.",
                freshness,
                replayUrl,
            });
        }

        // ---- 5. SELECT THE NEWEST ------------------------------------------
        //
        // freshness.select is { value, text } — the shape selectReport() expects.
        const target = freshness.select;

        if (!target) {
            return errorResponse("NO_REPORT_SELECTED",
                `Freshness returned ${freshness.action} but supplied no report to select. ${freshness.reason}`, { milestone: "M6_CAPTURE" });
        }

        console.log(`Selecting newest report: ${target.text} (${freshness.newestReportDate})`);

        const selected = await selectReport(chPage, target);

        if (!selected.ok) {
            return errorResponse("REPORT_SELECT_FAILED", selected.error, { milestone: "M6_CAPTURE" });
        }

        // ---- 6. VERIFY IT IS GENUINELY ACTIVE ------------------------------
        //
        // selectOption() returning proves only that Playwright set the value —
        // NOT that the app reacted. If Credit Hero swallowed the change event we
        // would parse the OLD report while believing it was the new one, and every
        // downstream fact would be wrong with no error anywhere.
        const active = await verifyActiveReport(chPage, target);

        if (!active.ok) {
            return errorResponse("REPORT_NOT_VERIFIED_ACTIVE",
                `The report was selected but could not be VERIFIED as active: ${active.error}. ` +
                    `Extraction is gated on verified activation — we do not parse a report we cannot ` +
                    `confirm is the one on screen.`, { milestone: "M6_CAPTURE" });
        }

        console.log(`VERIFIED ACTIVE: ${target.text}`);

        // ---- 7. LET THE SELECTED REPORT'S PAYLOAD ARRIVE --------------------
        //
        // Selecting a report triggers a fresh fetch. The listener is already
        // attached, so we just give the network time to deliver it.
        //
        // READ ONLY throughout. The report page carries controls that order
        // reports and reactivate monitoring. Nothing here clicks any of them.
        await chPage.waitForTimeout(5000);

        const reportPayloads = captured.filter((c) => c.looksLikeCreditReport);

        if (reportPayloads.length === 0) {
            return errorResponse(
                "NO_REPORT_PAYLOAD_CAPTURED",
                `Captured ${captured.length} JSON response(s), but none looks like a credit report ` +
                    `(none carried tradeline/bureau/liability structure). The Normalization Engine is ` +
                    `NOT written against a guess — this run returns what it saw so the real payload can ` +
                    `be identified. Candidates: ` +
                    captured.map((c) => `${c.url.slice(0, 80)} [${c.topLevelKeys?.join(",") ?? "?"}]`).join(" | ")
            );
        }

        // The largest report-shaped payload is the report. Stated, not assumed —
        // and every candidate is returned so this can be checked rather than trusted.
        const report = reportPayloads.sort((a, b) => b.size - a.size)[0];

        console.log(`Captured report payload: ${report.url.slice(0, 100)} (${report.size} bytes)`);

        // ---- NORMALIZE: RAW MISMO -> BT CREDIT REPORT MODEL ------------------
        //
        // PURE. No browser. The normalizer emits FACTS and decides nothing —
        // eligibility belongs to the Strategy Engine.
        //
        // previousReport is null on this run: no BT Credit Report Model has ever
        // been persisted, so there is no key registry to match against and every
        // key is a first sighting. That is correct, not a gap — but it means the
        // CROSS-RUN identity guarantee (§7.5) is UNTESTED until a second run.
        const normalized = normalizeReport(report.payload, {
            crcClientId: client.crcClientId,
            previousReport: null,
        });

        // ---- FAIL CLOSED ON PARTIAL EXTRACTION ------------------------------
        //
        // A partly-parsed report is MORE DANGEROUS than no report. The Intelligence
        // Engine detects deletions BY ABSENCE — so a tradeline we merely failed to
        // parse is indistinguishable from one the bureau DELETED. That produces a
        // fabricated "deletion" which flows into strategy, and then into a letter.
        //
        // We refuse to hand Intelligence a report we do not fully trust.
        if (!normalized.extraction_ok) {
            return errorResponse("EXTRACTION_FAILED",
                `The report was captured but could not be normalized with confidence. ` +
                    `Nothing downstream runs on a report we do not fully trust.`,
                {
                    milestone: "M6_CAPTURE",
                    extraction_errors: normalized.errors,
                    key_resolution: normalized.key_resolution,
                    completeness: normalized.completeness,
                    counts: normalized.counts,
                    requiresHumanReview: true,

                    // ---- THE RAW PAYLOAD SURVIVES THE FAILURE -----------------
                    //
                    // A failure that discards its own evidence cannot be diagnosed.
                    // The raw report is the MOST useful artifact when extraction
                    // fails — it is what a human (or /debug/collision-map) needs to
                    // see WHY it failed — and it was the one thing being dropped,
                    // precisely on the path where it matters.
                    //
                    // Extraction §8 already requires "raw capture is never discarded
                    // on failure." This honours that at the M6 boundary.
                    payload: report.payload,
                });
        }

        console.log(
            `Normalized: ${normalized.counts.raw_liability_rows} raw rows -> ` +
            `${normalized.counts.unique_accounts} accounts -> ` +
            `${normalized.counts.account_bureau_tradelines} bureau tradelines ` +
            `(${normalized.counts.observations_shared} SHARED observations).`
        );

        return successResponse({
            milestone: "M6_CAPTURE",
            result: "CAPTURED",

            crcClientId: client.crcClientId,
            identity,
            identityVerified: true,

            creditHeroLandingUrl: creditHero.currentUrl,
            reportPageUrl: reportPage.reportUrl,

            reportSelected: {
                text: target.text,
                date: freshness.newestReportDate,
                verifiedActive: true,
            },

            selectorOptions: parsed.reports.map((r) => ({ text: r.text, date: r.reportDate })),
            selectorRejected: parsed.rejected,
            freshness: { action: freshness.action, reason: freshness.reason },

            // ---- STAGE 1 (READ-ONLY): TEMPORARY ROLLOUT ELIGIBILITY HINT ------
            //
            // The client HAS a usable report, so the order page was never visited.
            // The authoritative live report date is the selector's newest, and the
            // eligibility hint reuses the SAME helper the order-page reader uses —
            // one rule, not two. Fields the order page would have supplied are
            // reported as null because they were NOT observed on this path; we do
            // not infer them.
            classification:
                computeEligibilityHint(freshness.newestReportDate ?? null, null) === "ELIGIBLE_EXISTING_REPORT"
                    ? "ELIGIBLE_EXISTING_REPORT"
                    : "PROCESSED_EXISTING_REPORT",
            lastReportDate: freshness.newestReportDate ?? null,
            eligibilityHint: computeEligibilityHint(freshness.newestReportDate ?? null, null),
            temporaryOverrideApplied:
                computeEligibilityHint(freshness.newestReportDate ?? null, null) === "ELIGIBLE_EXISTING_REPORT",
            freeReportEnabled: null,
            nextFreeReportAvailableAt: null,
            paidReportPresent: null,
            paidReportPrice: null,

            // THE EVIDENCE. This is what the normalizer gets written against.
            capturedPayload: {
                url: report.url,
                size: report.size,
                topLevelKeys: report.topLevelKeys,
                analysis: report.analysis,
                skeleton: report.skeleton,
            },

            // ---- THE BT CREDIT REPORT MODEL --------------------------------
            //
            // FACTS ONLY. No eligibility, no "negative" classification, no dispute
            // decision. The Strategy Engine determines those from these facts plus
            // Business Trappers policy — which is why a closed account and a
            // positively-reporting DoE student loan both survive to this point.
            normalized: {
                extraction_ok: normalized.extraction_ok,
                model_version: normalized.report.model_version,
                report_metadata: normalized.report.report_metadata,

                // #1, #2, #3. Eligible-negative and excluded counts are ABSENT by
                // design — they are the Strategy Engine's to produce, and were never
                // the raw row count.
                counts: normalized.counts,

                key_resolution: normalized.key_resolution,
                completeness: normalized.completeness,
            },

            // The model itself, for the pipeline. Kept separate from the summary
            // above so the response stays readable.
            btCreditReportModel: normalized.report,

            // Every JSON response seen, so the choice above can be CHECKED rather
            // than trusted. If the wrong one was picked, this shows it.
            allJsonResponses: captured.map((c) => ({
                url: c.url,
                size: c.size,
                topLevelKeys: c.topLevelKeys,
                looksLikeCreditReport: c.looksLikeCreditReport,
            })),

            // The full payload — so the Normalization Engine can be built and
            // unit-tested against a REAL fixture, with no browser and no credentials.
            payload: report.payload,

            normalized: false,   // INVARIANT for this milestone
            reconciled: false,   // INVARIANT for this milestone
            lettersGenerated: 0, // INVARIANT for this milestone

            message:
                "Report captured and verified active. NOT normalized, NOT reconciled, NO letters. " +
                "The Normalization Engine is written against this payload — never against a guessed " +
                "schema.",

            replayUrl,
        });

    } catch (error) {
        console.error("Milestone 6 failed:", error);
        return errorResponse("MILESTONE_6_ERROR", error.message, { milestone: "M6_CAPTURE" });

    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Passive JSON capture. Attach BEFORE navigating.
 *
 * Retains the FULL parsed payload — unlike the spike's capture, which keeps only
 * a skeleton. A skeleton tells us the shape; it does not give us a fixture the
 * Normalization Engine can be unit-tested against without a browser.
 *
 * PURELY PASSIVE. It observes responses. It never issues a request, never clicks,
 * and cannot affect the page.
 */
function capturePayloads(context) {
    const captured = [];

    // context.on("response") fires for EVERY page in the session — including tabs
    // that do not exist yet when this listener is attached. That is the point.
    context.on("response", async (response) => {
        try {
            const url = response.url();
            const contentType = (response.headers()["content-type"] || "").toLowerCase();

            if (!contentType.includes("json") && !/json/i.test(url)) return;

            const body = await response.text().catch(() => null);
            if (!body) return;

            let payload;
            try {
                payload = JSON.parse(body);
            } catch {
                return; // not JSON after all
            }

            const topLevelKeys = payload && typeof payload === "object" ? Object.keys(payload) : [];

            captured.push({
                url,
                size: body.length,
                topLevelKeys,
                looksLikeCreditReport: looksLikeCreditReport(body),
                analysis: analyzeReportShape(payload),
                skeleton: buildSkeleton(payload),
                payload, // THE FIXTURE
            });

            console.log(`JSON captured: ${url.slice(0, 100)} (${body.length} bytes)`);
        } catch {
            // A response can be gone before we read it. Capture must never break
            // the run.
        }
    });

    return captured;
}

/**
 * Does this payload look like a credit report?
 *
 * A HEURISTIC, and named as one. It is used only to CHOOSE which captured payload
 * to surface first — every candidate is returned regardless, so a wrong choice is
 * visible rather than silent. Nothing is parsed on the strength of this.
 */
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

    const hits = markers.filter((m) => m.test(body)).length;

    // Two or more independent markers. One could be incidental.
    return hits >= 2;
}

/**
 * ===========================================================================
 * THE REPORT ACQUISITION PATH.
 *
 * Reached only when the selector's newest report predates the rollout cutoff,
 * i.e. a newer report is REQUIRED. Everything here is about one question: may
 * we spend this client's free-report entitlement, and has a previous run
 * already spent it?
 *
 * WHAT IT NEVER DOES:
 *   - select or submit a PAID option, under any circumstance;
 *   - submit anything at all unless ENABLE_FREE_REPORT_SUBMISSION === "true";
 *   - resubmit an unresolved intent, on any branch, for any reason;
 *   - fall back to analyzing the stale report it was sent here to replace.
 *
 * IT RETURNS A ROUTING SIGNAL, NOT A REPORT.
 *   { proceedWithCapture: false, response }  -> M6 returns `response` verbatim
 *   { proceedWithCapture: true }             -> a strictly newer report is
 *                                               confirmed; M6 re-reads the
 *                                               selector and captures it
 * ===========================================================================
 */

/** How long to wait for a newly ordered report to appear before deferring. */
const ACQUISITION_POLL_MS = 180000;
const ACQUISITION_POLL_INTERVAL_MS = 15000;

async function runAcquisitionPath(ctx) {
    const {
        chPage, crcClientId, processingRunId, browserbaseSessionId,
        baselineReportDate, eligibilityHint, reportPageUrl, memberDashboardUrl,
        openIntent, recovery, replayUrl,
    } = ctx;

    const base = {
        milestone: "M6_CAPTURE",
        stage: "report_acquisition",
        crcClientId,
        processingRunId,
        lastReportDate: baselineReportDate,
        eligibilityHint,
        replayUrl,
    };

    // ---- 1. AN UNRESOLVED INTENT STOPS EVERYTHING ------------------------
    //
    // Recovery already had its chance to confirm the effect against the
    // selector. If it could not, a previous run may or may not have ordered,
    // and we do not find out by trying again.
    if (recovery.action === RECOVERY.WAIT_WITHIN_GRACE) {
        return {
            proceedWithCapture: false,
            response: successResponse({
                ...base,
                // Routes to "Waiting For Bureau" through the existing branch:
                // an order may be in flight and we are waiting on its report.
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
            response: errorResponse(
                "ACQUISITION_INTENT_UNRESOLVED",
                recovery.reason,
                {
                    ...base,
                    acquisitionIntentOpen: true,
                    acquisitionRecovery: recovery.action,
                    requiresHumanReview: true,
                }
            ),
        };
    }

    // ---- 2. READ THE ORDER PAGE (read-only) ------------------------------
    const navigated = await navigateToOrderPage(chPage, { memberDashboardUrl });

    if (!navigated.ok) {
        return {
            proceedWithCapture: false,
            response: errorResponse(
                navigated.error_code ?? "ORDER_PAGE_UNREACHABLE",
                navigated.error ?? "Could not reach the Credit Hero order page.",
                {
                    ...base,
                    // Sanitized DOM evidence: filenames and control labels only,
                    // never a tGUID-bearing URL. Present so a repeat failure is
                    // diagnosable from the job result itself.
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
                "The order page was reached but its purchase options could not be read. " +
                    "A page we cannot fully account for is a page we do not act on.",
                { ...base, requiresHumanReview: true }
            ),
        };
    }

    // ---- 3. THE DECISION ENGINE DECIDES. THIS FUNCTION DOES NOT. ---------
    const decision = decideAcquisition(orderState, {
        newer_report_required: true,
        open_acquisition_intent: openIntent ?? null,
    });

    console.log(`Acquisition decision: ${decision.decision} — ${decision.reason}`);

    // A sanitized record of what was seen and chosen. Option ids, costs and
    // enabled-state only: no tokens, no client data.
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
            available_from: o.available_from,
        })),
        unaccountedOptionIds: orderState.unaccounted_option_ids,
    };

    // ---- 4. ANTHONY: the free report is not due yet ----------------------
    if (decision.decision === DECISIONS.FREE_REPORT_NOT_YET_AVAILABLE) {
        return {
            proceedWithCapture: false,
            response: successResponse({
                ...base,
                // The existing WAITING_FOR_FREE_REPORT shape, so
                // processProductionClient.js routes this to "Waiting For Bureau"
                // through the branch it already has. No new routing is added.
                result: "WAITING_FOR_FREE_REPORT",
                classification: "WAITING_FOR_FREE_REPORT",
                freeReportEnabled: false,
                nextFreeReportAvailableAt: decision.available_from ?? null,
                paidReportPresent: decision.paid_available === true,
                paidReportPrice:
                    decisionRecord.optionsObserved.find((o) => o.cost > 0)?.cost ?? null,
                temporaryOverrideApplied: false,
                acquisitionDecision: decisionRecord,
                diagnosticOnly: true,
            }),
        };
    }

    if (decision.decision === DECISIONS.MANUAL_REVIEW) {
        return {
            proceedWithCapture: false,
            response: errorResponse(
                "ACQUISITION_MANUAL_REVIEW",
                decision.reason,
                { ...base, acquisitionDecision: decisionRecord, requiresHumanReview: true }
            ),
        };
    }

    if (decision.decision !== DECISIONS.SUBMIT_FREE_REPORT) {
        // NO_ACTION_REQUIRED cannot occur here (newer_report_required is true),
        // but an unrecognized decision is never treated as permission.
        return {
            proceedWithCapture: false,
            response: errorResponse(
                "ACQUISITION_DECISION_UNEXPECTED",
                `The decision engine returned "${decision.decision}", which is not a basis for ` +
                    `acquiring or for proceeding. Nothing was submitted.`,
                { ...base, acquisitionDecision: decisionRecord, requiresHumanReview: true }
            ),
        };
    }

    // ---- 5. MARCOS: a free report IS available ---------------------------
    //
    // OBSERVE-ONLY IS THE DEFAULT. We report exactly what we would have done,
    // and create NO intent — an observation is not an intention, and a row in
    // report_acquisition_intents means "we may have ordered", which would be
    // false and would block the next real run through the partial unique index.
    if (!isSubmissionEnabled()) {
        console.log(
            "OBSERVE-ONLY: a free report is available and verified at cost 0. " +
            "ENABLE_FREE_REPORT_SUBMISSION is not \"true\", so nothing was selected or submitted."
        );

        return {
            proceedWithCapture: false,
            response: successResponse({
                ...base,
                result: "FREE_REPORT_OBSERVATION_ONLY",
                classification: "FREE_REPORT_AVAILABLE",
                submissionEnabled: false,
                wouldSubmit: true,
                acquisitionDecision: decisionRecord,
                freeReportEnabled: true,
                intentCreated: false,
                reportOrdered: false,
                diagnosticOnly: true,
                message:
                    "Observation only. The free option was positively identified at cost 0 and the " +
                    "paid option positively excluded. No radio was selected, no Submit was clicked, " +
                    "and no acquisition intent was created.",
            }),
        };
    }

    // ---- 6. LIVE SUBMISSION ----------------------------------------------
    //
    // THE INTENT IS WRITTEN FIRST AND MUST COMMIT BEFORE ANYTHING IS CLICKED.
    // A 23505 unique violation here is the guard doing its job.
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
                {
                    ...base,
                    acquisitionDecision: decisionRecord,
                    intentBlockedReason: intent.reason,
                    requiresHumanReview: true,
                }
            ),
        };
    }

    const submission = await selectAndSubmitFreeReport(chPage, {
        optionId: decision.selected_option.id,
        observedCost: decision.selected_option.cost,
        onSubmissionStarted: () => markSubmissionStarted(intent.intent.id),
    });

    if (!submission.submitClicked) {
        // Nothing was submitted. Whether the intent is safely cancellable
        // depends on how far we got: if the submission was never STARTED it can
        // be cancelled cleanly; once started, the outcome is unknown and the
        // intent must stay unresolved for recovery to reconcile.
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
                {
                    ...base,
                    acquisitionDecision: decisionRecord,
                    submission,
                    requiresHumanReview: true,
                }
            ),
        };
    }

    await markSubmitted(intent.intent.id).catch(() => {});

    // ---- 7. WAIT FOR THE EFFECT, THEN PROVE IT ---------------------------
    //
    // hasNewerReport() requires STRICTLY newer than the baseline. Not
    // "different", not "the count changed" — only a date greater than the
    // baseline proves the report we ordered actually landed.
    const deadline = Date.now() + ACQUISITION_POLL_MS;

    while (Date.now() < deadline) {
        await chPage.waitForTimeout(ACQUISITION_POLL_INTERVAL_MS);

        await chPage.goto(reportPageUrl, { waitUntil: "load" }).catch(() => {});

        const fresh = await readReportSelector(chPage);

        if (!fresh.ok) continue;

        const newer = hasNewerReport(fresh.selector, baselineReportDate);

        if (newer.appeared) {
            console.log(`New report confirmed: ${newer.reportDate} (baseline ${baselineReportDate}).`);

            await resolveIntent(intent.intent.id, INTENT_STATUS.REPORT_AVAILABLE, {
                reportDateAfter: newer.reportDate,
            }).catch(() => {});

            return { proceedWithCapture: true };
        }
    }

    // TIMED OUT. The intent stays UNRESOLVED on purpose: the order was
    // submitted, so the entitlement may well be spent, and the next daily run's
    // recovery will confirm the report once it appears. We do NOT fall back to
    // the stale report — that is the one thing reportFreshness.js exists to
    // prevent.
    return {
        proceedWithCapture: false,
        response: successResponse({
            ...base,
            result: "WAITING_FOR_FREE_REPORT",
            classification: "WAITING_FOR_FREE_REPORT",
            reportOrdered: true,
            acquisitionIntentOpen: true,
            acquisitionDecision: decisionRecord,
            analyzedOlderReport: false,
            freeReportEnabled: false,
            nextFreeReportAvailableAt: null,
            paidReportPresent: null,
            paidReportPrice: null,
            temporaryOverrideApplied: false,
            message:
                "The free report was submitted but no strictly newer report had appeared within " +
                "the wait window. The acquisition intent remains unresolved and will be " +
                "reconciled on a later run. The older report was NOT analyzed.",
        }),
    };
}
