/**
 * selectStrategy.js
 *
 * THE STRATEGY ENGINE (Milestone 9).
 *
 *   Capture -> Normalize -> Analyze -> Decision -> [STRATEGY] -> Reason
 *           -> Instruction -> Letter Blueprint -> Letter Generation
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENGINE DOES
 *
 *   The Decision Engine said WHICH DECISION RECORD GOVERNS a bureau tradeline.
 *   This engine says HOW WE PURSUE IT — which Strategy Record, which round, and
 *   whether the item has earned escalation.
 *
 *   It is the FIRST engine that consumes DISPUTE HISTORY. Everything before it
 *   looked only at the current report. This one asks: what have we already
 *   tried on THIS bureau tradeline, and what happened?
 *
 *   It selects NO law, NO reason, NO instruction. It writes no letters.
 *
 *   PURE and DETERMINISTIC. No GPT. No browser. No network.
 *
 * ---------------------------------------------------------------------------
 * ESCALATION IS EARNED, NOT SCHEDULED
 *
 *   The single most tempting mistake here is to escalate on a CALENDAR:
 *   "round 3, so send the angry letter."
 *
 *   That is wrong, and it is the reason most credit repair letters fail. A round
 *   number is not a fact about the bureau's conduct. Escalation must be earned
 *   by something the bureau actually DID:
 *
 *     - it verified an item that is self-evidently wrong  -> failure to investigate
 *     - it said it would correct, and did not             -> failure to update
 *     - it deleted an item, and the item came back        -> reinsertion
 *
 *   Where none of those happened, we do NOT escalate merely because time passed.
 *   An unearned escalation asserts misconduct we cannot evidence — and the
 *   Writing Style Guide forbids exactly that: "State facts instead of making
 *   accusations."
 *
 *   HISTORY IS KEYED ON stable_item_key, NOT stable_account_key.
 *   TransUnion may have failed to investigate while Experian corrected on round
 *   one. They are separate legal proceedings and escalate independently.
 * ---------------------------------------------------------------------------
 */

import { OUTCOME } from "./decideDisputes.js";
import { AUTOMATION_TIER } from "./decisionRecords.js";

export const STRATEGY_SCHEMA_VERSION = "BT-STRATEGY-1.0";

export const MAX_ROUNDS = 6; // AI Processing Decision Engine v1.0. Six, not five.

/**
 * DECISION RECORD -> STRATEGY RECORD, for a FIRST dispute (round 1).
 *
 * Escalation strategies (BT-ST-0011 and above) are never selected from this
 * table. They are only reachable through EARNED escalation, below.
 */
const DECISION_TO_STRATEGY = Object.freeze({
    // GOVERNED Decision -> Strategy — Code Alignment Map v1.0 / Master Governance Matrix v1.0.
    // All 55 governed decisions. A decision not reached by any finding is still
    // defined here so its chain is governed the moment it becomes reachable.
    "BT-DM-0001": { strategy: "BT-ST-0004", name: "Unauthorized Inquiry" },
    "BT-DM-0002": { strategy: "BT-ST-0004", name: "Unauthorized Inquiry" },
    "BT-DM-0003": { strategy: "BT-ST-0008", name: "Identity Theft" },
    "BT-DM-0004": { strategy: "BT-ST-0003", name: "Personal Information Correction" },
    "BT-DM-0005": { strategy: "BT-ST-0003", name: "Personal Information Correction" },
    "BT-DM-0006": { strategy: "BT-ST-0003", name: "Personal Information Correction" },
    "BT-DM-0007": { strategy: "BT-ST-0009", name: "Mixed File Resolution" },
    "BT-DM-0008": { strategy: "BT-ST-0005", name: "Collection Validation" },
    "BT-DM-0009": { strategy: "BT-ST-0005", name: "Collection Validation" },
    "BT-DM-0010": { strategy: "BT-ST-0005", name: "Collection Validation" },
    "BT-DM-0011": { strategy: "BT-ST-0006", name: "Charge-Off Investigation" },
    "BT-DM-0012": { strategy: "BT-ST-0006", name: "Charge-Off Investigation" },
    "BT-DM-0013": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0014": { strategy: "BT-ST-0007", name: "Payment History Correction" },
    "BT-DM-0015": { strategy: "BT-ST-0007", name: "Payment History Correction" },
    "BT-DM-0016": { strategy: "BT-ST-0007", name: "Payment History Correction" },
    "BT-DM-0017": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0018": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0019": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0020": { strategy: "BT-ST-0012", name: "Failure to Update" },
    "BT-DM-0021": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0022": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0023": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0024": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0025": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0026": { strategy: "BT-ST-0008", name: "Identity Theft" },
    "BT-DM-0027": { strategy: "BT-ST-0008", name: "Identity Theft" },
    "BT-DM-0028": { strategy: "BT-ST-0003", name: "Personal Information Correction" },
    "BT-DM-0029": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0030": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0031": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0032": { strategy: "BT-ST-0002", name: "Furnisher Investigation" },
    "BT-DM-0033": { strategy: "BT-ST-0010", name: "Metro 2 Accuracy Review" },
    "BT-DM-0034": { strategy: "BT-ST-0006", name: "Charge-Off Investigation" },
    "BT-DM-0035": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0036": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0037": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0038": { strategy: "BT-ST-0002", name: "Furnisher Investigation" },
    "BT-DM-0039": { strategy: "BT-ST-0002", name: "Furnisher Investigation" },
    "BT-DM-0040": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0041": { strategy: "BT-ST-0013", name: "Notice & Cure" },
    "BT-DM-0042": { strategy: "BT-ST-0002", name: "Furnisher Investigation" },
    "BT-DM-0043": { strategy: "BT-ST-0011", name: "Failure to Investigate" },
    "BT-DM-0044": { strategy: "BT-ST-0011", name: "Failure to Investigate" },
    "BT-DM-0045": { strategy: "BT-ST-0014", name: "S-2(b)" },
    "BT-DM-0046": { strategy: "BT-ST-0015", name: "Arbitration" },
    "BT-DM-0047": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0048": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0049": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0050": { strategy: "BT-ST-0016", name: "No Further Action" },
    "BT-DM-0051": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0052": { strategy: "BT-ST-0004", name: "Unauthorized Inquiry" },
    "BT-DM-0053": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0054": { strategy: "BT-ST-0001", name: "Bureau Investigation" },
    "BT-DM-0055": { strategy: "BT-ST-0004", name: "Unauthorized Inquiry" },
});

const STRATEGY_NO_FURTHER_ACTION = { strategy: "BT-ST-0016", name: "No Further Action" };

/**
 * THE REQUESTED REMEDY IS A PROPERTY OF THE STRATEGY, NOT THE LETTER.
 *
 * The Letter Engine used to default everything to "delete or correct as the
 * investigation requires" — a hedge that asks for nothing in particular and
 * reads like a form. It is also strategically wrong: a Failure to Investigate
 * escalation does not want a re-run of the same investigation; it wants the
 * METHOD OF VERIFICATION, because the point at issue is HOW the bureau reached
 * its conclusion.
 *
 * Remedy priority follows the Legal Remedy Standards: deletion whenever legally
 * supported; correction where deletion is not the appropriate remedy.
 */
export const REMEDY = Object.freeze({
    // GOVERNED REMEDY CATALOG — verbatim from Legal Remedy Standards v2.0 /
    // Code Alignment Map v1.0. These are the ONLY approved remedy strings.
    // No unconditional "delete this account" remedy exists: deletion is always
    // conditional on non-verification unless a decision's governed contract says otherwise.
    REINVESTIGATE_CONDITIONAL: "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected.",
    PERSONAL_INFO_CORRECT: "Correct or remove the inaccurate personal-information entry.",
    REMOVE_DUPLICATE: "Remove the duplicate reporting while preserving the correctly reported account or inquiry.",
    UPDATE_VERIFIED: "Update the reporting to reflect the verified current information; delete only if it cannot be accurately corrected.",
    PERMISSIBLE_PURPOSE: "Investigate permissible purpose and remove the inquiry only if authorization or another permissible purpose cannot be verified.",
    OBSOLESCENCE_GATED: "Delete only when the applicable reporting period can be affirmatively calculated and has expired; otherwise route to review or request verification without alleging obsolescence.",
    IDENTITY_THEFT_BLOCK: "Block or remove identity-theft information only after required consumer documentation and identity verification are satisfied.",
    ESCALATION_REMEDY: "Apply the approved escalation remedy supported by prior dispute history, response evidence, and contractual or statutory prerequisites.",
    NO_REMEDY: "No dispute remedy. Preserve the item and document the reason.",
});

const REMEDY_BY_DECISION = Object.freeze({
    // GOVERNED per-decision remedy contract — the authoritative source.
    // remedyFor() resolves from THIS table (decision-indexed), per governance.
    "BT-DM-0001": REMEDY.PERMISSIBLE_PURPOSE,
    "BT-DM-0002": REMEDY.REMOVE_DUPLICATE,
    "BT-DM-0003": REMEDY.IDENTITY_THEFT_BLOCK,
    "BT-DM-0004": REMEDY.PERSONAL_INFO_CORRECT,
    "BT-DM-0005": REMEDY.PERSONAL_INFO_CORRECT,
    "BT-DM-0006": REMEDY.PERSONAL_INFO_CORRECT,
    "BT-DM-0007": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0008": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0009": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0010": REMEDY.REMOVE_DUPLICATE,
    "BT-DM-0011": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0012": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0013": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0014": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0015": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0016": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0017": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0018": REMEDY.REMOVE_DUPLICATE,
    "BT-DM-0019": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0020": REMEDY.UPDATE_VERIFIED,
    "BT-DM-0021": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0022": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0023": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0024": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0025": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0026": REMEDY.IDENTITY_THEFT_BLOCK,
    "BT-DM-0027": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0028": REMEDY.PERSONAL_INFO_CORRECT,
    "BT-DM-0029": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0030": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0031": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0032": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0033": "Conduct a reasonable reinvestigation; correct or update the reporting as necessary, and delete the item only if it cannot be verified or accurately corrected.",
    "BT-DM-0034": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0035": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0036": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0037": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0038": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0039": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0040": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0041": REMEDY.ESCALATION_REMEDY,
    "BT-DM-0042": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0043": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0044": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0045": REMEDY.ESCALATION_REMEDY,
    "BT-DM-0046": REMEDY.ESCALATION_REMEDY,
    "BT-DM-0047": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0048": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0049": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0050": REMEDY.NO_REMEDY,
    "BT-DM-0051": REMEDY.OBSOLESCENCE_GATED,
    "BT-DM-0052": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0053": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0054": REMEDY.REINVESTIGATE_CONDITIONAL,
    "BT-DM-0055": REMEDY.PERMISSIBLE_PURPOSE,
});

export function remedyFor(strategyId, decisionRecord) {
    // GOVERNED: the remedy is a per-decision contract (Code Alignment Map v1.0).
    // Resolve from the decision. The fail-closed default is the conditional
    // reinvestigation remedy — NEVER an unconditional deletion demand.
    return REMEDY_BY_DECISION[decisionRecord] ?? REMEDY.REINVESTIGATE_CONDITIONAL;
}

/**
 * Escalation strategies. Reached ONLY by earning them.
 */
const ESCALATION = Object.freeze({
    FURNISHER: { strategy: "BT-ST-0002", name: "Furnisher Investigation" },
    FAILURE_TO_INVESTIGATE: { strategy: "BT-ST-0011", name: "Failure to Investigate" },
    FAILURE_TO_UPDATE: { strategy: "BT-ST-0012", name: "Failure to Update" },
    NOTICE_AND_CURE: { strategy: "BT-ST-0013", name: "Notice & Cure" },
});

/** Outcomes AI Memory records for a previously disputed item. */
export const PRIOR_OUTCOME = Object.freeze({
    DELETED: "deleted",
    CORRECTED: "corrected",
    VERIFIED: "verified",     // the bureau said "we checked, it's right"
    UNCHANGED: "unchanged",   // nothing came back / nothing moved
    REAPPEARED: "reappeared",
    UNKNOWN: "unknown",
});

// ---------------------------------------------------------------------------
// Earned escalation
// ---------------------------------------------------------------------------

/**
 * Decide whether THIS bureau tradeline has earned escalation, based on what the
 * bureau actually did — never on the round number alone.
 *
 * @returns {{ escalate: boolean, strategy?: object, grounds?: string }}
 */
function evaluateEscalation(history, evidenceClass) {
    const priorRounds = history.rounds ?? [];

    if (priorRounds.length === 0) {
        return { escalate: false, grounds: "No prior dispute on this bureau tradeline. Round 1." };
    }

    const last = priorRounds[priorRounds.length - 1];

    // 1. REINSERTION. The item was deleted and came back. This is the most
    //    serious thing a bureau can do, and it is earned the moment it happens —
    //    no waiting period, no round threshold.
    if (last.outcome === PRIOR_OUTCOME.REAPPEARED) {
        return {
            escalate: true,
            strategy: ESCALATION.NOTICE_AND_CURE,
            grounds:
                `This item was previously DELETED and has REAPPEARED on the report. Reinserting a ` +
                `deleted item carries its own notice obligations, and this is established by our own ` +
                `persisted report history — not inferred.`,
        };
    }

    // 2. FAILURE TO INVESTIGATE. The bureau "verified" an item whose defect is
    //    SELF-EVIDENT on the face of its own report.
    //
    //    This is the strongest escalation we can support, and note WHY it is
    //    available: a bureau cannot have reasonably investigated a record that
    //    contradicts itself and still concluded it was accurate. The claim rests
    //    on the contradiction, not on our displeasure with the outcome.
    //
    //    It is deliberately NOT available for CROSS_BUREAU evidence. There, the
    //    bureau may genuinely believe its own data is right, and we cannot say
    //    it failed to investigate merely because it disagreed with us.
    if (last.outcome === PRIOR_OUTCOME.VERIFIED && evidenceClass === "SELF_EVIDENT") {
        return {
            escalate: true,
            strategy: ESCALATION.FAILURE_TO_INVESTIGATE,
            grounds:
                `The bureau reported this item as VERIFIED, yet the item remains internally ` +
                `contradictory on the face of its own report. A reasonable investigation could not ` +
                `have confirmed a record that contradicts itself.`,
        };
    }

    // 3. FAILURE TO UPDATE. The bureau said it would correct, and the item is
    //    unchanged in the current report.
    if (last.outcome === PRIOR_OUTCOME.CORRECTED && last.stillPresentUnchanged === true) {
        return {
            escalate: true,
            strategy: ESCALATION.FAILURE_TO_UPDATE,
            grounds:
                `The bureau indicated this item was CORRECTED, but the current report shows it ` +
                `unchanged. The promised correction was not made.`,
        };
    }

    // 4. Bureau verified, but our evidence is cross-bureau / weaker. We cannot
    //    claim failure to investigate. We CAN go to the furnisher, who is the
    //    source of the data and has its own duties.
    if (last.outcome === PRIOR_OUTCOME.VERIFIED) {
        return {
            escalate: true,
            strategy: ESCALATION.FURNISHER,
            grounds:
                `The bureau verified this item. Our evidence (${evidenceClass}) does not establish ` +
                `that the investigation was unreasonable — the bureau may hold data we cannot see. ` +
                `The furnisher is the source of the reporting and is addressed directly.`,
        };
    }

    // 5. Nothing came back at all.
    if (last.outcome === PRIOR_OUTCOME.UNCHANGED || last.outcome === PRIOR_OUTCOME.UNKNOWN) {
        return {
            escalate: true,
            strategy: ESCALATION.FURNISHER,
            grounds:
                `The previous dispute produced no documented response or change. The furnisher is ` +
                `addressed directly.`,
        };
    }

    // 6. It worked. Nothing to escalate.
    return {
        escalate: false,
        resolved: true,
        grounds: `The previous dispute resulted in "${last.outcome}". No further action required.`,
    };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * @param {object} decisions  output of decideDisputes()
 * @param {object} [context]
 * @param {Map<string, object>|object} [context.itemHistory]
 *        Item-level dispute history from AI Memory, KEYED ON stable_item_key.
 *        Shape: { rounds: [{ round, strategy, outcome, stillPresentUnchanged }] }
 *
 *        WITHOUT IT, every item is treated as a FIRST dispute. That is the safe
 *        default: a round-1 letter sent twice is ineffective. An unearned
 *        escalation asserts bureau misconduct we cannot evidence.
 */
export async function selectStrategy(decisions, context = {}) {

    const { itemHistory = new Map() } = context;

    const historyFor = (key) => {
        if (itemHistory instanceof Map) return itemHistory.get(key) ?? { rounds: [] };
        return itemHistory[key] ?? { rounds: [] };
    };

    const haveHistory = itemHistory instanceof Map ? itemHistory.size > 0 : Object.keys(itemHistory).length > 0;

    if (!decisions || decisions.decisionOk !== true) {
        return {
            schemaVersion: STRATEGY_SCHEMA_VERSION,
            strategyOk: false,
            errors: ["Decisions were not successful. No strategy is selected on an untrusted decision set."],
            itemStrategies: [],
            summary: {},
        };
    }

    // A mixed file is resolved FIRST. Item-level strategies are held back:
    // pursuing a tradeline dispute would implicitly assert the tradeline is the
    // client's, which is the very thing in question.
    const mixedFile = decisions.reportLevel?.mixedFile === true;

    const itemStrategies = decisions.itemDecisions.map((decision) => {
        const base = {
            stableItemKey: decision.stableItemKey,       // the legal unit
            stableAccountKey: decision.stableAccountKey, // context
            bureau: decision.bureau,
            furnisher: decision.furnisher,
            kind: decision.kind,
            decisionRecord: decision.primaryDecision?.record ?? null,
        };

        // ---- Items the Decision Engine already closed -----------------------
        if (
            decision.outcome === OUTCOME.EXCLUDED ||
            decision.outcome === OUTCOME.NO_ACTION ||
            decision.outcome === OUTCOME.REQUIRES_CONSUMER_INPUT
        ) {
            return {
                ...base,
                strategy: STRATEGY_NO_FURTHER_ACTION,
                round: null,
                escalated: false,
                automationTier: AUTOMATION_TIER.NEVER_AUTOMATED,
                humanReview: decision.humanReview ?? false,
                reasoningChain: [
                    `The Decision Engine returned ${decision.outcome} for this item.`,
                    decision.exclusion?.reason ??
                        decision.reasoningChain?.[decision.reasoningChain.length - 1] ??
                        "No dispute is pursued.",
                    `Strategy: ${STRATEGY_NO_FURTHER_ACTION.strategy} (${STRATEGY_NO_FURTHER_ACTION.name}).`,
                ],
            };
        }

        const history = historyFor(decision.stableItemKey);
        const priorRounds = history.rounds ?? [];
        const nextRound = priorRounds.length + 1;

        // ---- Round ceiling --------------------------------------------------
        if (nextRound > MAX_ROUNDS) {
            return {
                ...base,
                strategy: STRATEGY_NO_FURTHER_ACTION,
                round: null,
                escalated: false,
                automationTier: AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED,
                humanReview: true,
                humanReviewReasons: [
                    `${MAX_ROUNDS} dispute rounds have been completed on this bureau tradeline without ` +
                    `resolution. The approved DFY process is exhausted. A human decides what happens next.`,
                ],
                reasoningChain: [
                    `${priorRounds.length} prior rounds on ${decision.bureau}'s tradeline.`,
                    `The ${MAX_ROUNDS}-round limit is reached. This engine does not exceed it.`,
                ],
            };
        }

        // ---- Earned escalation ---------------------------------------------
        const escalation = evaluateEscalation(history, decision.evidenceClass);

        if (escalation.resolved) {
            return {
                ...base,
                strategy: STRATEGY_NO_FURTHER_ACTION,
                round: null,
                escalated: false,
                automationTier: AUTOMATION_TIER.NEVER_AUTOMATED,
                humanReview: false,
                reasoningChain: [
                    escalation.grounds,
                    `Strategy: ${STRATEGY_NO_FURTHER_ACTION.strategy} (${STRATEGY_NO_FURTHER_ACTION.name}).`,
                ],
            };
        }

        const initial = DECISION_TO_STRATEGY[decision.primaryDecision?.record];

        if (!initial && !escalation.escalate) {
            return {
                ...base,
                strategy: null,
                round: nextRound,
                escalated: false,
                automationTier: AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED,
                humanReview: true,
                humanReviewReasons: [
                    `No Strategy Record is mapped to Decision Record ` +
                    `${decision.primaryDecision?.record}. Not guessing.`,
                ],
                reasoningChain: [
                    `Decision Record ${decision.primaryDecision?.record} has no mapped strategy.`,
                    `Routed to a human rather than forcing a strategy that may not fit.`,
                ],
            };
        }

        const selected = escalation.escalate ? escalation.strategy : initial;

        // ---- Automation ------------------------------------------------------
        //
        // Escalation ASSERTS BUREAU MISCONDUCT in the consumer's name. Even when
        // the grounds are solid, a human reads it before it goes out. The cost of
        // being wrong here is not a failed dispute — it is a false accusation
        // over the client's signature.
        let tier = decision.automationTier;
        const humanReviewReasons = [...(decision.humanReviewReasons ?? [])];

        if (escalation.escalate) {
            tier = AUTOMATION_TIER.PROCESSOR_REVIEW;
            humanReviewReasons.push(
                "This is an ESCALATION. It asserts that the bureau or furnisher failed to meet an " +
                "obligation. A person reviews any letter that accuses, regardless of how well the " +
                "grounds are evidenced."
            );
        }

        if (mixedFile) {
            tier = AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED;
        }

        const humanReview =
            tier === AUTOMATION_TIER.PROCESSOR_REVIEW ||
            tier === AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED ||
            tier === AUTOMATION_TIER.NEVER_AUTOMATED;

        const reasoningChain = [
            `DECISION: ${decision.primaryDecision.record} (${decision.primaryDecision.name}) on ` +
                `${decision.bureau}'s tradeline for "${decision.furnisher ?? "this item"}".`,

            `EVIDENCE: ${decision.evidenceClass}.`,

            `HISTORY: ${priorRounds.length === 0
                ? "no prior dispute on this bureau tradeline"
                : priorRounds.map((r) => `round ${r.round} (${r.strategy}) -> ${r.outcome}`).join("; ")}.`,

            escalation.escalate
                ? `ESCALATION EARNED: ${escalation.grounds}`
                : `NO ESCALATION: ${escalation.grounds}`,

            `STRATEGY: ${selected.strategy} (${selected.name}), round ${nextRound} of ${MAX_ROUNDS}.`,

            `AUTOMATION: ${tier}.`,

            ...humanReviewReasons.map((r) => `HUMAN REVIEW: ${r}`),

            `SCOPE: this strategy governs ${decision.bureau} only. Other bureaus escalate ` +
                `independently, on their own conduct.`,

            `NEXT: the Reason Engine selects the approved dispute reason. This engine selects no ` +
                `reason, no law, and no instruction.`,
        ];

        return {
            ...base,
            baseline: !!decision.baseline,
            strategy: selected,
            requestedRemedy: remedyFor(selected.strategy, decision.primaryDecision?.record),
            round: nextRound,
            escalated: escalation.escalate,
            escalationGrounds: escalation.escalate ? escalation.grounds : null,
            evidenceClass: decision.evidenceClass,
            automationTier: tier,
            humanReview,
            humanReviewReasons,
            priorRounds: priorRounds.length,
            reasoningChain,
        };
    });

    const active = itemStrategies.filter((s) => s.strategy && s.strategy.strategy !== "BT-ST-0016");

    return {
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        strategyOk: true,
        errors: [],

        itemStrategies,

        summary: {
            itemsEvaluated: itemStrategies.length,
            activeStrategies: active.length,
            escalations: itemStrategies.filter((s) => s.escalated).length,
            noFurtherAction: itemStrategies.filter((s) => s.strategy?.strategy === "BT-ST-0016").length,
            requiringHumanReview: itemStrategies.filter((s) => s.humanReview).length,
            disputeHistoryAvailable: haveHistory,
            allTreatedAsFirstDispute: !haveHistory,
            blockedByMixedFile: mixedFile,
            maxRounds: MAX_ROUNDS,
        },
    };
}
