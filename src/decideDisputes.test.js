/**
 * decideDisputes.test.js
 *
 * Run: node src/intelligence/decideDisputes.test.js
 *
 * The Decision Engine can HARM a client. Disputing an authorized-user tradeline
 * or a positive account can get a BENEFICIAL account deleted. So the tests
 * weight the exclusions as heavily as the disputes.
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes, OUTCOME } from "./decideDisputes.js";

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

function decisionFor(result, key) {
    return result.itemDecisions.find((d) => d.stableItemKey === key);
}

/** A clean file — no mixed-file signal — so item decisions are not poisoned. */
const report = {
    extraction_ok: true,
    crc_client_id: 15,
    report_date: "2026-07-10",

    reported_personal_information: {
        names: ["ELIZABETH KELLEY"],
        ssns: ["123-45-6789"],
        dates_of_birth: ["1980-04-02"],
    },

    accounts: [
        {
            // Metro 2 self-contradiction on a derogatory account. Disputable.
            stable_account_key: "bt_ac_1",
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_metro2",
                    bureau: "transunion",
                    furnisher: "SOME BANK",
                    masked_account: "****1111",
                    observation: {
                        status: "Charge-off",
                        balance: 0,
                        past_due: 900,
                        responsibility: "Individual",
                        date_opened: "2018-01-10",
                        date_of_first_delinquency: null,
                    },
                },
            ],
        },
        {
            // AUTHORIZED USER. Constitution: never dispute. Even with findings.
            stable_account_key: "bt_ac_au",
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_au",
                    bureau: "experian",
                    furnisher: "SPOUSE CARD",
                    masked_account: "****2222",
                    observation: {
                        status: "Charge-off",
                        balance: 0,
                        past_due: 500, // would otherwise be a strong Metro 2 finding
                        responsibility: "Authorized User",
                        date_opened: "2017-05-01",
                        date_of_first_delinquency: null,
                    },
                },
            ],
        },
        {
            // POSITIVE account with only a cross-bureau BALANCE variance.
            // Disputing risks deleting a good tradeline. Constitution: don't.
            stable_account_key: "bt_ac_pos",
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_pos_tu",
                    bureau: "transunion",
                    furnisher: "GOOD CARD",
                    masked_account: "****3333",
                    observation: {
                        status: "Current",
                        balance: 1000,
                        past_due: 0,
                        responsibility: "Individual",
                        date_opened: "2020-01-01",
                    },
                },
                {
                    stable_item_key: "bt_tl_pos_exp",
                    bureau: "experian",
                    furnisher: "GOOD CARD",
                    masked_account: "****3333",
                    observation: {
                        status: "Current",
                        balance: 1800, // differs by $800
                        past_due: 0,
                        responsibility: "Individual",
                        date_opened: "2020-01-01",
                    },
                },
            ],
        },
    ],

    collections: [],
    inquiries: [
        { stable_item_key: "bt_iq_1", bureau: "experian", furnisher: "CAPITAL ONE", inquiry_date: "2026-06-01" },
    ],
    public_records: [],
};

console.log("\n=== Decision from facts ===\n");

const analysis = await analyzeCreditReport(report, { asOf: ASOF });
const result = await decideDisputes(analysis, { report });

check("decisionOk", result.decisionOk, true);
check("exclusions were enforceable", result.summary.constitutionalExclusionsEnforced, true);

const metro2 = decisionFor(result, "bt_tl_metro2");
check("Metro 2 contradiction -> dispute candidate", metro2.outcome, OUTCOME.DISPUTE_CANDIDATE);
check("...governed by BT-DM-0033", metro2.primaryDecision.record, "BT-DM-0033");
check("...evidence class SELF_EVIDENT", metro2.decisionRecords[0].evidenceClass, "SELF_EVIDENT");
check("...confidence 97", metro2.confidence, 97);
check("...fully automated", metro2.automationTier, "FULLY_AUTOMATED");
check("...no human review needed", metro2.humanReview, false);

console.log("\n=== CONSTITUTIONAL EXCLUSIONS (these protect the client) ===\n");

const au = decisionFor(result, "bt_tl_au");
check("authorized user -> EXCLUDED", au.outcome, OUTCOME.EXCLUDED);
check("...despite having findings", au.exclusion.rule, "CONSTITUTION_NEVER_DISPUTE_AUTHORIZED_USER");
check("...routed to BT-DM-0036", au.primaryDecision.record, "BT-DM-0036");
check("...NO decision records raised", au.decisionRecords.length, 0);

const pos = decisionFor(result, "bt_tl_pos_tu");
check("positive account, non-derogatory variance -> EXCLUDED", pos.outcome, OUTCOME.EXCLUDED);
check("...rule cited", pos.exclusion.rule, "CONSTITUTION_NEVER_DISPUTE_POSITIVE_ACCOUNTS");
check("...routed to BT-DM-0050 No Further Action", pos.primaryDecision.record, "BT-DM-0050");

console.log("\n=== Never assert what the consumer must tell us ===\n");

const inq = decisionFor(result, "bt_iq_1");
check("inquiry -> REQUIRES_CONSUMER_INPUT", inq.outcome, OUTCOME.REQUIRES_CONSUMER_INPUT);
check("...NOT a dispute", inq.decisionRecords.length, 0);
check("...and no BT-DM-0001 asserted", inq.primaryDecision, null);

console.log("\n=== Library gaps are surfaced, never force-fitted ===\n");

const staleReport = JSON.parse(JSON.stringify(report));
staleReport.accounts = [
    {
        stable_account_key: "bt_ac_old",
        bureau_tradelines: [
            {
                stable_item_key: "bt_tl_obsolete",
                bureau: "equifax",
                furnisher: "ANCIENT DEBT",
                masked_account: "****4444",
                observation: {
                    status: "Charge-off",
                    balance: 3000,
                    past_due: 3000,
                    responsibility: "Individual",
                    date_opened: "2010-01-01",
                    date_of_first_delinquency: "2012-01-01", // 14 years old
                },
            },
        ],
    },
];

const staleAnalysis = await analyzeCreditReport(staleReport, { asOf: ASOF });
const staleResult = await decideDisputes(staleAnalysis, { report: staleReport });
const obsolete = decisionFor(staleResult, "bt_tl_obsolete");

check("obsolete item detected by Analysis", staleAnalysis.tradelines[0].findings.some((f) => f.code === "TL_BEYOND_REPORTING_PERIOD"), true);
check("library gap recorded", staleResult.libraryGaps.some((g) => g.code === "TL_BEYOND_REPORTING_PERIOD"), true);
check("...finding NOT discarded", obsolete.outcome !== OUTCOME.NO_ACTION, true);
check("...routed to human review", obsolete.humanReview, true);

console.log("\n=== MIXED FILE poisons every item beneath it ===\n");

const mixedReport = JSON.parse(JSON.stringify(report));
mixedReport.reported_personal_information.ssns = ["123-45-6789", "987-65-4321"];

const mixedAnalysis = await analyzeCreditReport(mixedReport, { asOf: ASOF });
const mixedResult = await decideDisputes(mixedAnalysis, { report: mixedReport });

check("mixed file blocks the report", mixedResult.reportLevel.mixedFile, true);
check("blocker raised", mixedResult.reportLevel.blockers[0].blocker, "MIXED_FILE");
check("BT-DM-0007 is FIRST priority", mixedResult.reportLevel.decisions[0].record, "BT-DM-0007");

const metro2Mixed = decisionFor(mixedResult, "bt_tl_metro2");
check("the SAME 97-confidence item now needs review", metro2Mixed.humanReview, true);
check("...confidence capped at 60", metro2Mixed.confidence, 60);
check("...no longer a dispute candidate", metro2Mixed.outcome, OUTCOME.HUMAN_REVIEW);

console.log("\n=== Without the report, exclusions CANNOT be checked ===\n");

const noReport = await decideDisputes(analysis, {});

check("exclusions not enforced", noReport.summary.constitutionalExclusionsEnforced, false);
check("...so nothing auto-disputes", noReport.summary.disputeCandidates, 0);
check("...everything goes to a human", decisionFor(noReport, "bt_tl_metro2").humanReview, true);

console.log("\n=== Untrusted analysis is never decided upon ===\n");

const bad = await decideDisputes({ analysisOk: false });
check("decisionOk false", bad.decisionOk, false);
check("no decisions", bad.itemDecisions.length, 0);

console.log("\n=== Determinism ===\n");

const r1 = await decideDisputes(analysis, { report });
const r2 = await decideDisputes(analysis, { report });
check("identical input -> identical output", JSON.stringify(r1) === JSON.stringify(r2), true);

console.log("\n=== THE REASONING CHAIN (Kris reads this) ===\n");
console.log(metro2.reasoningChain.join("\n"));

console.log(`\n${passed} passed, ${failed} failed.\n`);

if (failed > 0) process.exit(1);
