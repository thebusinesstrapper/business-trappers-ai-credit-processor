/**
 * guardrails.test.js
 * Run: node src/intelligence/guardrails.test.js
 *
 * These test the THREE APPROVED GUARDRAILS. Each one exists to stop the system
 * asserting something it cannot prove:
 *
 *   BT-DM-0051 — obsolescence needs category + readable date + calculable period
 *                + indisputably passed expiry. Anything less is INDETERMINATE.
 *   BT-DM-0053 — a public record with unknown type says NOTHING about lawfulness.
 *   BT-DM-0052 — a stale inquiry is DETECTED, never ASSERTED as unlawful.
 *
 * INDETERMINATE means "we cannot tell", NOT "the item is fine".
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes } from "./decideDisputes.js";
import { COMPLIANCE_GATES } from "./decisionRecords.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(64)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

const ASOF = new Date("2026-07-12T00:00:00Z");
const PI = { names: ["ELIZABETH KELLEY"], ssns: ["123-45-6789"], dates_of_birth: ["1980-04-02"] };

const codes = (item) => item.findings.map((f) => f.code);

function tradelineReport(observation, second = null) {
    return {
        extraction_ok: true,
        reported_personal_information: PI,
        accounts: [{
            stable_account_key: "bt_ac_1",
            bureau_tradelines: [
                { stable_item_key: "bt_tl_a", bureau: "transunion", furnisher: "OLD BANK", masked_account: "****1111", observation },
                ...(second ? [{ stable_item_key: "bt_tl_b", bureau: "equifax", furnisher: "OLD BANK", masked_account: "****1111", observation: second }] : []),
            ],
        }],
        collections: [], inquiries: [], public_records: [],
    };
}

console.log("\n=== BT-DM-0051: obsolescence requires ALL FOUR conditions ===\n");

// Baseline: everything present. Charge-off, DOFD 2015, uncontested. Obsolete.
const clean = await analyzeCreditReport(tradelineReport({
    status: "Charge-off", balance: 1000, past_due: 0, responsibility: "Individual",
    date_opened: "2013-01-01", date_of_first_delinquency: "2015-01-01",
}), { asOf: ASOF });

check("all four conditions met -> obsolescence asserted", codes(clean.tradelines[0]).includes("TL_BEYOND_REPORTING_PERIOD"), true);

// (a) NO CONTROLLING DATE.
const noDofd = await analyzeCreditReport(tradelineReport({
    status: "Charge-off", balance: 1000, past_due: 0, responsibility: "Individual",
    date_opened: "2013-01-01", date_of_first_delinquency: null,
}), { asOf: ASOF });

check("no DOFD -> NO obsolescence claim", codes(noDofd.tradelines[0]).includes("TL_BEYOND_REPORTING_PERIOD"), false);
check("...INDETERMINATE instead", codes(noDofd.tradelines[0]).includes("TL_OBSOLESCENCE_INDETERMINATE"), true);
check("...and the item is NOT silently dropped", noDofd.tradelines[0].findings.length > 0, true);

// (b) CATEGORY NOT IDENTIFIABLE.
const vagueStatus = await analyzeCreditReport(tradelineReport({
    status: "Derogatory", balance: 1000, past_due: 500, responsibility: "Individual",
    date_opened: "2013-01-01", date_of_first_delinquency: "2015-01-01",
}), { asOf: ASOF });

check("unrecognised category -> NO obsolescence claim", codes(vagueStatus.tradelines[0]).includes("TL_BEYOND_REPORTING_PERIOD"), false);
check("...INDETERMINATE instead", codes(vagueStatus.tradelines[0]).includes("TL_OBSOLESCENCE_INDETERMINATE"), true);

// (c) DATE CONTESTED ACROSS BUREAUS. This is the one that matters most: we would
//     be asserting an expiry from a date we dispute elsewhere in the same letter.
const contested = await analyzeCreditReport(tradelineReport(
    { status: "Charge-off", balance: 1000, past_due: 0, responsibility: "Individual", date_opened: "2013-01-01", date_of_first_delinquency: "2015-01-01" },
    { status: "Charge-off", balance: 1000, past_due: 0, responsibility: "Individual", date_opened: "2013-01-01", date_of_first_delinquency: "2021-06-01" }
), { asOf: ASOF });

const tuContested = contested.tradelines.find((t) => t.stableItemKey === "bt_tl_a");

check("DOFD disputed across bureaus -> NO obsolescence claim", codes(tuContested).includes("TL_BEYOND_REPORTING_PERIOD"), false);
check("...INDETERMINATE instead", codes(tuContested).includes("TL_OBSOLESCENCE_INDETERMINATE"), true);
check("...the DOFD conflict IS still disputed", codes(tuContested).includes("TL_XB_DOFD_INCONSISTENT"), true);

// (d) EXPIRY NOT INDISPUTABLY PASSED (the 180-day grace).
const notYet = await analyzeCreditReport(tradelineReport({
    status: "Charge-off", balance: 1000, past_due: 0, responsibility: "Individual",
    date_opened: "2017-01-01", date_of_first_delinquency: "2019-04-01", // ~7.3y
}), { asOf: ASOF });

check("7.3 years -> not yet obsolete (§605(c) grace)", codes(notYet.tradelines[0]).includes("TL_BEYOND_REPORTING_PERIOD"), false);

console.log("\n--- INDETERMINATE routes to a human, and asserts nothing ---");

const noDofdDecision = await decideDisputes(noDofd, { report: tradelineReport({
    status: "Charge-off", balance: 1000, past_due: 0, responsibility: "Individual",
    date_opened: "2013-01-01", date_of_first_delinquency: null,
}) });

const d = noDofdDecision.itemDecisions.find((x) => x.stableItemKey === "bt_tl_a");

// The Metro 2 defect (derogatory with no DOFD) IS still self-evident and disputable.
check("the Metro 2 defect is still raised", d.decisionRecords.some((r) => r.record === "BT-DM-0033"), true);
check("...and BT-DM-0051 is present but INDETERMINATE", d.decisionRecords.find((r) => r.record === "BT-DM-0051")?.evidenceClass, "INDETERMINATE");

console.log("\n=== BT-DM-0053: unknown record type asserts NOTHING ===\n");

const prReport = {
    extraction_ok: true,
    reported_personal_information: PI,
    accounts: [], collections: [], inquiries: [],
    public_records: [{
        stable_account_key: "bt_pr_1",
        record_type: null, // UNKNOWN
        bureau_tradelines: [{
            stable_item_key: "bt_pr_tu", bureau: "transunion",
            observation: { filing_date: "2014-01-01" },
        }],
    }],
};

const prAnalysis = await analyzeCreditReport(prReport, { asOf: ASOF });
const pr = prAnalysis.publicRecords[0];

check("unknown type flagged", codes(pr).includes("PR_RECORD_TYPE_UNKNOWN"), true);
check("...NO obsolescence claimed despite a 12-year-old date", codes(pr).includes("PR_BEYOND_REPORTING_PERIOD"), false);
check("...INDETERMINATE instead", codes(pr).includes("PR_OBSOLESCENCE_INDETERMINATE"), true);

const prDecision = await decideDisputes(prAnalysis, { report: prReport });
const prD = prDecision.itemDecisions.find((x) => x.stableItemKey === "bt_pr_tu");

check("routed to human review", prD.humanReview, true);
check("...evidence INDETERMINATE", prD.evidenceClass, "INDETERMINATE");

// A KNOWN bankruptcy at 12 years IS obsolete (10-year period).
const bk = JSON.parse(JSON.stringify(prReport));
bk.public_records[0].record_type = "Chapter 7 Bankruptcy";
const bkAnalysis = await analyzeCreditReport(bk, { asOf: ASOF });

check("known Ch.7 at 12y -> obsolete (10y period)", codes(bkAnalysis.publicRecords[0]).includes("PR_BEYOND_REPORTING_PERIOD"), true);

// A KNOWN bankruptcy at 8 years is NOT obsolete.
const bk8 = JSON.parse(JSON.stringify(bk));
bk8.public_records[0].bureau_tradelines[0].observation.filing_date = "2018-06-01"; // ~8.1y
const bk8Analysis = await analyzeCreditReport(bk8, { asOf: ASOF });

check("known Ch.7 at 8y -> NOT obsolete (would be a false claim)", codes(bk8Analysis.publicRecords[0]).includes("PR_BEYOND_REPORTING_PERIOD"), false);

console.log("\n=== BT-DM-0052: stale inquiry is DETECTED, never ASSERTED ===\n");

const inqReport = {
    extraction_ok: true,
    reported_personal_information: PI,
    accounts: [], collections: [], public_records: [],
    inquiries: [{ stable_item_key: "bt_iq_old", bureau: "equifax", furnisher: "OLD LENDER", inquiry_date: "2023-01-01" }],
};

const inqAnalysis = await analyzeCreditReport(inqReport, { asOf: ASOF });
const inqDecision = await decideDisputes(inqAnalysis, { report: inqReport });
const iq = inqDecision.itemDecisions.find((x) => x.stableItemKey === "bt_iq_old");

check("stale inquiry detected", codes(inqAnalysis.inquiries[0]).includes("INQ_BEYOND_REPORTING_PERIOD"), true);
check("governed by BT-DM-0052", iq.decisionRecords.some((r) => r.record === "BT-DM-0052"), true);
check("COMPLIANCE GATE attached", iq.complianceGates.length, 1);
check("...gate is blocking", iq.complianceGates[0].blocked, true);
check("...override applied", iq.appliedOverrides.includes("COMPLIANCE_GATED"), true);
check("...never automated", iq.humanReview, true);
check("...tier is human review", iq.automationTier, "HUMAN_REVIEW_REQUIRED");

const gate = COMPLIANCE_GATES["BT-DM-0052"];
check("forbids asserting illegality", gate.forbiddenAssertions.some((a) => /unlawful/i.test(a)), true);
check("forbids asserting required deletion", gate.forbiddenAssertions.some((a) => /deletion is legally required/i.test(a)), true);
check("permits stating the AGE (a fact)", gate.permittedAssertions.some((a) => /more than two years old/i.test(a)), true);

console.log("\n=== The gate travels with the item, and outranks a reviewer ===\n");
console.log(`  BT-DM-0052 gate: ${gate.reason}`);
console.log(`  Cleared by: ${gate.clearedBy}`);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
