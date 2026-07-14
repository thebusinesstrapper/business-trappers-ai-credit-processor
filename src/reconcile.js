/**
 * reconcile.js
 *
 * PIPELINE RECONCILIATION.
 *
 * ---------------------------------------------------------------------------
 * NOTHING DISAPPEARS SILENTLY.
 *
 * Every bureau tradeline that enters at Extraction must be accounted for at
 * Letter Generation. Not "most". Every one.
 *
 *   Extraction -> Analysis -> Decision -> Strategy -> Letter
 *
 * At each stage an item either CONTINUES or EXITS, and every exit carries a
 * reason. If the counts do not balance, that is a BUG, and this module says so
 * rather than presenting a tidy summary of whatever survived.
 *
 * The failure this exists to prevent is not a crash — it is a QUIET one. A
 * tradeline dropped by a missing lookup or an unmapped code produces a dispute
 * package that looks complete, reads well, and silently omits the client's worst
 * account. Nobody notices, because there is nothing to notice.
 * ---------------------------------------------------------------------------
 */

export const RECONCILE_SCHEMA_VERSION = "BT-RECONCILE-1.0";

/**
 * THE CLOSED SET OF LEGAL EXITS.
 *
 * Business Trappers ruling: every ELIGIBLE NEGATIVE bureau tradeline must exit
 * as exactly ONE of these four. There is no fifth door.
 *
 * "NO_FINDINGS" is deliberately NOT in this set. It is a legal exit ONLY for a
 * tradeline that is not an eligible negative — a positive account with nothing
 * wrong with it. For an eligible negative it is a POLICY VIOLATION, because the
 * Analysis Engine decides HOW to dispute, never WHETHER to.
 */
export const EXIT = Object.freeze({
    SPECIFIC_STRATEGY: "SPECIFIC_STRATEGY",
    BASELINE_REINVESTIGATION: "BASELINE_REINVESTIGATION",
    EXCLUDED: "EXCLUDED",
    WITHHELD: "WITHHELD",

    // Legal ONLY for non-eligible-negative items.
    NO_FINDINGS: "NO_FINDINGS",
    NOT_NEGATIVE: "NOT_NEGATIVE",

    // Never legal.
    POLICY_VIOLATION: "POLICY_VIOLATION",
    BUG: "BUG",
});

export const STAGE = Object.freeze({
    EXTRACTED: "EXTRACTED",
    ANALYZED: "ANALYZED",
    DECIDED: "DECIDED",
    STRATEGISED: "STRATEGISED",
    LETTERED: "LETTERED",
});

const DEROGATORY = /charge.?off|collection|repossession|foreclosure|settled|default|written.?off|late|delinquen/i;

function isNegative(tradeline) {
    const obs = tradeline.observation ?? {};
    const pastDue = Number(obs.past_due ?? 0);

    return DEROGATORY.test(String(obs.status ?? "")) || pastDue > 0;
}

/**
 * Account for every bureau tradeline from extraction through letter generation.
 *
 * @param {object} report      BT Credit Report Model (extraction output)
 * @param {object} analysis    analyzeCreditReport() output
 * @param {object} decisions   decideDisputes() output
 * @param {object} strategies  selectStrategy() output
 * @param {object} letters     generateLetters() output
 */
export function reconcile({ report, analysis, decisions, strategies, letters }) {

    // ---- Stage 1: EXTRACTION — the ground truth ---------------------------
    const extracted = [];

    const groups = [
        ...(report.accounts ?? []).map((a) => ({ group: a, kind: "TRADELINE" })),
        ...(report.collections ?? []).map((a) => ({ group: a, kind: "COLLECTION" })),
        ...(report.public_records ?? []).map((a) => ({ group: a, kind: "PUBLIC_RECORD" })),
    ];

    for (const { group, kind } of groups) {
        for (const tradeline of group.bureau_tradelines ?? []) {
            extracted.push({
                stableItemKey: tradeline.stable_item_key,
                stableAccountKey: group.stable_account_key,
                bureau: tradeline.bureau,
                kind,
                furnisher: tradeline.furnisher ?? group.original_creditor ?? null,
                maskedAccount: tradeline.masked_account ?? null,
                status: tradeline.observation?.status ?? null,
                negative: isNegative(tradeline),
            });
        }
    }

    for (const inquiry of report.inquiries ?? []) {
        extracted.push({
            stableItemKey: inquiry.stable_item_key,
            stableAccountKey: null,
            bureau: inquiry.bureau,
            kind: "INQUIRY",
            furnisher: inquiry.furnisher ?? null,
            maskedAccount: null,
            status: null,
            negative: false, // an inquiry is not a negative tradeline
        });
    }

    // ---- Index each downstream stage --------------------------------------
    const analysed = new Map();

    for (const item of [
        ...(analysis?.tradelines ?? []),
        ...(analysis?.collections ?? []),
        ...(analysis?.inquiries ?? []),
        ...(analysis?.publicRecords ?? []),
    ]) {
        analysed.set(item.stableItemKey, item);
    }

    const decided = new Map();
    for (const d of decisions?.itemDecisions ?? []) decided.set(d.stableItemKey, d);

    const strategised = new Map();
    for (const s of strategies?.itemStrategies ?? []) strategised.set(s.stableItemKey, s);

    const lettered = new Set();
    for (const letter of letters?.letters ?? []) {
        for (const key of letter.stableItemKeys ?? []) lettered.add(key);
    }

    const withheld = new Map();
    for (const w of letters?.withheld ?? []) withheld.set(w.stableItemKey, w);

    // ---- Walk each item through the pipeline ------------------------------
    const journeys = extracted.map((item) => {
        const journey = { ...item, stages: [], exitStage: null, exitReason: null, disputed: false };

        journey.stages.push({ stage: STAGE.EXTRACTED, continued: true });

        // ANALYSIS
        const a = analysed.get(item.stableItemKey);

        if (!a) {
            journey.exitStage = STAGE.ANALYZED;
            journey.exitReason =
                "NOT SEEN BY ANALYSIS. The tradeline was extracted but never appeared in the " +
                "analysis output. THIS IS A BUG, not a decision.";
            journey.bug = true;
            return journey;
        }

        journey.findingCount = a.findings.length;
        journey.findingCodes = a.findings.map((f) => f.code);
        journey.stages.push({ stage: STAGE.ANALYZED, continued: true, findings: a.findings.length });

        // DECISION
        //
        // NOTE THE ORDER. We look for a DECISION before we conclude anything from
        // an empty finding set.
        //
        // A BASELINE item has ZERO findings BY DESIGN — that is its whole premise:
        // a derogatory account with no detectable contradiction, disputed under
        // §611 anyway. If we exited on `findings.length === 0` the way this code
        // used to, EVERY baseline dispute would vanish here, silently, and the
        // reconciliation would cheerfully report it as "No findings".
        //
        // That is precisely the failure the ruling forbids.
        const d = decided.get(item.stableItemKey);

        if (!d) {
            if (a.findings.length === 0) {
                // No findings AND no decision. Legal only if this is not an
                // eligible negative.
                journey.exitStage = STAGE.ANALYZED;

                if (item.negative) {
                    // THE RULING: an eligible negative may never exit here.
                    journey.exitCategory = EXIT.POLICY_VIOLATION;
                    journey.exitReason =
                        "POLICY VIOLATION — an eligible negative tradeline exited as 'No Findings'. " +
                        "Business Trappers policy is that EVERY eligible negative tradeline is " +
                        "disputed: the Analysis Engine decides HOW, never WHETHER. This item should " +
                        "have entered the baseline reinvestigation path, been excluded, or been " +
                        "withheld — with a reason. It did none of those.";
                    journey.bug = true;
                } else {
                    journey.exitCategory = EXIT.NO_FINDINGS;
                    journey.exitReason =
                        "No findings, and not a negative tradeline. Positive accounts are never disputed.";
                }

                return journey;
            }

            journey.exitStage = STAGE.DECIDED;
            journey.exitCategory = EXIT.BUG;
            journey.exitReason =
                "NOT SEEN BY THE DECISION ENGINE despite carrying findings. THIS IS A BUG.";
            journey.bug = true;
            return journey;
        }

        // BT-DM-0054 IS the baseline path. It is emitted by the Analysis Engine
        // ONLY when no specific defect was found — so a specific strategy always
        // supersedes it, and one tradeline never gets two dispute sections.
        journey.baseline = d.primaryDecision?.record === "BT-DM-0054";

        journey.outcome = d.outcome;
        journey.decisionRecord = d.primaryDecision?.record ?? null;
        journey.evidenceClass = d.evidenceClass ?? null;
        journey.stages.push({ stage: STAGE.DECIDED, continued: true, outcome: d.outcome });

        if (d.outcome === "EXCLUDED") {
            journey.exitStage = STAGE.DECIDED;
            journey.exitCategory = EXIT.EXCLUDED;
            journey.exitReason = `EXCLUDED — ${d.exclusion?.rule}: ${d.exclusion?.reason}`;
            return journey;
        }

        if (d.outcome === "NO_ACTION") {
            journey.exitStage = STAGE.DECIDED;

            // Same ruling. A negative tradeline may not fall out here either.
            if (item.negative) {
                journey.exitCategory = EXIT.POLICY_VIOLATION;
                journey.exitReason =
                    "POLICY VIOLATION — an eligible negative tradeline exited as 'No Action'. Every " +
                    "eligible negative tradeline must be disputed via a specific strategy or the " +
                    "baseline path.";
                journey.bug = true;
            } else {
                journey.exitCategory = EXIT.NO_FINDINGS;
                journey.exitReason = "No actionable Decision Record, and not a negative tradeline.";
            }

            return journey;
        }

        if (d.outcome === "REQUIRES_CONSUMER_INPUT") {
            journey.exitStage = STAGE.DECIDED;
            journey.exitReason = "Requires consumer confirmation. Not converted into a dispute.";
            return journey;
        }

        // STRATEGY
        const s = strategised.get(item.stableItemKey);

        if (!s) {
            journey.exitStage = STAGE.STRATEGISED;
            journey.exitReason = "NOT SEEN BY THE STRATEGY ENGINE. THIS IS A BUG.";
            journey.bug = true;
            return journey;
        }

        journey.strategy = s.strategy?.strategy ?? null;
        journey.round = s.round;
        journey.escalated = s.escalated;
        journey.stages.push({ stage: STAGE.STRATEGISED, continued: true, strategy: journey.strategy });

        if (!s.strategy || s.strategy.strategy === "BT-ST-0016") {
            journey.exitStage = STAGE.STRATEGISED;
            journey.exitReason = s.humanReviewReasons?.[0] ?? "No further action.";
            return journey;
        }

        // LETTER
        if (withheld.has(item.stableItemKey)) {
            journey.exitStage = STAGE.LETTERED;
            journey.exitCategory = EXIT.WITHHELD;
            journey.exitReason = `WITHHELD — ${withheld.get(item.stableItemKey).reason}`;
            return journey;
        }

        if (!lettered.has(item.stableItemKey)) {
            journey.exitStage = STAGE.LETTERED;
            journey.exitReason =
                "REACHED LETTER GENERATION BUT DOES NOT APPEAR IN ANY LETTER, and was not " +
                "explicitly withheld. THIS IS A BUG — an item cannot vanish here.";
            journey.bug = true;
            return journey;
        }

        journey.stages.push({ stage: STAGE.LETTERED, continued: true });
        journey.disputed = true;
        journey.exitCategory = journey.baseline
            ? EXIT.BASELINE_REINVESTIGATION
            : EXIT.SPECIFIC_STRATEGY;

        return journey;
    });

    // ---- Per-bureau reconciliation ----------------------------------------
    const bureaus = [...new Set(extracted.map((e) => e.bureau).filter(Boolean))].sort();

    // Sections actually printed in each bureau's letter. THE GROUND TRUTH for
    // what we are about to send.
    const sectionsByBureau = new Map();

    for (const letter of letters?.letters ?? []) {
        sectionsByBureau.set(letter.bureau, (letter.accountSections ?? []).length);
    }

    const byBureau = bureaus.map((bureau) => {
        const items = journeys.filter((j) => j.bureau === bureau && j.kind !== "INQUIRY");

        // THE POPULATION IS EVERY TRADELINE — not just the negative ones.
        //
        // This was a real defect. Reconciling only negatives meant a DISPUTED
        // tradeline that is not negative BY ITS OWN BUREAU'S DATA sat outside the
        // population entirely, and could never fail to balance because it was
        // never counted. Experian reporting an account as "Current" while
        // TransUnion calls it a charge-off is exactly that case: disputable on
        // cross-bureau variance, and invisible to a negatives-only count.
        const negatives = items.filter((j) => j.negative);
        const disputed = items.filter((j) => j.disputed);

        // ---- THE FOUR LEGAL EXITS FOR AN ELIGIBLE NEGATIVE -----------------
        const bySpecific = negatives.filter((j) => j.exitCategory === EXIT.SPECIFIC_STRATEGY);
        const byBaseline = negatives.filter((j) => j.exitCategory === EXIT.BASELINE_REINVESTIGATION);
        const byExcluded = negatives.filter((j) => j.exitCategory === EXIT.EXCLUDED);
        const byWithheld = negatives.filter((j) => j.exitCategory === EXIT.WITHHELD);

        // Anything else is a violation of the coverage ruling.
        const violations = negatives.filter(
            (j) =>
                ![
                    EXIT.SPECIFIC_STRATEGY,
                    EXIT.BASELINE_REINVESTIGATION,
                    EXIT.EXCLUDED,
                    EXIT.WITHHELD,
                ].includes(j.exitCategory)
        );

        const negativesCovered =
            bySpecific.length + byBaseline.length + byExcluded.length + byWithheld.length;

        const coverageHolds = violations.length === 0 && negativesCovered === negatives.length;

        const excluded = items.filter((j) => j.exitReason?.startsWith("EXCLUDED"));
        const heldBack = items.filter((j) => j.exitReason?.startsWith("WITHHELD"));
        const noFindings = items.filter((j) => j.exitStage === "ANALYZED" && j.findingCount === 0);
        const other = items.filter(
            (j) => !j.disputed && !excluded.includes(j) && !heldBack.includes(j) && !noFindings.includes(j)
        );

        const accountedFor =
            disputed.length + excluded.length + heldBack.length + noFindings.length + other.length;

        // ---- THE INVARIANT ------------------------------------------------
        //
        //   sum(letter account sections for this bureau) === disputed for this bureau
        //
        // A tradeline printed in a letter MUST exist in that bureau's population
        // and MUST be counted as disputed. If these disagree, we are sending
        // something reconciliation does not know about — which is precisely the
        // condition reconciliation exists to make impossible.
        const letterSections = sectionsByBureau.get(bureau) ?? 0;
        const invariantHolds = letterSections === disputed.length;

        return {
            bureau,
            totalTradelines: items.length,
            negativeTradelines: negatives.length,

            // ---- COVERAGE: every eligible negative exits exactly one of four ----
            coverage: {
                specificStrategy: bySpecific.length,
                baselineReinvestigation: byBaseline.length,
                excluded: byExcluded.length,
                withheld: byWithheld.length,
                covered: negativesCovered,
                total: negatives.length,
                holds: coverageHolds,
                violations: violations.map((j) => ({
                    furnisher: j.furnisher,
                    stableItemKey: j.stableItemKey,
                    status: j.status,
                    exitCategory: j.exitCategory ?? "(none)",
                    reason: j.exitReason,
                })),
            },
            coverageHolds,

            disputed: disputed.length,
            excluded: excluded.length,
            withheld: heldBack.length,
            noFindings: noFindings.length,
            otherExit: other.length,

            accountedFor,
            balances: accountedFor === items.length,

            letterAccountSections: letterSections,
            invariantHolds,
            invariantNote: invariantHolds
                ? null
                : `INVARIANT VIOLATED: the ${bureau} letter contains ${letterSections} account ` +
                  `section(s), but reconciliation counts ${disputed.length} disputed tradeline(s). ` +
                  `Every tradeline in a letter must be counted as disputed for that bureau. ` +
                  `THE PACKAGE IS NOT CLIENT-READY.`,

            exits: items
                .filter((j) => !j.disputed)
                .map((j) => ({
                    furnisher: j.furnisher,
                    stableItemKey: j.stableItemKey,
                    status: j.status,
                    negative: j.negative,
                    exitStage: j.exitStage,
                    reason: j.exitReason,
                    bug: !!j.bug,
                })),
        };
    });

    const bugs = journeys.filter((j) => j.bug);
    const allBalance = byBureau.every((b) => b.balances);
    const allCoverage = byBureau.every((b) => b.coverageHolds);
    const allInvariants = byBureau.every((b) => b.invariantHolds);

    return {
        schemaVersion: RECONCILE_SCHEMA_VERSION,

        // The whole point. If this is false, THE PACKAGE IS NOT CLIENT-READY.
        // RECONCILES may be YES only if:
        //   - every tradeline is accounted for,
        //   - letter sections match the disputed count exactly,
        //   - EVERY ELIGIBLE NEGATIVE exits via one of the four legal doors,
        //   - and nothing vanished.
        reconciles: allBalance && allInvariants && allCoverage && bugs.length === 0,
        coverageHolds: allCoverage,
        invariantsHold: allInvariants,

        totals: {
            extractedTradelines: extracted.filter((e) => e.kind !== "INQUIRY").length,
            extractedInquiries: extracted.filter((e) => e.kind === "INQUIRY").length,
            negativeTradelines: journeys.filter((j) => j.negative).length,
            disputed: journeys.filter((j) => j.disputed).length,
            letterAccountSections: [...sectionsByBureau.values()].reduce((a, b) => a + b, 0),
            bugs: bugs.length,
            invariantViolations: byBureau.filter((b) => !b.invariantHolds).length,
        },

        byBureau,
        journeys,

        bugs: bugs.map((b) => ({
            stableItemKey: b.stableItemKey,
            bureau: b.bureau,
            furnisher: b.furnisher,
            exitStage: b.exitStage,
            reason: b.exitReason,
        })),
    };
}

/** Human-readable reconciliation, per bureau. */
export function formatReconciliation(r) {
    const out = [];

    out.push("PIPELINE RECONCILIATION — every tradeline accounted for");
    out.push("=".repeat(78));
    out.push("");
    out.push(`Tradelines captured: ${r.totals.extractedTradelines}   Negative: ${r.totals.negativeTradelines}   Disputed: ${r.totals.disputed}   Letter sections: ${r.totals.letterAccountSections}`);
    out.push(`RECONCILES: ${r.reconciles ? "YES — nothing disappeared, every letter section is accounted for" : "NO — NOT CLIENT-READY. SEE BELOW."}`);
    out.push("");

    for (const b of r.byBureau) {
        out.push("-".repeat(78));
        out.push(b.bureau.toUpperCase());
        out.push("-".repeat(78));
        out.push(`  Total tradelines captured    : ${b.totalTradelines}`);
        out.push(`  Of which negative/derogatory : ${b.negativeTradelines}`);
        out.push(`    -> Disputed                : ${b.disputed}`);
        out.push(`    -> Excluded (Constitution) : ${b.excluded}`);
        out.push(`    -> Withheld (unsendable)   : ${b.withheld}`);
        out.push(`    -> No action (no findings) : ${b.noFindings}`);
        out.push(`    -> Other exit              : ${b.otherExit}`);
        out.push(`    ACCOUNTED FOR              : ${b.accountedFor} / ${b.totalTradelines}  ${b.balances ? "BALANCES" : "*** DOES NOT BALANCE ***"}`);
        out.push("");
        out.push(`  INVARIANT — letter sections == disputed`);
        out.push(`    Letter account sections    : ${b.letterAccountSections}`);
        out.push(`    Reconciled as disputed     : ${b.disputed}`);
        out.push(`    ${b.invariantHolds ? "HOLDS" : "*** VIOLATED ***"}`);
        out.push("");
        out.push(`  COVERAGE — every eligible negative exits exactly one of four:`);
        out.push(`    Specific strategy          : ${b.coverage.specificStrategy}`);
        out.push(`    Baseline reinvestigation   : ${b.coverage.baselineReinvestigation}`);
        out.push(`    Excluded                   : ${b.coverage.excluded}`);
        out.push(`    Withheld                   : ${b.coverage.withheld}`);
        out.push(`    COVERED                    : ${b.coverage.covered} / ${b.coverage.total}  ${b.coverageHolds ? "HOLDS" : "*** VIOLATED ***"}`);

        if (b.coverage.violations.length) {
            out.push("");
            out.push(`    *** COVERAGE VIOLATIONS — eligible negatives with no legal exit ***`);
            for (const v of b.coverage.violations) {
                out.push(`      ${v.furnisher} (${v.status ?? "no status"}) -> ${v.exitCategory}`);
                out.push(`        ${v.reason}`);
            }
        }

        if (!b.invariantHolds) {
            out.push(`    ${b.invariantNote}`);
        }

        if (b.exits.length) {
            out.push("");
            out.push("  Every tradeline NOT disputed, and why:");
            for (const e of b.exits) {
                out.push(`    ${e.bug ? "[BUG] " : ""}${e.furnisher} (${e.status ?? "no status"})${e.negative ? " [NEGATIVE]" : ""}`);
                out.push(`      exited at ${e.exitStage}: ${e.reason}`);
            }
        }
        out.push("");
    }

    if (r.bugs.length) {
        out.push("!".repeat(78));
        out.push("BUGS — items that vanished without a decision. Do not send this package.");
        out.push("!".repeat(78));
        for (const bug of r.bugs) {
            out.push(`  ${bug.furnisher} (${bug.bureau}) — ${bug.exitStage}: ${bug.reason}`);
        }
    }

    return out.join("\n");
}
