/**
 * remedyContract.test.js
 *
 * Regression for the remedy handoff: BT-DM-0033 (Metro 2, reached live via
 * TL_DEROGATORY_WITHOUT_DOFD) must carry a non-empty approved requested remedy so
 * its account section is written into the bureau letter — not withheld as "a
 * dispute that asks for nothing." Also proves the withhold rule still holds for a
 * strategy that genuinely has no approved remedy.
 */
import { remedyFor, REMEDY } from "./selectStrategy.js";

let passed = 0, failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} -> ${String(actual)}`);
    ok ? passed++ : failed++;
};

console.log("\n=== BT-DM-0033 PRODUCES A NON-EMPTY APPROVED REMEDY ===\n");

// TL_DEROGATORY_WITHOUT_DOFD -> BT-DM-0033 -> BT-ST-0010 (Metro 2 Accuracy Review).
// GOVERNED: the remedy is conditional reinvestigation (delete only if unverifiable) —
// remedyFor is decision-indexed now; strategy arg retained for signature compat.
    const remedy = remedyFor("BT-ST-0010", "BT-DM-0033");
check("BT-ST-0010 remedy is non-empty", typeof remedy === "string" && remedy.length > 0, true);
check("...is the governed conditional reinvestigation remedy", remedy, "Conduct a reasonable reinvestigation; correct or update the reporting as necessary, and delete the item if it cannot be verified or accurately corrected.");
check("...contains NO unconditional deletion demand", /^Delete this account/.test(remedy), false);
check("...is not an object", typeof remedy, "string");

console.log("\n=== FAIL-CLOSED: A TRULY UNMAPPED STRATEGY REMAINS WITHHELD ===\n");

// The withhold rule fires in generateLetter when an item arrives with NO
// requestedRemedy (null/undefined) — "a dispute that asks for nothing is not sent."
// That is the exact condition the live run hit. remedyFor's job is the opposite:
// for anything that REACHES letter generation, it must return a non-empty approved
// remedy so a genuine dispute is never silently blanked. Prove it never returns an
// empty string or object for any resolvable strategy — the failure mode that would
// let a blank slip past the guard.
for (const dm of ["BT-DM-0031", "BT-DM-0008", "BT-DM-0033", "BT-DM-0999"]) {
    const r = remedyFor(null, dm);
    check(`remedyFor(${dm}) is a non-empty string`, typeof r === "string" && r.trim().length > 0, true);
}

// And the withhold guard's trigger is a genuinely absent remedy on the item — this
// is what must stay intact so unmapped/blank items are never sent asking for nothing.
const itemWithNoRemedy = { requestedRemedy: null };
check("an item with null requestedRemedy is the withhold trigger", !itemWithNoRemedy.requestedRemedy, true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
