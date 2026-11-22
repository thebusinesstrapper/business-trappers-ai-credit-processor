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
check("...no numeric confidence exists", "confidence" in metro2, false);
check("...governed tier VALIDATED_AUTOMATION", metro2.automationTier, "VALIDATED_AUTOMATION");
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
// No matching account is reported for this source at this bureau. Under the
// current BT-DM-0001 rule this is a candidate for permissible-purpose review,
// NOT proof that the consumer did not authorize the inquiry.
check("unassociated inquiry -> dispute candidate", inq.outcome, OUTCOME.DISPUTE_CANDIDATE);
check("...one governed decision", inq.decisionRecords.length, 1);
check("...governed by BT-DM-0001", inq.primaryDecision?.record, "BT-DM-0001");

// Associated accounts do not exempt inquiries. KCB names remain protected.
const allInquiryReport = JSON.parse(JSON.stringify(report));
allInquiryReport.inquiries = [
    { stable_item_key: "inq_associated", bureau: "experian", furnisher: "SPOUSE CARD", inquiry_date: "2026-06-01" },
    { stable_item_key: "inq_kcb", bureau: "experian", furnisher: "KCB CREDIT LLC", inquiry_date: "2026-06-01" },
];
const allInquiryAnalysis = await analyzeCreditReport(allInquiryReport, { asOf: ASOF });
const allInquiryDecisions = await decideDisputes(allInquiryAnalysis, { report: allInquiryReport });
check("associated-account inquiry -> dispute candidate", decisionFor(allInquiryDecisions, "inq_associated")?.outcome, OUTCOME.DISPUTE_CANDIDATE);
check("associated inquiry -> governed BT-DM-0001", decisionFor(allInquiryDecisions, "inq_associated")?.primaryDecision?.record, "BT-DM-0001");
check("KCB inquiry -> protected exclusion", decisionFor(allInquiryDecisions, "inq_kcb")?.outcome, OUTCOME.EXCLUDED);

console.log("\n=== NEW Decision Records: obsolete items are now first-class ===\n");

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
check("governed by BT-DM-0051 (NEW)", obsolete.primaryDecision.record, "BT-DM-0051");
check("...named Obsolete Derogatory Reporting", obsolete.primaryDecision.name, "Obsolete Derogatory Reporting");
check("...evidence SELF_EVIDENT", obsolete.evidenceClass, "SELF_EVIDENT");
check("...a real dispute candidate, not a manual-review escape", obsolete.outcome, OUTCOME.DISPUTE_CANDIDATE);
check("...NO library gaps remain", staleResult.libraryGaps.length, 0);

// The 180-day grace period. An item at 7y2m is NOT yet obsolete.
const notYetReport = JSON.parse(JSON.stringify(staleReport));
notYetReport.accounts[0].bureau_tradelines[0].observation.date_of_first_delinquency = "2019-04-01"; // ~7.3y
const notYet = await analyzeCreditReport(notYetReport, { asOf: ASOF });
check("7.3 years -> NOT flagged obsolete (FCRA 180-day grace)", notYet.tradelines[0].findings.some((f) => f.code === "TL_BEYOND_REPORTING_PERIOD"), false);

console.log("\n=== MIXED FILE poisons every item beneath it ===\n");

const mixedReport = JSON.parse(JSON.stringify(report));
mixedReport.reported_personal_information.ssns = ["123-45-6789", "987-65-4321"];

const mixedAnalysis = await analyzeCreditReport(mixedReport, { asOf: ASOF });
const mixedResult = await decideDisputes(mixedAnalysis, { report: mixedReport });

check("mixed file blocks the report", mixedResult.reportLevel.mixedFile, true);
check("blocker raised", mixedResult.reportLevel.blockers[0].blocker, "MIXED_FILE");
check("BT-DM-0007 is FIRST priority", mixedResult.reportLevel.decisions[0].record, "BT-DM-0007");

const metro2Mixed = decisionFor(mixedResult, "bt_tl_metro2");
check("the SAME self-evident item now needs review", metro2Mixed.humanReview, true);
check("...evidence class is UNCHANGED (stable taxonomy)", metro2Mixed.evidenceClass, "SELF_EVIDENT");
check("...but POLICY demotes it", metro2Mixed.automationTier, "HUMAN_REVIEW_REQUIRED");
check("...via a named override", metro2Mixed.appliedOverrides.includes("MIXED_FILE"), true);
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

console.log("\n=== OWNERSHIP: THE CHECK USED TO FAIL OPEN ===\n");

const { KNOWN_RESPONSIBILITY_VALUES } = await import("./decideDisputes.js");

// The vocabulary was READ OFF the live payload (119 rows), not invented.
check("vocabulary from production", KNOWN_RESPONSIBILITY_VALUES.length, 4);
check("...includes AuthorizedUser", KNOWN_RESPONSIBILITY_VALUES.includes("AuthorizedUser"), true);
check("...includes Terminated", KNOWN_RESPONSIBILITY_VALUES.includes("Terminated"), true);

/** A derogatory tradeline whose ONLY variable is responsibility. */
const ownReport = (responsibility) => ({
    crc_client_id: "15",
    model_version: "BT-CRM-1.1",
    report_metadata: { report_date: "2026-07-13", bureaus_present: ["transunion"] },
    accounts: [{
        stable_account_key: "bt_ac_own",
        bureau_tradelines: [{
            stable_item_key: "bt_tl_own",
            bureau: "transunion",
            furnisher: "CHASE",
            masked_account: "****1234",
            observation: {
                responsibility,
                status: "ChargeOff",
                balance: 4200,
                past_due: 500,
                date_opened: "2019-03-01",
            },
        }],
    }],
    collections: [],
    inquiries: [],
    public_records: [],
});

const ownDecide = async (responsibility) => {
    const r = ownReport(responsibility);
    const a = await analyzeCreditReport(r, { asOf: ASOF });
    return { result: await decideDisputes(a, { report: r }), report: r };
};

// The live value. \\s* matches zero spaces, so "AuthorizedUser" is caught.
const au2 = await ownDecide("AuthorizedUser");
check("AuthorizedUser -> EXCLUDED", au2.result.itemDecisions[0].outcome, "EXCLUDED");
check("...by the Constitution", au2.result.itemDecisions[0].exclusion.rule, "CONSTITUTION_NEVER_DISPUTE_AUTHORIZED_USER");

// ---- THE HOLE THAT WAS THERE ------------------------------------------------
//
// A null responsibility previously fell through the regex, returned null, and the
// tradeline WAS DISPUTED. The one field that tells us whether an account is the
// consumer's to dispute was allowed to be MISSING — and its ABSENCE was read as
// PERMISSION.
//
// An authorized-user tradeline usually carries someone else's GOOD history.
// Disputing it invites its deletion and the consumer loses history that was
// helping her. Stopping costs one human review. Guessing destroys that history
// irreversibly, in her name.
const nullResp = await ownDecide(null);
const nullItem = nullResp.result.itemDecisions[0];

check("null responsibility -> EXCLUDED, not disputed", nullItem.outcome, "EXCLUDED");
check("...rule names the gap", nullItem.exclusion.rule, "RESPONSIBILITY_UNKNOWN");
check("...routed to Human Exception (BT-DM-0049)", nullItem.primaryDecision.record, "BT-DM-0049");
check("...absence is not evidence of ownership", /ABSENT value is not evidence/.test(nullItem.exclusion.reason), true);

// A value Array starts emitting tomorrow would fail the AuthorizedUser regex and
// be silently disputed. Now it is recognisable AS unrecognised.
const novel = await ownDecide("SomeNewOwnershipType");
check("unrecognised value -> EXCLUDED", novel.result.itemDecisions[0].outcome, "EXCLUDED");
check("...rule names it", novel.result.itemDecisions[0].exclusion.rule, "RESPONSIBILITY_UNRECOGNISED");

// The known-good values still flow through normally — the guard must not become a
// blanket refusal.
for (const value of ["Individual", "JointContractualLiability", "Terminated"]) {
    const ok = await ownDecide(value);
    const item = ok.result.itemDecisions[0];

    check(`${value} -> not blocked by the ownership guard`,
        ["RESPONSIBILITY_UNKNOWN", "RESPONSIBILITY_UNRECOGNISED"].includes(item.exclusion?.rule ?? ""), false);
}



// Business Trappers: documented late counts on otherwise-current accounts
// must be dispute candidates, while authorized-user exclusions still apply.
const lateReport = {
    extraction_ok: true,
    reported_personal_information: { names: ["TEST CONSUMER"], ssns: ["000-00-0000"], dates_of_birth: ["1980-01-01"] },
    accounts: [
        { stable_account_key: "late_individual", bureau_tradelines: [
            { stable_item_key: "late_tu", bureau: "transunion", furnisher: "BANK A", masked_account: "****1234",
              observation: { basis: "BUREAU_SPECIFIC", normalized: { status: "Current", past_due: 0, responsibility: "Individual",
                  late_counts: { days_30: 2, days_60: 0, days_90: 0 } } } },
        ] },
        { stable_account_key: "late_authorized", bureau_tradelines: [
            { stable_item_key: "late_au", bureau: "experian", furnisher: "BANK B", masked_account: "****5678",
              observation: { basis: "BUREAU_SPECIFIC", normalized: { status: "Current", past_due: 0, responsibility: "AuthorizedUser",
                  late_counts: { days_30: 1, days_60: 0, days_90: 0 } } } },
        ] },
        { stable_account_key: "shared_late", bureau_tradelines: [
            { stable_item_key: "shared_tu", bureau: "transunion", furnisher: "BANK D", masked_account: "****4444",
              observation: { basis: "SHARED_ACROSS_BUREAUS", normalized: { status: "Current", past_due: 0, responsibility: "Individual",
                  late_counts: { days_30: 3, days_60: 1, days_90: 0 } } } },
        ] },
        { stable_account_key: "clean_individual", bureau_tradelines: [
            { stable_item_key: "clean_tu", bureau: "transunion", furnisher: "BANK C", masked_account: "****9876",
              observation: { basis: "BUREAU_SPECIFIC", normalized: { status: "Current", past_due: 0, responsibility: "Individual",
                  late_counts: { days_30: 0, days_60: 0, days_90: 0 } } } },
        ] },
    ],
    collections: [], inquiries: [], public_records: [],
};
const lateAnalysis = await analyzeCreditReport(lateReport, { asOf: ASOF });
const lateDecisions = await decideDisputes(lateAnalysis, { report: lateReport });
check("late count -> baseline dispute finding", lateAnalysis.tradelines.find(x => x.stableItemKey === "late_tu")?.findings.some(x => x.code === "TL_BASELINE_REINVESTIGATION"), true);
check("late count on current account -> dispute candidate", decisionFor(lateDecisions, "late_tu")?.outcome, OUTCOME.DISPUTE_CANDIDATE);
check("late count on authorized user -> excluded", decisionFor(lateDecisions, "late_au")?.outcome, OUTCOME.EXCLUDED);
check("clean current account -> no action", decisionFor(lateDecisions, "clean_tu")?.outcome, OUTCOME.NO_ACTION);

check("shared late counts -> no bureau-specific baseline finding", lateAnalysis.tradelines.find(x => x.stableItemKey === "shared_tu")?.findings.some(x => x.code === "TL_BASELINE_REINVESTIGATION"), false);
check("shared late counts -> no action", decisionFor(lateDecisions, "shared_tu")?.outcome, OUTCOME.NO_ACTION);

console.log(`\n${passed} passed, ${failed} failed.\n`);

if (failed > 0) process.exit(1);
