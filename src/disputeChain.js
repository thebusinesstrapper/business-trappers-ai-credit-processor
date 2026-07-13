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
    "BT-DM-0002": { reason: "BT-RN-0005", name: "Duplicate Inquiry" },
    "BT-DM-0004": { reason: "BT-RN-0001", name: "Incorrect Name" },
    "BT-DM-0006": { reason: "BT-RN-0003", name: "Incorrect Employer" },
    "BT-DM-0007": { reason: "BT-RN-0016", name: "Mixed File" },
    "BT-DM-0008": { reason: "BT-RN-0007", name: "Third-Party Collection" },
    "BT-DM-0010": { reason: "BT-RN-0009", name: "Duplicate Collection" },
    "BT-DM-0011": { reason: "BT-RN-0010", name: "Incorrect Balance" },
    "BT-DM-0013": { reason: "BT-RN-0013", name: "Re-aged Account" },
    "BT-DM-0014": { reason: "BT-RN-0012", name: "Incorrect Payment History" },
    "BT-DM-0018": { reason: "BT-RN-0014", name: "Duplicate Tradeline" },
    "BT-DM-0019": { reason: "BT-RN-0011", name: "Incorrect Account Status" },
    "BT-DM-0028": { reason: "BT-RN-0002", name: "Incorrect Address" },
    "BT-DM-0029": { reason: "BT-RN-0022", name: "Cannot Verify" },
    "BT-DM-0031": { reason: "BT-RN-0022", name: "Cannot Verify" },
    "BT-DM-0033": { reason: "BT-RN-0018", name: "Metro 2 Inconsistency" },
    "BT-DM-0034": { reason: "BT-RN-0013", name: "Re-aged Account" },
    "BT-DM-0051": { reason: "BT-RN-0022", name: "Cannot Verify" },
    "BT-DM-0052": { reason: "BT-RN-0022", name: "Cannot Verify" },
    "BT-DM-0053": { reason: "BT-RN-0022", name: "Cannot Verify" },
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
    "BT-RN-0001": { instruction: "BT-IN-0001", name: "Remove Incorrect Name" },
    "BT-RN-0002": { instruction: "BT-IN-0002", name: "Remove Incorrect Address" },
    "BT-RN-0003": { instruction: "BT-IN-0003", name: "Remove Incorrect Employer" },
    "BT-RN-0005": { instruction: "BT-IN-0005", name: "Investigate Duplicate Inquiry" },
    "BT-RN-0007": { instruction: "BT-IN-0006", name: "Validate Collection" },
    "BT-RN-0009": { instruction: "BT-IN-0006", name: "Validate Collection" },
    "BT-RN-0010": { instruction: "BT-IN-0011", name: "Correct Balance" },
    "BT-RN-0011": { instruction: "BT-IN-0010", name: "Correct Account Status" },
    "BT-RN-0012": { instruction: "BT-IN-0009", name: "Correct Payment History" },
    "BT-RN-0013": { instruction: "BT-IN-0008", name: "Correct Charge-Off Status" },
    "BT-RN-0014": { instruction: "BT-IN-0012", name: "Remove Duplicate Tradeline" },
    "BT-RN-0016": { instruction: "BT-IN-0013", name: "Resolve Mixed File" },
    "BT-RN-0018": { instruction: "BT-IN-0015", name: "Metro 2 Accuracy Review" },
    "BT-RN-0019": { instruction: "BT-IN-0018", name: "Failure to Investigate Escalation" },
    "BT-RN-0020": { instruction: "BT-IN-0019", name: "Failure to Update Escalation" },
    "BT-RN-0022": { instruction: "BT-IN-0016", name: "Bureau Reinvestigation" },
    "BT-RN-0023": { instruction: "BT-IN-0020", name: "Notice & Cure" },
    "BT-RN-0026": { instruction: "BT-IN-0023", name: "No Further Action" },
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
    "BT-IN-0001": { blueprint: "BT-BP-0003", name: "Personal Information Correction" },
    "BT-IN-0002": { blueprint: "BT-BP-0003", name: "Personal Information Correction" },
    "BT-IN-0003": { blueprint: "BT-BP-0003", name: "Personal Information Correction" },
    "BT-IN-0005": { blueprint: "BT-BP-0004", name: "Unauthorized Inquiry" },
    "BT-IN-0006": { blueprint: "BT-BP-0005", name: "Collection Validation" },
    "BT-IN-0008": { blueprint: "BT-BP-0006", name: "Charge-Off Investigation" },
    "BT-IN-0009": { blueprint: "BT-BP-0007", name: "Payment History Correction" },
    "BT-IN-0010": { blueprint: "BT-BP-0001", name: "Bureau Reinvestigation" },
    "BT-IN-0011": { blueprint: "BT-BP-0001", name: "Bureau Reinvestigation" },
    "BT-IN-0012": { blueprint: "BT-BP-0001", name: "Bureau Reinvestigation" },
    "BT-IN-0013": { blueprint: "BT-BP-0009", name: "Mixed File Resolution" },
    "BT-IN-0015": { blueprint: "BT-BP-0010", name: "Metro 2 Accuracy Review" },
    "BT-IN-0016": { blueprint: "BT-BP-0001", name: "Bureau Reinvestigation" },
    "BT-IN-0018": { blueprint: "BT-BP-0011", name: "Failure to Conduct Reasonable Investigation" },
    "BT-IN-0019": { blueprint: "BT-BP-0012", name: "Failure to Update Reporting" },
    "BT-IN-0020": { blueprint: "BT-BP-0013", name: "Notice & Cure" },
    "BT-IN-0023": { blueprint: "BT-BP-0016", name: "No Further Action" },
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
            strategy: itemStrategy.strategy,
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
