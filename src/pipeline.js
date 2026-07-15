/**
 * pipeline.js
 *
 * THE INTELLIGENCE PIPELINE AFTER CAPTURE. Browser-free and pure: report +
 * identity in, dispute package out. Every stage is an existing, tested function;
 * this module only chains them. Kept separate from milestone7.js so it can be
 * validated WITHOUT importing the browser stack — the same capture/reasoning
 * split used everywhere else in this system.
 */

import { analyzeCreditReport } from "./intelligence/analyzeCreditReport.js";
import { decideDisputes } from "./intelligence/decideDisputes.js";
import { selectStrategy } from "./intelligence/selectStrategy.js";
import { buildDisputeChain } from "./intelligence/disputeChain.js";
import { generateLetters } from "./intelligence/generateLetter.js";
import { reconcile } from "./intelligence/reconcile.js";

/**
 * The pipeline AFTER capture. Pure: report + identity in, package out. No browser,
 * no network — every stage is an existing tested function. Exported so the
 * orchestration can be validated without a live session.
 */
export async function runPipeline(report, identity = null) {
    // STAGE 1: ANALYSIS (reasoning only)
    const analysis = await analyzeCreditReport(report, {
        clientIdentity: identity ?? undefined,
    });

    // STAGE 2: DECISION (Dispute / Preserve / Manual Review per item)
    const decisions = await decideDisputes(analysis, { report });

    // STAGE 3: STRATEGY (+ remedy) per item
    const strategies = await selectStrategy(decisions, {});

    // STAGE 4: CHAIN (assemble the dispute package)
    const chain = await buildDisputeChain(strategies);

    // STAGE 5: LETTERS (presentation; quotes the Bureau Fidelity Layer)
    const letterResult = await generateLetters(chain, analysis, {
        clientIdentity: identity ?? undefined,
        report,
    });

    // STAGE 6: RECONCILE — the binding coverage invariant. Sum of letter sections
    // === disputed items. A failure here means the package is internally
    // inconsistent; reconcile surfaces it rather than letting it ship.
    // reconcile expects the FULL generateLetters result ({ letters, withheld }),
    // not the bare letters array — it reads letters.letters and letters.withheld.
    // Passing the array flattens both to undefined and every item reads as
    // "never lettered." This is the orchestration seam reconcile's own test covered
    // but the first wiring got wrong.
    const reconciliation = reconcile({
        report,
        analysis,
        decisions,
        strategies,
        letters: letterResult,
    });

    return {
        analysis_summary: analysis.clientSummary ?? null,
        item_decisions: decisions.itemDecisions ?? [],
        letters: letterResult.letters ?? [],
        withheld: letterResult.withheld ?? [],
        letters_ok: letterResult.lettersOk ?? false,
        reconciliation,
    };
}
