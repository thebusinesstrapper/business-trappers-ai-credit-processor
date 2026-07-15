import { getCode, FINDING_CODES, LEVEL, SEVERITY, REQUIRES } from "./findingCodes.js";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
    const ok = actual === expected;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} -> ${String(actual)}`);
    ok ? passed++ : failed++;
}

console.log("\n=== OBSOLESCENCE-INDETERMINATE CODES ARE REGISTERED ===\n");

// The live crash: analyzeCreditReport emits TL_OBSOLESCENCE_INDETERMINATE when a
// derogatory item MIGHT be obsolete but the controlling date is missing/unreadable/
// disputed — "we cannot tell," not "it is fine." getCode() must accept it.
check("getCode accepts TL_OBSOLESCENCE_INDETERMINATE",
    getCode("TL_OBSOLESCENCE_INDETERMINATE")?.level, LEVEL.ITEM);
check("...severity MEDIUM", getCode("TL_OBSOLESCENCE_INDETERMINATE").severity, SEVERITY.MEDIUM);
check("...decidable from this report alone", getCode("TL_OBSOLESCENCE_INDETERMINATE").requires, REQUIRES.REPORT_ONLY);
check("...has a summary", typeof getCode("TL_OBSOLESCENCE_INDETERMINATE").summary === "string", true);

// The public-record sibling is emitted by the same engine (line 909) and would
// crash identically on the next report with an indeterminate public record.
check("getCode accepts PR_OBSOLESCENCE_INDETERMINATE",
    getCode("PR_OBSOLESCENCE_INDETERMINATE")?.level, LEVEL.ITEM);

console.log("\n=== THE REGISTRY STILL FAILS CLOSED ON UNKNOWN CODES ===\n");

// The guardrail must remain: a genuinely unknown code throws at the source, so a
// typo cannot flow downstream as a finding no engine can handle.
let threw = false;
try {
    getCode("TL_DEFINITELY_NOT_A_REAL_CODE");
} catch (e) {
    threw = /Unknown finding code/.test(e.message);
}
check("unknown code still throws", threw, true);

console.log("\n=== EVERY CODE analyzeCreditReport EMITS IS REGISTERED ===\n");

// Guard against a future emitter/registry drift for the two codes at issue.
for (const code of ["TL_OBSOLESCENCE_INDETERMINATE", "PR_OBSOLESCENCE_INDETERMINATE"]) {
    check(`${code} present in FINDING_CODES`, code in FINDING_CODES, true);
}

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
