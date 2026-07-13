/**
 * analyzeCreditReport.test.js
 *
 * Run: node src/intelligence/analyzeCreditReport.test.js
 *
 * The Analysis Engine's output becomes the factual basis for letters written in
 * the CONSUMER'S VOICE. A fabricated finding becomes a false assertion to a
 * bureau. So the tests here check two things with equal weight:
 *
 *   1. That real findings ARE detected.
 *   2. That findings we CANNOT support are NOT emitted.
 *
 * The second is the one that protects the client.
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { FINDING_CODES } from "./findingCodes.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    const ok = actual === expected;
    ok ? passed++ : failed++;
    console.log(
        `${ok ? "PASS" : "FAIL"}  ${name.padEnd(66)} -> ${actual}${ok ? "" : `\n      expected: ${expected}`}`
    );
}

const ASOF = new Date("2026-07-12T00:00:00Z");

function codesFor(result, itemKey) {
    const item = [...result.tradelines, ...result.collections, ...result.inquiries, ...result.publicRecords].find(
        (i) => i.stableItemKey === itemKey
    );
    return item ? item.findings.map((f) => f.code) : [];
}

// ---------------------------------------------------------------------------
// One account. TransUnion says charge-off; Experian says current.
// Same account. Different bureaus. Independent legal objects.
// ---------------------------------------------------------------------------

const report = {
    extraction_ok: true,
    crc_client_id: 15,
    report_date: "2026-07-10",
    model_version: "BT-CRM-1.0",

    reported_personal_information: {
        names: ["ELIZABETH KELLEY", "LIZ KELLEY"],
        ssns: ["123-45-6789", "987-65-4321"], // TWO SSNs -> mixed file
        dates_of_birth: ["1980-04-02"],
        employers_by_bureau: {},
    },

    accounts: [
        {
            stable_account_key: "bt_ac_navy",
            account_type: "Revolving",
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_navy_tu",
                    bureau: "transunion",
                    furnisher: "NAVY FEDERAL CR UNION",
                    masked_account: "****6095",
                    observation: {
                        status: "Charge-off",
                        balance: 4200,
                        past_due: 4200,
                        date_opened: "2019-03-14",
                        date_of_first_delinquency: "2023-01-15",
                    },
                },
                {
                    stable_item_key: "bt_tl_navy_exp",
                    bureau: "experian",
                    furnisher: "NAVY FCU",
                    masked_account: "6095XXXXXXXX",
                    observation: {
                        status: "Current",
                        balance: 4200,
                        past_due: 0,
                        date_opened: "2019-03-14",
                        date_of_first_delinquency: null,
                    },
                },
                // Equifax does not report this account at all.
            ],
        },
        {
            // Internal Metro 2 contradiction: past due on a zero balance,
            // and derogatory with no DOFD.
            stable_account_key: "bt_ac_broken",
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_broken_eqf",
                    bureau: "equifax",
                    furnisher: "SOME BANK",
                    masked_account: "****1111",
                    observation: {
                        status: "Charge-off",
                        balance: 0,
                        past_due: 900,
                        date_opened: "2015-01-10",
                        date_of_first_delinquency: null,
                    },
                },
            ],
        },
    ],

    collections: [
        {
            stable_account_key: "bt_ac_coll",
            original_creditor: null, // missing
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_coll_tu",
                    bureau: "transunion",
                    furnisher: "MIDLAND CREDIT",
                    observation: { status: "Collection", balance: 1500, date_of_first_delinquency: "2016-02-01" },
                },
            ],
        },
    ],

    inquiries: [
        {
            stable_item_key: "bt_iq_1",
            bureau: "experian",
            furnisher: "CAPITAL ONE",
            inquiry_date: "2026-06-01",
        },
        {
            stable_item_key: "bt_iq_old",
            bureau: "equifax",
            furnisher: "OLD LENDER",
            inquiry_date: "2023-01-01", // > 2 years
        },
    ],

    public_records: [],
};

console.log("\n=== Facts detected ===\n");

const result = await analyzeCreditReport(report, { asOf: ASOF });

check("analysisOk", result.analysisOk, true);
check("bureau tradelines analyzed", result.tradelines.length, 3);

console.log("\n--- Cross-bureau: EMITTED PER BUREAU, never flattened ---");

const tuCodes = codesFor(result, "bt_tl_navy_tu");
const expCodes = codesFor(result, "bt_tl_navy_exp");

check("TU gets its own status-inconsistency finding", tuCodes.includes("TL_XB_STATUS_INCONSISTENT"), true);
check("EXP gets its OWN status-inconsistency finding", expCodes.includes("TL_XB_STATUS_INCONSISTENT"), true);
check("TU gets DOFD inconsistency", tuCodes.includes("TL_XB_DOFD_INCONSISTENT"), false); // EXP has null DOFD -> only 1 reported
check("EXP derogatory? no — it says Current", expCodes.includes("TL_DEROGATORY_WITHOUT_DOFD"), false);

const tuItem = result.tradelines.find((t) => t.stableItemKey === "bt_tl_navy_tu");
check("finding carries stableItemKey (legal unit)", tuItem.stableItemKey, "bt_tl_navy_tu");
check("finding carries stableAccountKey (context)", tuItem.stableAccountKey, "bt_ac_navy");

console.log("\n--- Account-level: absence has no item key to attach to ---");

const acct = result.accountFindings.find((a) => a.stableAccountKey === "bt_ac_navy");
check("equifax absence recorded at ACCOUNT level", acct.findings[0].code, "ACCT_NOT_REPORTED_BY_BUREAU");

console.log("\n--- Internal Metro 2 contradictions ---");

const brokenCodes = codesFor(result, "bt_tl_broken_eqf");
check("past due on zero balance", brokenCodes.includes("TL_PAST_DUE_ON_ZERO_BALANCE"), true);
check("derogatory without DOFD", brokenCodes.includes("TL_DEROGATORY_WITHOUT_DOFD"), true);

console.log("\n--- Beyond reporting period ---");

const collCodes = codesFor(result, "bt_tl_coll_tu");
check("collection DOFD > 7 years", collCodes.includes("TL_BEYOND_REPORTING_PERIOD"), true);
check("collection missing original creditor", collCodes.includes("COL_MISSING_ORIGINAL_CREDITOR"), true);

console.log("\n--- Personal information / mixed file ---");

const piCodes = result.personalInformation.map((f) => f.code);
check("two SSNs detected", piCodes.includes("PI_MULTIPLE_SSN"), true);
check("mixed file indicator", piCodes.includes("PI_MIXED_FILE_INDICATOR"), true);
check("mixed file is CRITICAL", result.personalInformation[0].severity, "CRITICAL");

console.log("\n--- Inquiries ---");

const oldInq = codesFor(result, "bt_iq_old");
check("stale inquiry detected", oldInq.includes("INQ_BEYOND_REPORTING_PERIOD"), true);

console.log("\n=== FACTS WE MUST NOT INVENT ===\n");

// The registry must not even CONTAIN codes we cannot support from evidence.
check("no UNAUTHORIZED_INQUIRY code exists", "UNAUTHORIZED_INQUIRY" in FINDING_CODES, false);
check("no INCORRECT_BALANCE code exists", "INCORRECT_BALANCE" in FINDING_CODES, false);
check("no INCORRECT_NAME code exists", "INCORRECT_NAME" in FINDING_CODES, false);

const inq1 = codesFor(result, "bt_iq_1");
check("authorization reported as UNVERIFIABLE, not 'unauthorized'", inq1.includes("INQ_AUTHORIZATION_UNVERIFIABLE"), true);

const inqItem = result.inquiries.find((i) => i.stableItemKey === "bt_iq_1");
const authFinding = inqItem.findings.find((f) => f.code === "INQ_AUTHORIZATION_UNVERIFIABLE");
check("...and it is INFO, not an accusation", authFinding.severity, "INFO");

console.log("\n=== Re-aging is UNDETECTABLE without a previous report ===\n");

check("no previous report -> notEvaluated is populated", result.notEvaluated.length > 0, true);

const prevGap = result.notEvaluated.find((n) => n.requires === "PREVIOUS_REPORT");
check("re-aging explicitly listed as not evaluated", prevGap.codes_not_evaluated.includes("HIST_RE_AGING_INDICATOR"), true);
check("no re-aging finding emitted from one report", codesFor(result, "bt_tl_navy_tu").includes("HIST_RE_AGING_INDICATOR"), false);

// Now supply a previous report where the DOFD was EARLIER. It moved later. That
// is re-aging, and it is only visible across two reports.
const previousReport = {
    extraction_ok: true,
    accounts: [
        {
            stable_account_key: "bt_ac_navy",
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_navy_tu",
                    bureau: "transunion",
                    furnisher: "NAVY FEDERAL CR UNION",
                    observation: {
                        status: "Charge-off",
                        balance: 4200,
                        date_opened: "2019-03-14",
                        date_of_first_delinquency: "2021-01-15", // EARLIER than current
                    },
                },
            ],
        },
    ],
};

const withHistory = await analyzeCreditReport(report, { previousReport, asOf: ASOF });
const tuHist = codesFor(withHistory, "bt_tl_navy_tu");

check("WITH previous report -> re-aging DETECTED", tuHist.includes("HIST_RE_AGING_INDICATOR"), true);
check("re-aging is CRITICAL", FINDING_CODES.HIST_RE_AGING_INDICATOR.severity, "CRITICAL");
check("comparedAgainstPreviousReport", withHistory.clientSummary.comparedAgainstPreviousReport, true);

console.log("\n=== Fail closed on an untrusted report ===\n");

const untrusted = await analyzeCreditReport({ extraction_ok: false, accounts: [] }, { asOf: ASOF });

check("extraction_ok:false -> analysisOk false", untrusted.analysisOk, false);
check("...and no findings", untrusted.tradelines.length, 0);
check("...and not ready", untrusted.readyForLetterGeneration, false);

console.log("\n=== Determinism ===\n");

const a = await analyzeCreditReport(report, { asOf: ASOF });
const b = await analyzeCreditReport(report, { asOf: ASOF });

check("identical input -> byte-identical output", JSON.stringify(a) === JSON.stringify(b), true);

console.log("\n=== The engine chooses no remedies ===\n");

const actions = new Set(result.recommendedActions.map((a) => a.action));
check("only one action value exists", actions.size, 1);
check("...and it defers to the Decision Engine", [...actions][0], "REVIEW_BY_DECISION_ENGINE");
check("priority is ranked worst-first", result.overallPriority[0].topSeverity, "CRITICAL");

console.log(`\n${passed} passed, ${failed} failed.\n`);

if (failed > 0) process.exit(1);
