/**
 * governanceContract.test.js
 *
 * THE MASTER GOVERNANCE GUARD.
 *
 * For every production-reachable Decision Record, this asserts that the code's
 * resolved chain — strategy, reason, instruction, blueprint, remedy, and
 * automation tier — matches the authoritative governance (Master Governance
 * Matrix v1.0 / Code Alignment Map v1.0) exactly. If code drifts from governance,
 * this fails.
 *
 * The expectations below are transcribed from the authoritative Code Alignment
 * Map v1.0 rows. They are the source of truth; the code is aligned to them.
 */
import { remedyFor } from "./selectStrategy.js";
import { selectReason, selectInstruction, selectBlueprint } from "./disputeChain.js";
import { automationTierFor } from "./decisionRecords.js";

let passed = 0, failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) console.log(`FAIL  ${label.padEnd(52)} got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
    ok ? passed++ : failed++;
};

const DM33_REMEDY = "Conduct a reasonable reinvestigation; correct or update the reporting as necessary, and delete the item only if it cannot be verified or accurately corrected.";

// [decision, strategy, reason, instruction, blueprint, tier, remedy]
// Transcribed from Code Alignment Map v1.0 (production-reachable decisions).
const GOVERNED = [
    ["BT-DM-0002", "BT-ST-0004", "BT-RN-0004", "BT-IN-0004", "BT-BP-0004", "VALIDATED_AUTOMATION", "Remove the duplicate reporting while preserving the correctly reported account or inquiry."],
    ["BT-DM-0004", "BT-ST-0003", "BT-RN-0001", "BT-IN-0001", "BT-BP-0001", "VALIDATED_AUTOMATION", "Correct or remove the inaccurate personal-information entry."],
    ["BT-DM-0006", "BT-ST-0003", "BT-RN-0001", "BT-IN-0001", "BT-BP-0001", "VALIDATED_AUTOMATION", "Correct or remove the inaccurate personal-information entry."],
    ["BT-DM-0007", "BT-ST-0009", "BT-RN-0016", "BT-IN-0013", "BT-BP-0013", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0008", "BT-ST-0005", "BT-RN-0007", "BT-IN-0006", "BT-BP-0006", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0010", "BT-ST-0005", "BT-RN-0007", "BT-IN-0006", "BT-BP-0006", "VALIDATED_AUTOMATION", "Remove the duplicate reporting while preserving the correctly reported account or inquiry."],
    ["BT-DM-0011", "BT-ST-0006", "BT-RN-0010", "BT-IN-0011", "BT-BP-0011", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0013", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0014", "BT-ST-0007", "BT-RN-0012", "BT-IN-0009", "BT-BP-0009", "VALIDATED_AUTOMATION", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0018", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "VALIDATED_AUTOMATION", "Remove the duplicate reporting while preserving the correctly reported account or inquiry."],
    ["BT-DM-0019", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "VALIDATED_AUTOMATION", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0028", "BT-ST-0003", "BT-RN-0001", "BT-IN-0001", "BT-BP-0001", "VALIDATED_AUTOMATION", "Correct or remove the inaccurate personal-information entry."],
    ["BT-DM-0029", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0031", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0033", "BT-ST-0010", "BT-RN-0018", "BT-IN-0015", "BT-BP-0015", "VALIDATED_AUTOMATION", DM33_REMEDY],
    ["BT-DM-0034", "BT-ST-0006", "BT-RN-0010", "BT-IN-0011", "BT-BP-0011", "VALIDATED_AUTOMATION", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0036", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0049", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0050", "BT-ST-0016", "BT-RN-0026", "BT-IN-0023", "BT-BP-0016", "NO_ACTION", "No dispute remedy. Preserve the item and document the reason."],
    ["BT-DM-0051", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "REVIEW_DEFAULT", "Delete only when the applicable reporting period can be affirmatively calculated and has expired; otherwise route to review or request verification without alleging obsolescence."],
    ["BT-DM-0052", "BT-ST-0004", "BT-RN-0004", "BT-IN-0004", "BT-BP-0004", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0053", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
    ["BT-DM-0054", "BT-ST-0001", "BT-RN-0022", "BT-IN-0016", "BT-BP-0001", "REVIEW_DEFAULT", "Conduct a reasonable reinvestigation; correct or update inaccurate/incomplete reporting, and delete the item only if it cannot be verified or accurately corrected."],
];

// Resolve a decision's chain the way the pipeline does.
function resolveChain(decisionRecord, strategyId) {
    // selectReason takes an itemStrategy shaped { strategy: { strategy, name }, decisionRecord }
    const reason = selectReason({ strategy: { strategy: strategyId }, decisionRecord });
    const instruction = selectInstruction(reason);
    const blueprint = selectBlueprint(instruction);
    return {
        reason: reason.reason,
        instruction: instruction.instruction,
        blueprint: blueprint.blueprint,
        remedy: remedyFor(strategyId, decisionRecord),
        tier: automationTierFor(decisionRecord),
    };
}

console.log("\n=== EVERY REACHABLE DECISION MATCHES GOVERNANCE ===\n");

for (const [dm, st, rn, inn, bp, tier, remedy] of GOVERNED) {
    const c = resolveChain(dm, st);
    check(`${dm} reason`, c.reason, rn);
    check(`${dm} instruction`, c.instruction, inn);
    check(`${dm} blueprint`, c.blueprint, bp);
    check(`${dm} remedy`, c.remedy, remedy);
    check(`${dm} tier`, c.tier, tier);
}

console.log("\n=== LIVE PATH (BT-DM-0033) RESOLVES TO GOVERNED CHAIN ===\n");
const live = resolveChain("BT-DM-0033", "BT-ST-0010");
check("live reason BT-RN-0018", live.reason, "BT-RN-0018");
check("live instruction BT-IN-0015", live.instruction, "BT-IN-0015");
check("live blueprint BT-BP-0015 (not BT-BP-0010)", live.blueprint, "BT-BP-0015");
check("live tier VALIDATED_AUTOMATION", live.tier, "VALIDATED_AUTOMATION");
check("live remedy is conditional reinvestigation", live.remedy, DM33_REMEDY);
check("live remedy is NOT unconditional deletion", /^Delete this account/.test(live.remedy), false);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
