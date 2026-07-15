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

export async function runMilestone7(data = {}) {
    try {
        // ---- STAGE 0: CAPTURE + NORMALIZE (Milestone 6, reused wholesale) ----
        //
        // We do NOT re-implement capture. M6 owns login, client open, identity,
        // Credit Hero navigation, report selection, capture, and normalization,
        // and it already fails closed on every one of those. We consume its result.
        const m6 = await runMilestone6(data);

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
        const pipeline = await runPipeline(report, identity);

        return successResponse({
            milestone: "M7_FULL_PIPELINE",

            // Capture/normalize summary carried through from M6.
            capture: {
                report_metadata: report.report_metadata,
                counts: m6.normalized?.counts ?? null,
                key_resolution: m6.normalized?.key_resolution ?? null,
                completeness: m6.normalized?.completeness ?? null,
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
