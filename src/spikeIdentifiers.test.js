/**
 * spikeIdentifiers.test.js
 *
 * Run: node src/spikeIdentifiers.test.js
 *
 * The analyzer decides which identifiers may be trusted with dispute history.
 * A wrong verdict corrupts AI Memory silently and irreversibly, so the logic is
 * proven against payloads whose correct answer we already know.
 *
 * THE CENTRAL TEST IS THE FALSE-COLLISION CASE. The previous analyzer keyed
 * accounts on the furnisher name, so it saw "NAVY FEDERAL CR UNION | 6095" and
 * "NAVY FCU | 6095" as DIFFERENT accounts -- and therefore flagged an identifier
 * that CORRECTLY grouped them as COLLIDING. The better the identifier, the more
 * likely it was rejected. That must never happen again.
 */

import {
    extractTradelineRecords,
    clusterIntoAccounts,
    sameAccount,
    demonstrablyDifferentAccounts,
    analyzeIdentifiers,
} from "./spikeIdentifiers.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    const ok = actual === expected;
    ok ? passed++ : failed++;
    console.log(
        `${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} -> ${actual}${ok ? "" : `\n      expected: ${expected}`}`
    );
}

/**
 * ONE underlying account, THREE bureau tradelines -- each with that bureau's own
 * furnisher name and masking format, exactly as ListAndStack delivers it.
 */
function account({ names, acct, opened, accountId, simple, complex, liabilityIds }) {
    const bureaus = ["TransUnion", "Experian", "Equifax"];

    return bureaus.map((bureau, i) => ({
        "@CreditRepositorySourceType": bureau,
        "@ArrayAccountIdentifier": accountId,
        "@TradelineHashSimple": simple[i],
        "@TradelineHashComplex": complex[i],
        "@CreditLiabilityID": liabilityIds[i],
        "_CREDITOR": { "@_FullName": names[i] },
        "@_AccountIdentifier": acct[i],
        "@_AccountType": "Revolving",
        "@_AccountOpenedDate": opened,
    }));
}

// THE REAL-WORLD CASE. One Navy Federal account. Three bureau namings.
const NAVY = {
    names: ["NAVY FEDERAL CR UNION", "NAVY FCU", "NAVY FEDERAL CREDIT UNION"],
    acct: ["****6095", "6095XXXXXXXX", "XXXX6095"],
    opened: "2019-03-14",
};

const CAPONE = {
    names: ["CAPITAL ONE", "CAP ONE", "CAPITAL ONE BANK USA NA"],
    acct: ["****9999", "9999XXXXXXXX", "XXXX9999"],
    opened: "2021-07-01",
};

const june = {
    LIABILITIES: [
        ...account({
            ...NAVY,
            accountId: "arr_navy",
            simple: ["tl_navy_tu", "tl_navy_exp", "tl_navy_eqf"], // per-bureau
            complex: ["cx_j1", "cx_j2", "cx_j3"],
            liabilityIds: ["CL_001", "CL_002", "CL_003"],
        }),
        ...account({
            ...CAPONE,
            accountId: "arr_cap1",
            simple: ["tl_cap1_tu", "tl_cap1_exp", "tl_cap1_eqf"],
            complex: ["cx_j4", "cx_j5", "cx_j6"],
            liabilityIds: ["CL_004", "CL_005", "CL_006"],
        }),
    ],
};

// July: same two accounts. Balances moved -> complex hash regenerated.
// A NEW account appears first, shifting every CreditLiabilityID -- so CL_001
// now names a DIFFERENT account than it did in June.
const july = {
    LIABILITIES: [
        ...account({
            names: ["DISCOVER BANK", "DISCOVER", "DISCOVER FIN SVCS"],
            acct: ["****5555", "5555XXXXXXXX", "XXXX5555"],
            opened: "2026-06-02",
            accountId: "arr_disc",
            simple: ["tl_disc_tu", "tl_disc_exp", "tl_disc_eqf"],
            complex: ["cx_k1", "cx_k2", "cx_k3"],
            liabilityIds: ["CL_001", "CL_002", "CL_003"], // <-- REUSED
        }),
        ...account({
            ...NAVY,
            accountId: "arr_navy",                                // stable
            simple: ["tl_navy_tu", "tl_navy_exp", "tl_navy_eqf"], // stable
            complex: ["cx_k4", "cx_k5", "cx_k6"],                 // REGENERATED
            liabilityIds: ["CL_004", "CL_005", "CL_006"],         // shifted
        }),
        ...account({
            ...CAPONE,
            accountId: "arr_cap1",
            simple: ["tl_cap1_tu", "tl_cap1_exp", "tl_cap1_eqf"],
            complex: ["cx_k7", "cx_k8", "cx_k9"],
            liabilityIds: ["CL_007", "CL_008", "CL_009"],
        }),
    ],
};

const juneRecords = extractTradelineRecords(june);
const julyRecords = extractTradelineRecords(july);

console.log("\n=== Extraction: bureau tradelines stay INDEPENDENT ===\n");

check("June: 2 accounts x 3 bureaus = 6 bureau tradelines", juneRecords.length, 6);
check("July: 3 accounts x 3 bureaus = 9 bureau tradelines", julyRecords.length, 9);
check("bureau attributed", juneRecords[0].bureau, "transunion");
check("furnisher preserved per bureau (TU)", juneRecords[0].validation.creditor, "NAVY FEDERAL CR UNION");
check("furnisher preserved per bureau (EXP)", juneRecords[1].validation.creditor, "NAVY FCU");
check("masking preserved per bureau (EXP)", juneRecords[1].validation.account_number, "6095XXXXXXXX");
check("bureau-invariant evidence derived", juneRecords[1].evidence.last4, "6095");

console.log("\n=== THE NAVY FEDERAL CASE: names differ, account is the SAME ===\n");

const tu = juneRecords[0];  // NAVY FEDERAL CR UNION | ****6095
const exp = juneRecords[1]; // NAVY FCU              | 6095XXXXXXXX

check("NOT demonstrably different (names differ, digits agree)", demonstrablyDifferentAccounts(tu, exp), false);
check("sameAccount() joins them", sameAccount(tu, exp), true);

const juneAccounts = clusterIntoAccounts(juneRecords);

check("June clusters to 2 underlying accounts (not 6)", juneAccounts.size, 2);
check("July clusters to 3 underlying accounts (not 9)", clusterIntoAccounts(julyRecords).size, 3);

const navyCluster = [...juneAccounts.values()].find((g) => g.some((r) => r.evidence.last4 === "6095"));
check("Navy account holds all 3 bureau tradelines", navyCluster.length, 3);

console.log("\n=== Different trailing digits ARE demonstrably different ===\n");

const capOne = juneRecords[3];

check("Navy vs Capital One -> demonstrably different", demonstrablyDifferentAccounts(tu, capOne), true);
check("...and are not clustered together", sameAccount(tu, capOne), false);

console.log("\n=== Analysis across two DISTINCT report dates ===\n");

const analysis = analyzeIdentifiers([
    { report_date: "2026-06-10", records: juneRecords },
    { report_date: "2026-07-10", records: julyRecords },
]);

check("two distinct reports recognised", analysis.two_distinct_reports_captured, true);
check("recommendation issued", analysis.recommendation.status, "PROPOSED");

const ids = analysis.identifiers;

console.log("\n--- ArrayAccountIdentifier: expect GROUPS + STABLE + NO collision ---");
check("  cross-bureau", ids.ArrayAccountIdentifier.cross_bureau_correlation.verdict.split(" ")[0], "GROUPS");
check("  cross-time", ids.ArrayAccountIdentifier.cross_time_stability.verdict.split(" ")[0], "STABLE");
check("  NO false collision (THE OLD BUG)", ids.ArrayAccountIdentifier.collisions.length, 0);

console.log("\n--- TradelineHashSimple: expect PER-BUREAU + STABLE ---");
check("  cross-bureau", ids.TradelineHashSimple.cross_bureau_correlation.verdict.split(" ")[0], "PER-BUREAU");
check("  cross-time", ids.TradelineHashSimple.cross_time_stability.verdict.split(" ")[0], "STABLE");
check("  no collisions", ids.TradelineHashSimple.collisions.length, 0);

console.log("\n--- TradelineHashComplex: expect REGENERATED ---");
check("  cross-time", ids.TradelineHashComplex.cross_time_stability.verdict.split(" ")[0], "REGENERATED");

console.log("\n--- CreditLiabilityID: expect TRUE collision (CL_001 reused) ---");
check("  TRUE collision detected", ids.CreditLiabilityID.collisions.length > 0, true);
check(
    "  proven by digits, not by naming",
    ids.CreditLiabilityID.collisions[0].proof,
    "different masked account trailing digits"
);

console.log("\n=== Recommendation: TWO separate tier lists ===\n");

const rec = analysis.recommendation;
const grouping = rec.account_grouping_tiers.map((t) => t.identifier);
const tradeline = rec.tradeline_identity_tiers.map((t) => t.identifier);
const rejected = rec.rejected.map((r) => r.identifier);

check("ArrayAccountIdentifier -> ACCOUNT GROUPING tier", grouping.includes("ArrayAccountIdentifier"), true);
check("TradelineHashSimple -> TRADELINE IDENTITY tier", tradeline.includes("TradelineHashSimple"), true);
check("TradelineHashComplex REJECTED", rejected.includes("TradelineHashComplex"), true);
check("CreditLiabilityID REJECTED", rejected.includes("CreditLiabilityID"), true);

console.log("\n=== Gate: no recommendation without two distinct dates ===\n");

const single = analyzeIdentifiers([{ report_date: "2026-06-10", records: juneRecords }]);

check("single report -> WITHHELD", single.recommendation.status, "WITHHELD");
check(
    "single report -> cross-time NOT EVALUATED",
    single.identifiers.ArrayAccountIdentifier.cross_time_stability.verdict.split(" ")[0],
    "NOT"
);

// The same report captured twice under the SAME date: every identifier would
// trivially "match itself" and look STABLE. That is an artefact, not evidence.
const duped = analyzeIdentifiers([
    { report_date: "2026-06-10", records: juneRecords },
    { report_date: "2026-06-10", records: juneRecords },
]);

check("same date twice -> still WITHHELD", duped.recommendation.status, "WITHHELD");

console.log("\n=== Frozen ruling overrides evidence ===\n");

// Nothing changed between reports, so the change-hash coincidentally matches.
const quiet = analyzeIdentifiers([
    { report_date: "2026-06-10", records: juneRecords },
    { report_date: "2026-07-10", records: extractTradelineRecords(JSON.parse(JSON.stringify(june))) },
]);

check(
    "complex hash LOOKS stable in a quiet month",
    quiet.identifiers.TradelineHashComplex.cross_time_stability.verdict.split(" ")[0],
    "STABLE"
);
check(
    "...and is STILL rejected",
    quiet.recommendation.rejected.map((r) => r.identifier).includes("TradelineHashComplex"),
    true
);

console.log(`\n${passed} passed, ${failed} failed.\n`);

if (failed > 0) process.exit(1);
