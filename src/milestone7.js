/**
 * milestone7.js
 *
 * THE FULL END-TO-END PIPELINE.
 *
 * Milestone 6 captures and normalizes a report and STOPS — by design. This
 * milestone runs the rest: it takes M6's verified BT Credit Report Model and
 * drives it through the intelligence pipeline to three finished bureau letters.
 *
 * IT ADDS NO NEW LOGIC. Every stage below is an existing, individually-tested
 * function. This orchestrator only chains them in the proven order — the same
 * sequence the generateLetter test harness uses — and assembles one response.
 *
 *   M6 (capture + normalize)                     -> BT Credit Report Model
 *     analyzeCreditReport   (reasoning)          -> findings
 *     decideDisputes        (per-tradeline)      -> Dispute / Preserve / Review
 *     selectStrategy        (per item)           -> strategy + remedy
 *     buildDisputeChain     (assembly)           -> dispute chain
 *     generateLetters       (presentation)       -> <= 3 bureau letters
 *     reconcile             (invariant check)    -> coverage proof
 *
 * FAIL CLOSED. If M6 could not produce a trustworthy report (extraction_ok
 * false, or any capture/normalize failure), this milestone does not run the
 * pipeline on it. A partly-parsed report is more dangerous than no report.
 */

import { successResponse, errorResponse } from "./response.js";
import { runMilestone6 } from "./milestone6.js";
import { verifyIdentity } from "./clientIdentity.js";

import { runPipeline } from "./pipeline.js";

const REQUIRED_IDENTITY_LABELS = Object.freeze([
    "First Name",
    "Last Name",
    "Mailing Address",
    "City",
    "State",
    "Zip Code",
]);

/**
 * CRC occasionally renders the Edit Profile modal shell without populating any
 * of its required identity controls. Production evidence on 2026-08-23 showed
 * this exact all-six-empty signature on clients whose profiles were later read
 * successfully without any data change.
 *
 * This predicate is deliberately narrow. One or two missing fields can be real
 * client-data defects and MUST still fail closed. We retry only when every
 * required identity field is simultaneously reported missing and empty.
 */
function isTransientEmptyProfileLoad(result) {
    if (!result || result.success !== false) return false;
    if (result.error_code !== "REQUIRED_IDENTITY_FIELDS_MISSING") return false;

    const missingLabels = new Set(
        (Array.isArray(result.missing) ? result.missing : [])
            .map((item) => String(item?.label ?? item ?? "").trim())
            .filter(Boolean)
    );

    if (!REQUIRED_IDENTITY_LABELS.every((label) => missingLabels.has(label))) {
        return false;
    }

    const partial = result.partial ?? {};

    return REQUIRED_IDENTITY_LABELS.every((label) => {
        const value = partial[label];
        return value == null || String(value).trim() === "";
    });
}

export async function runMilestone7(data = {}) {
    try {
        // ---- STAGE 0: CAPTURE + NORMALIZE (Milestone 6, reused wholesale) ----
        //
        // We do NOT re-implement capture. M6 owns login, client open, identity,
        // Credit Hero navigation, report selection, capture, and normalization,
        // and it already fails closed on every one of those. We consume its result.
        // PATCH 2 — stage 5: M7. Confirms the flags survived the PP -> M7 hop.
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
                    stage: "milestone7",
                    timestamp: new Date().toISOString(),
                });
            }
        }

        let m6 = await runMilestone6(data);

        // A fully empty CRC profile modal is a known transient CRC load failure,
        // not evidence that six independent identity fields were deleted at once.
        // Retry ONCE by invoking M6 again. The first M6 call owns and closes its
        // browser session, so the retry starts from a fresh Browserbase session.
        // No retry is allowed for partial identity failures or any other error.
        if (isTransientEmptyProfileLoad(m6)) {
            console.warn(
                `CRC profile returned all six required identity fields empty for ` +
                    `${data.clientName ?? "(unknown client)"}. Retrying M6 once in a fresh session.`
            );

            m6 = await runMilestone6(data);

            if (m6?.success === true) {
                console.log(
                    `Fresh-session CRC profile retry succeeded for ` +
                        `${data.clientName ?? "(unknown client)"}.`
                );
            } else {
                console.warn(
                    `Fresh-session CRC profile retry did not recover ` +
                        `${data.clientName ?? "(unknown client)"}. Failing closed.`
                );
            }
        }

        // M6 failed closed somewhere (extraction, capture, navigation, identity).
        // Its own error response is authoritative — do not run the pipeline on a
        // report M6 did not vouch for.
        if (!m6 || m6.success === false) {
            return errorResponse(
                "PIPELINE_HALTED_AT_CAPTURE",
                "Report capture/normalization did not complete successfully, so the " +
                    "intelligence pipeline was not run. See capture_result for the exact reason.",
                {
                    milestone: "M7_FULL_PIPELINE",
                    stage: "capture_and_normalize",
                    capture_result: m6,
                    requiresHumanReview: true,
                }
            );
        }

        // The BT Credit Report Model M6 produced, and the client identity it read.
        const report = m6.btCreditReportModel;

        // M6 returns the CRC-read identity as `identity` (top level). This is the
        // raw identity object the downstream engines expect — they call
        // verifyIdentity() on it themselves.
        const identity = m6.identity ?? null;

        if (!report) {
            return errorResponse(
                "NO_REPORT_MODEL",
                "Milestone 6 reported success but returned no BT Credit Report Model. " +
                    "The pipeline cannot run without one.",
                { milestone: "M7_FULL_PIPELINE", stage: "handoff", capture_result: m6, requiresHumanReview: true }
            );
        }

        // Identity is authoritative for letter headers and MUST be verified before a
        // letter is written (Identity Source Standard). No identity -> no letters.
        if (identity) {
            const verified = verifyIdentity(identity);
            if (!verified.ok) {
                return errorResponse(
                    "IDENTITY_NOT_VERIFIED",
                    "Client identity from CRC did not verify. Letters are not generated without a " +
                        "verified identity source.",
                    {
                        milestone: "M7_FULL_PIPELINE",
                        stage: "identity",
                        identity_error: verified,
                        requiresHumanReview: true,
                    }
                );
            }
        }

        // Stages 1-6 run in a pure, browser-free function so the pipeline is
        // unit-testable without a live session (same split as capture/normalize).
        // AUTHORITATIVE CURRENT ROUND FLOOR. Thread the stored client_state's
        // current_round into runPipeline so selectStrategy has the durable source.
        // This prevents round mismatch when selectStrategy computes nextRound.
        const currentRoundFloor = Number.isInteger(data.currentRound) && data.currentRound > 0
            ? data.currentRound
            : null;
        const pipeline = await runPipeline(report, identity, { currentRoundFloor });

        return successResponse({
            milestone: "M7_FULL_PIPELINE",

            // Capture/normalize summary carried through from M6.
            //
            // The eligibility metadata is set on M6's CAPTURED success response,
            // but this success path builds a FRESH capture object rather than
            // embedding m6 — so without carrying these fields through explicitly
            // they are dropped here, before the queue projection ever sees them.
            // Pass-through only: read from m6, no recomputation, no new behavior.
            capture: {
                report_metadata: report.report_metadata,
                counts: m6.normalized?.counts ?? null,
                key_resolution: m6.normalized?.key_resolution ?? null,
                completeness: m6.normalized?.completeness ?? null,

                // Stage 1 read-only rollout eligibility metadata (diagnostic).
                classification: m6.classification ?? null,
                lastReportDate: m6.lastReportDate ?? null,
                eligibilityHint: m6.eligibilityHint ?? null,
                temporaryOverrideApplied: m6.temporaryOverrideApplied ?? null,
                freeReportEnabled: m6.freeReportEnabled ?? null,
                nextFreeReportAvailableAt: m6.nextFreeReportAvailableAt ?? null,
                paidReportPresent: m6.paidReportPresent ?? null,
                paidReportPrice: m6.paidReportPrice ?? null,
            },

            ...pipeline,

            // FIRST PRODUCTION VALIDATION: nothing is sent. A human approves wording.
            review_required: true,
            review_reason: "FIRST_PRODUCTION_VALIDATION",
            status: "NOT SENT",
        });
    } catch (error) {
        return errorResponse("MILESTONE_7_ERROR", error.message, {
            milestone: "M7_FULL_PIPELINE",
            requiresHumanReview: true,
        });
    }
}
