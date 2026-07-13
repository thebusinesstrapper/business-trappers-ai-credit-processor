/**
 * spikeIdentifiers.test.js
 *
 * The analyzer decides which identifiers we may trust with dispute history.
 * A wrong verdict here corrupts AI Memory silently and irreversibly, so the
 * logic is proven against payloads whose correct answer we already know —
 * before it is ever pointed at a live report.
 *
 * Run: node src/spikeIdentifiers.test.js
 */

import {
    extractTradelineRecords,
    validationKey,
    analyzeIdentifiers,
} from "./spikeIdentifiers.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    const ok = actual === expected;
    ok ? passed++ : failed++;
    console.log(
        `${ok ? "PASS" : "FAIL"}  ${name.padEnd(62)} -> ${actual}${ok ? "" : `\n      expected: ${expected}`}`
    );
}

/**
 * Build a ListAndStack-shaped record: ONE account, THREE stacked bureau rows.
 *
 * arrayId    — same across bureaus and across time (a true entity id)
 * simpleHash — same across bureaus, same across time
 * complexHash— DIFFERENT every report (it hashes balance/status: a change hash)
 * liabilityId— document-local sequential; REUSED for different accounts
 */
function stack({ creditor, acct, opened, arrayId, simpleHash, complexHash, liabilityIds }) {
    const bureaus = ["TransUnion", "Experian", "Equifax"];

    return bureaus.map((bureau, i) => ({
        "@CreditRepositorySourceType": bureau,
        "@ArrayAccountIdentifier": arrayId,
        "@TradelineHashSimple": simpleHash,
        "@TradelineHashComplex": complexHash[i],
        "@CreditLiabilityID": liabilityIds[i],
        "_CREDITOR": { "@_FullName": creditor },
        "@_AccountIdentifier": acct,
        "@_AccountType": "Revolving",
        "@_AccountOpenedDate": opened,
    }));
}

// ---- Report 1 (June) -------------------------------------------------------
const june = {
    CREDIT_LIABILITIES: [
        ...stack({
            creditor: "CHASE BANK USA NA",
            acct: "411111******1234",
            opened: "2019-03-14",
            arrayId: "arr_aaa",
            simpleHash: "simple_aaa",
            complexHash: ["cx_j1", "cx_j2", "cx_j3"],
            liabilityIds: ["CL_001", "CL_002", "CL_003"],
        }),
        ...stack({
            creditor: "CAPITAL ONE",
            acct: "517805******9999",
            opened: "2021-07-01",
            arrayId: "arr_bbb",
            simpleHash: "simple_bbb",
            complexHash: ["cx_j4", "cx_j5", "cx_j6"],
            liabilityIds: ["CL_004", "CL_005", "CL_006"],
        }),
    ],
};

// ---- Report 2 (July) -------------------------------------------------------
// Same two accounts. Balances moved, so the COMPLEX hash regenerated.
// A new account appeared FIRST in the list, shifting every CreditLiabilityID —
// so CL_001 now refers to a DIFFERENT account than it did in June.
const july = {
    CREDIT_LIABILITIES: [
        ...stack({
            creditor: "DISCOVER",
            acct: "601100******5555",
            opened: "2026-06-02",
            arrayId: "arr_ccc",
            simpleHash: "simple_ccc",
            complexHash: ["cx_k1", "cx_k2", "cx_k3"],
            liabilityIds: ["CL_001", "CL_002", "CL_003"], // <-- REUSED IDs
        }),
        ...stack({
            creditor: "CHASE BANK USA NA",
            acct: "411111******1234",
            opened: "2019-03-14",
            arrayId: "arr_aaa",          // stable
            simpleHash: "simple_aaa",    // stable
            complexHash: ["cx_k4", "cx_k5", "cx_k6"], // REGENERATED
            liabilityIds: ["CL_004", "CL_005", "CL_006"], // shifted
        }),
        ...stack({
            creditor: "CAPITAL ONE",
            acct: "517805******9999",
            opened: "2021-07-01",
            arrayId: "arr_bbb",
            simpleHash: "simple_bbb",
            complexHash: ["cx_k7", "cx_k8", "cx_k9"],
            liabilityIds: ["CL_007", "CL_008", "CL_009"],
        }),
    ],
};

console.log("\n=== Extraction ===\n");

const juneRecords = extractTradelineRecords(june);
const julyRecords = extractTradelineRecords(july);

check("June: 2 accounts x 3 bureaus = 6 records", juneRecords.length, 6);
check("July: 3 accounts x 3 bureaus = 9 records", julyRecords.length, 9);
check("bureau attribution resolved", juneRecords[0].bureau, "transunion");
check("ArrayAccountIdentifier extracted", juneRecords[0].identifiers.ArrayAccountIdentifier, "arr_aaa");

const vk0 = validationKey(juneRecords[0]);
const vk1 = validationKey(juneRecords[1]);

// NOTE: asserting non-null FIRST. A previous version of this test compared
// vk0 === vk1 and passed while both were null — a test that passed precisely
// because extraction was broken. Never assert equality without asserting
// existence.
check("validation key is derived (not null)", vk0 !== null, true);
check("validation key groups the same account", vk0 !== null && vk0 === vk1, true);

console.log("\n=== Analysis ===\n");

const analysis = analyzeIdentifiers([
    { report_date: "2026-06-10", records: juneRecords },
    { report_date: "2026-07-10", records: julyRecords },
]);

const ids = analysis.identifiers;

console.log("--- ArrayAccountIdentifier (expected: the good one) ---");
check("  cross-time", ids.ArrayAccountIdentifier.cross_time.verdict.split(" ")[0], "STABLE");
check("  cross-bureau", ids.ArrayAccountIdentifier.cross_bureau.verdict.split(" ")[0], "GROUPS");
check("  collisions", ids.ArrayAccountIdentifier.collisions.length, 0);

console.log("\n--- TradelineHashSimple (expected: stable) ---");
check("  cross-time", ids.TradelineHashSimple.cross_time.verdict.split(" ")[0], "STABLE");
check("  cross-bureau", ids.TradelineHashSimple.cross_bureau.verdict.split(" ")[0], "GROUPS");

console.log("\n--- TradelineHashComplex (expected: REGENERATED — the trap) ---");
check("  cross-time", ids.TradelineHashComplex.cross_time.verdict.split(" ")[0], "REGENERATED");
check(
    "  per-bureau (does not group)",
    ids.TradelineHashComplex.cross_bureau.verdict.split(" ")[0],
    "PER-BUREAU"
);

console.log("\n--- CreditLiabilityID (expected: collides — document-local) ---");
check(
    "  COLLIDES across accounts",
    ids.CreditLiabilityID.collisions.length > 0,
    true
);
check("  cross-time", ids.CreditLiabilityID.cross_time.verdict.split(" ")[0], "REGENERATED");

console.log("\n=== Recommendation ===\n");

const rec = analysis.recommendation;
const proposedIds = rec.proposed_tiers.map((t) => t.identifier);
const rejectedIds = rec.rejected.map((r) => r.identifier);

check("proposes ArrayAccountIdentifier", proposedIds.includes("ArrayAccountIdentifier"), true);
check("proposes TradelineHashSimple", proposedIds.includes("TradelineHashSimple"), true);
check("REJECTS TradelineHashComplex", rejectedIds.includes("TradelineHashComplex"), true);
check("REJECTS CreditLiabilityID", rejectedIds.includes("CreditLiabilityID"), true);

console.log("\n=== The trap: a complex hash that HAPPENS to look stable ===\n");

// Nothing changed between reports, so the change-hash coincidentally matches.
// The frozen ruling must reject it ANYWAY — stability by coincidence is not
// stability by design.
const quietJuly = JSON.parse(JSON.stringify(june));
const quiet = analyzeIdentifiers([
    { report_date: "2026-06-10", records: extractTradelineRecords(june) },
    { report_date: "2026-07-10", records: extractTradelineRecords(quietJuly) },
]);

check(
    "  complex hash LOOKS stable here",
    quiet.identifiers.TradelineHashComplex.cross_time.verdict.split(" ")[0],
    "STABLE"
);
check(
    "  ...and is STILL rejected (frozen ruling overrides evidence)",
    quiet.recommendation.rejected.map((r) => r.identifier).includes("TradelineHashComplex"),
    true
);

console.log(`\n${passed} passed, ${failed} failed.\n`);

if (failed > 0) process.exit(1);
