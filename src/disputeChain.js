/**
 * disputeChain.js
 *
 * REASON ENGINE -> INSTRUCTION ENGINE -> BLUEPRINT SELECTION.
 *
 * Three small, separate mapping engines. Each has ONE job and hands off:
 *
 *   selectReason(strategy)      -> BT-RN-xxxx  the approved dispute reason
 *   selectInstruction(reason)   -> BT-IN-xxxx  the approved processing instruction
 *   selectBlueprint(instruction)-> BT-BP-xxxx  the letter blueprint
 *
 * They are kept separate because the governing chain is:
 *
 *   Decision -> Strategy -> Consumer Law -> Reason -> Instruction -> Blueprint
 *
 * and each library is versioned independently. Collapsing them into one lookup
 * would work today and rot the moment any single library changes.
 *
 * PURE. DETERMINISTIC. NO GPT.
 */

import { AUTOMATION_TIER } from "./decisionRecords.js";

export const CHAIN_SCHEMA_VERSION = "BT-CHAIN-1.0";

// ===========================================================================
// REASON ENGINE — Reason Library
//
// A REASON is the consumer's stated ground for the dispute. It must be
// supportable by the FACTS ALREADY FOUND. This engine invents nothing: it maps
// a decision + finding set onto an APPROVED reason record.
// ===========================================================================

const REASON_BY_DECISION = Object.freeze({
    // GOVERNED Decision -> Reason — Code Alignment Map v1.0 / Reason Library v2.0.
    "BT-DM-0001": { reason: "BT-RN-0004" },
    "BT-DM-0002": { reason: "BT-RN-0004" },
    "BT-DM-0003": { reason: "BT-RN-0017" },
    "BT-DM-0004": { reason: "BT-RN-0001" },
    "BT-DM-0005": { reason: "BT-RN-0001" },
    "BT-DM-0006": { reason: "BT-RN-0001" },
    "BT-DM-0007": { reason: "BT-RN-0016" },
    "BT-DM-0008": { reason: "BT-RN-0007" },
    "BT-DM-0009": { reason: "BT-RN-0007" },
    "BT-DM-0010": { reason: "BT-RN-0007" },
    "BT-DM-0011": { reason: "BT-RN-0010" },
    "BT-DM-0012": { reason: "BT-RN-0010" },
    "BT-DM-0013": { reason: "BT-RN-0022" },
    "BT-DM-0014": { reason: "BT-RN-0012" },
    "BT-DM-0015": { reason: "BT-RN-0012" },
    "BT-DM-0016": { reason: "BT-RN-0012" },
    "BT-DM-0017": { reason: "BT-RN-0022" },
    "BT-DM-0018": { reason: "BT-RN-0022" },
    "BT-DM-0019": { reason: "BT-RN-0022" },
    "BT-DM-0020": { reason: "BT-RN-0020" },
    "BT-DM-0021": { reason: "BT-RN-0022" },
    "BT-DM-0022": { reason: "BT-RN-0022" },
    "BT-DM-0023": { reason: "BT-RN-0022" },
    "BT-DM-0024": { reason: "BT-RN-0022" },
    "BT-DM-0025": { reason: "BT-RN-0022" },
    "BT-DM-0026": { reason: "BT-RN-0017" },
    "BT-DM-0027": { reason: "BT-RN-0017" },
    "BT-DM-0028": { reason: "BT-RN-0001" },
    "BT-DM-0029": { reason: "BT-RN-0022" },
    "BT-DM-0030": { reason: "BT-RN-0022" },
    "BT-DM-0031": { reason: "BT-RN-0022" },
    "BT-DM-0032": { reason: "BT-RN-0022" },
    "BT-DM-0033": { reason: "BT-RN-0018" },
    "BT-DM-0034": { reason: "BT-RN-0010" },
    "BT-DM-0035": { reason: "BT-RN-0022" },
    "BT-DM-0036": { reason: "BT-RN-0022" },
    "BT-DM-0037": { reason: "BT-RN-0022" },
    "BT-DM-0038": { reason: "BT-RN-0022" },
    "BT-DM-0039": { reason: "BT-RN-0022" },
    "BT-DM-0040": { reason: "BT-RN-0022" },
    "BT-DM-0041": { reason: "BT-RN-0023" },
    "BT-DM-0042": { reason: "BT-RN-0022" },
    "BT-DM-0043": { reason: "BT-RN-0019" },
    "BT-DM-0044": { reason: "BT-RN-0019" },
    "BT-DM-0045": { reason: "BT-RN-0024" },
    "BT-DM-0046": { reason: "BT-RN-0025" },
    "BT-DM-0047": { reason: "BT-RN-0022" },
    "BT-DM-0048": { reason: "BT-RN-0022" },
    "BT-DM-0049": { reason: "BT-RN-0022" },
    "BT-DM-0050": { reason: "BT-RN-0026" },
    "BT-DM-0051": { reason: "BT-RN-0022" },
    "BT-DM-0052": { reason: "BT-RN-0004" },
    "BT-DM-0053": { reason: "BT-RN-0022" },
    "BT-DM-0054": { reason: "BT-RN-0022" },
    "BT-DM-0055": { reason: "BT-RN-0004" },
});

// Escalation strategies carry their own reasons, which OVERRIDE the decision's.
// The dispute is no longer about the tradeline — it is about the bureau's
// CONDUCT, and the reason must say so.
const REASON_BY_ESCALATION = Object.freeze({
    "BT-ST-0011": { reason: "BT-RN-0019", name: "Failure to Investigate" },
    "BT-ST-0012": { reason: "BT-RN-0020", name: "Failure to Update" },
    "BT-ST-0013": { reason: "BT-RN-0023", name: "Notice & Cure" },
});

export function selectReason(itemStrategy) {
    if (!itemStrategy.strategy || itemStrategy.strategy.strategy === "BT-ST-0016") {
        return { reason: "BT-RN-0026", name: "No Action Recommended", basis: "No dispute is pursued." };
    }

    const escalationReason = REASON_BY_ESCALATION[itemStrategy.strategy.strategy];

    if (escalationReason) {
        return {
            ...escalationReason,
            basis: itemStrategy.escalationGrounds,
            addressesConduct: true,
        };
    }

    const reason = REASON_BY_DECISION[itemStrategy.decisionRecord];

    if (!reason) {
        return {
            reason: null,
            name: null,
            basis: `No approved reason maps to ${itemStrategy.decisionRecord}. Not guessing.`,
            unmapped: true,
        };
    }

    return { ...reason, basis: "Supported by the facts identified in analysis.", addressesConduct: false };
}

// ===========================================================================
// INSTRUCTION ENGINE — Instruction Library
//
// An INSTRUCTION is the standardized, machine-executable processing action.
// Every instruction originates from an approved Reason Record.
// ===========================================================================

const INSTRUCTION_BY_REASON = Object.freeze({
    // GOVERNED Reason -> Instruction — derived from the governed decision rows
    // (Code Alignment Map v1.0 / Instruction Library v2.0). Internally consistent.
    "BT-RN-0001": { instruction: "BT-IN-0001" },
    "BT-RN-0004": { instruction: "BT-IN-0004" },
    "BT-RN-0007": { instruction: "BT-IN-0006" },
    "BT-RN-0010": { instruction: "BT-IN-0011" },
    "BT-RN-0012": { instruction: "BT-IN-0009" },
    "BT-RN-0016": { instruction: "BT-IN-0013" },
    "BT-RN-0017": { instruction: "BT-IN-0014" },
    "BT-RN-0018": { instruction: "BT-IN-0015" },
    "BT-RN-0019": { instruction: "BT-IN-0018" },
    "BT-RN-0020": { instruction: "BT-IN-0019" },
    "BT-RN-0022": { instruction: "BT-IN-0016" },
    "BT-RN-0023": { instruction: "BT-IN-0020" },
    "BT-RN-0024": { instruction: "BT-IN-0021" },
    "BT-RN-0025": { instruction: "BT-IN-0022" },
    "BT-RN-0026": { instruction: "BT-IN-0023" },
});

export function selectInstruction(reason) {
    if (!reason.reason) {
        return { instruction: null, name: null, unmapped: true };
    }

    const instruction = INSTRUCTION_BY_REASON[reason.reason];

    if (!instruction) {
        return {
            instruction: null,
            name: null,
            unmapped: true,
            note: `No approved instruction maps to ${reason.reason}. Not guessing.`,
        };
    }

    return instruction;
}

// ===========================================================================
// BLUEPRINT SELECTION — Letter Blueprint Library
//
// The blueprint governs the letter's STRUCTURE. It is not a template: it says
// what sections must be present, not what words to use.
// ===========================================================================

const BLUEPRINT_BY_INSTRUCTION = Object.freeze({
    // GOVERNED Instruction -> Blueprint — Code Alignment Map v1.0 / Letter Blueprint Library v2.0.
    "BT-IN-0001": { blueprint: "BT-BP-0001" },
    "BT-IN-0004": { blueprint: "BT-BP-0004" },
    "BT-IN-0006": { blueprint: "BT-BP-0006" },
    "BT-IN-0009": { blueprint: "BT-BP-0009" },
    "BT-IN-0011": { blueprint: "BT-BP-0011" },
    "BT-IN-0013": { blueprint: "BT-BP-0013" },
    "BT-IN-0014": { blueprint: "BT-BP-0014" },
    "BT-IN-0015": { blueprint: "BT-BP-0015" },
    "BT-IN-0016": { blueprint: "BT-BP-0001" },
    "BT-IN-0018": { blueprint: "BT-BP-0011" },
    "BT-IN-0019": { blueprint: "BT-BP-0012" },
    "BT-IN-0020": { blueprint: "BT-BP-0013" },
    "BT-IN-0021": { blueprint: "BT-BP-0014" },
    "BT-IN-0022": { blueprint: "BT-BP-0015" },
    "BT-IN-0023": { blueprint: "BT-BP-0016" },
});

export function selectBlueprint(instruction) {
    if (!instruction.instruction) return { blueprint: null, name: null, unmapped: true };

    return BLUEPRINT_BY_INSTRUCTION[instruction.instruction] ?? { blueprint: null, name: null, unmapped: true };
}

// ===========================================================================
// THE CHAIN
// ===========================================================================

/**
 * Complete the reasoning chain for every item the Strategy Engine produced.
 *
 * @param {object} strategies output of selectStrategy()
 */
export async function buildDisputeChain(strategies) {

    if (!strategies || strategies.strategyOk !== true) {
        return {
            schemaVersion: CHAIN_SCHEMA_VERSION,
            chainOk: false,
            errors: ["Strategy selection was not successful."],
            items: [],
        };
    }

    const items = strategies.itemStrategies.map((itemStrategy) => {
        // Baseline items carry the flag through the chain so the Letter Engine
        // knows to assert nothing.
        const reason = selectReason(itemStrategy);
        const instruction = selectInstruction(reason);
        const blueprint = selectBlueprint(instruction);

        const complete =
            !!reason.reason && !!instruction.instruction && !!blueprint.blueprint &&
            reason.reason !== "BT-RN-0026";

        return {
            stableItemKey: itemStrategy.stableItemKey,
            stableAccountKey: itemStrategy.stableAccountKey,
            bureau: itemStrategy.bureau,
            furnisher: itemStrategy.furnisher,

            decisionRecord: itemStrategy.decisionRecord,
            baseline: !!itemStrategy.baseline,
            strategy: itemStrategy.strategy,
            requestedRemedy: itemStrategy.requestedRemedy ?? null,
            reason,
            instruction,
            blueprint,

            round: itemStrategy.round,
            escalated: itemStrategy.escalated,
            evidenceClass: itemStrategy.evidenceClass,
            automationTier: itemStrategy.automationTier,
            humanReview: itemStrategy.humanReview,
            humanReviewReasons: itemStrategy.humanReviewReasons ?? [],

            chainComplete: complete,

            reasoningChain: [
                ...(itemStrategy.reasoningChain ?? []),
                reason.reason
                    ? `REASON: ${reason.reason} (${reason.name}). ${reason.basis}`
                    : `REASON: none mapped. ${reason.basis}`,
                instruction.instruction
                    ? `INSTRUCTION: ${instruction.instruction} (${instruction.name}).`
                    : `INSTRUCTION: none mapped.`,
                blueprint.blueprint
                    ? `BLUEPRINT: ${blueprint.blueprint} (${blueprint.name}).`
                    : `BLUEPRINT: none mapped.`,
            ],
        };
    });

    const disputable = items.filter((i) => i.chainComplete);

    return {
        schemaVersion: CHAIN_SCHEMA_VERSION,
        chainOk: true,
        errors: [],
        items,
        summary: {
            itemsEvaluated: items.length,
            completeChains: disputable.length,
            incompleteChains: items.length - disputable.length,
            requiringHumanReview: items.filter((i) => i.humanReview).length,
        },
    };
}
