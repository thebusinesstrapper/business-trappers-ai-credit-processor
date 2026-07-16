/**
 * pipeline.js
 *
 * THE INTELLIGENCE PIPELINE AFTER CAPTURE. Browser-free and pure: report +
 * identity in, dispute package out. Every stage is an existing, tested function;
 * this module only chains them. Kept separate from milestone7.js so it can be
 * validated WITHOUT importing the browser stack — the same capture/reasoning
 * split used everywhere else in this system.
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes } from "./decideDisputes.js";
import { selectStrategy } from "./selectStrategy.js";
import { buildDisputeChain } from "./disputeChain.js";
import { generateLetters } from "./generateLetter.js";
import { reconcile } from "./reconcile.js";
import { exportLetterResult } from "./letterRenderer.js";

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

    // STAGE 7: EXPORT (presentation artifacts for Credit Cloud retrieval).
    // Renders a client-ready DOCX + PDF for each SENDABLE letter, applying the
    // fixed formatting standard. exportLetterResult is fail-closed: if the result
    // is not certified sendable (letters_ok !== true), it exports nothing; and it
    // never touches withheld/content-gated letters. Nothing is sent or uploaded
    // here — this milestone only produces the files and their metadata.
    const clientName =
        identity?.name ??
        [identity?.firstName, identity?.lastName].filter(Boolean).join(" ") ??
        "client";
    const round = Math.max(1, ...(letterResult.letters ?? []).map((l) => l.round ?? 1));
    const exportResult = await exportLetterResult(letterResult, {
        clientName,
        round,
        date: report?.report_metadata?.report_date ?? new Date().toISOString().slice(0, 10),
    });

    // The JSON response carries METADATA ONLY (filenames + byte counts). The binary
    // buffers live on a non-enumerated field so the ordinary M7 JSON stays free of
    // base64 blobs; a later upload step can read pipelineResult.export_artifacts.
    const exportMetadata = exportResult.exported.map((e) => ({
        bureau: e.bureau,
        bureauName: e.bureauName,
        docx: e.docx,   // { filename, bytes }
        pdf: e.pdf,     // { filename, bytes }
    }));

    const result = {
        analysis_summary: analysis.clientSummary ?? null,
        item_decisions: decisions.itemDecisions ?? [],
        letters: letterResult.letters ?? [],
        withheld: letterResult.withheld ?? [],
        letters_ok: letterResult.lettersOk ?? false,
        reconciliation,
        // Metadata only — safe to serialize into the M7 response.
        export: {
            rendererVersion: "BT-LETTER-RENDERER-1.0",
            count: exportMetadata.length,
            files: exportMetadata,
        },
    };

    // Binary buffers, kept OFF the JSON response. Non-enumerable so JSON.stringify
    // and object spreads skip it; a dedicated save/upload step accesses it directly.
    Object.defineProperty(result, "export_artifacts", {
        value: exportResult.exported,
        enumerable: false,
    });

    return result;
}
