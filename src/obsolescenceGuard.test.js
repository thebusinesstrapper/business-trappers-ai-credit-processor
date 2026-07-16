/**
 * obsolescenceGuard.test.js
 *
 * BT-DM-0051 governed rule: deletion is permitted ONLY when the applicable
 * reporting period can be affirmatively calculated and has expired. When the
 * period is indeterminate, the system must NOT demand deletion and must NOT
 * allege obsolescence — it routes to review or verification.
 *
 * This proves the remedy contract for BT-DM-0051 is the governed conditional
 * (period-gated) remedy, never an unconditional deletion demand.
 */
import { remedyFor } from "./selectStrategy.js";

let passed = 0, failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) console.log(`FAIL  ${label.padEnd(52)} got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
    ok ? passed++ : failed++;
};

console.log("\n=== BT-DM-0051 OBSOLESCENCE REMEDY IS PERIOD-GATED ===\n");

const remedy = remedyFor("BT-ST-0001", "BT-DM-0051");

// The governed remedy permits deletion only on affirmatively calculated + expired period.
check("remedy is the governed period-gated remedy",
    remedy,
    "Delete only when the applicable reporting period can be affirmatively calculated and has expired; otherwise route to review or request verification without alleging obsolescence.");

// It must NOT be an unconditional deletion demand.
check("no unconditional 'Delete this account' demand", /^Delete this account/.test(remedy), false);

// It must explicitly gate deletion on a calculable, expired period.
check("gates deletion on calculable expired period", /affirmatively calculated and has expired/.test(remedy), true);

// It must forbid alleging obsolescence when indeterminate.
check("forbids alleging obsolescence when indeterminate", /without alleging obsolescence/.test(remedy), true);

// It must route indeterminate to review/verification rather than deletion.
check("routes indeterminate to review or verification", /route to review or request verification/.test(remedy), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
