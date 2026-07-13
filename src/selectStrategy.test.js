/**
 * selectStrategy.test.js
 * Run: node src/intelligence/selectStrategy.test.js
 *
 * The Strategy Engine decides whether to ACCUSE a bureau of misconduct in the
 * consumer's name. An unearned escalation is a false accusation over the
 * client's signature. The tests weight that as heavily as the disputes.
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes } from "./decideDisputes.js";
import { selectStrategy, PRIOR_OUTCOME, MAX_ROUNDS } from "./selectStrategy.js";

let passed = 0, failed = 0;

function check(name, actual, expected) {
    const ok = actual === expected;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} -> ${actual}${ok ? "" : `\n      expected: ${expected}`}`);
}

const ASOF = new Date("2026-07-12T00:00:00Z");

const report = {
    extraction_ok: true,
    crc_client_id: 15,
    reported_personal_information: { names: ["ELIZABETH KELLEY"], ssns: ["123-45-6789"], dates_of_birth: ["1980-04-02"] },
    accounts: [
        {
            stable_account_key: "bt_ac_1",
            bureau_tradelines: [
                {
                    // SELF_EVIDENT: past due on a zero balance. Metro 2 contradiction.
                    stable_item_key: "bt_tl_tu",
                    bureau: "transunion",
                    furnisher: "SOME BANK",
                    masked_account: "****1111",
                    observation: {
                        status: "Charge-off", balance: 0, past_due: 900,
                        responsibility: "Individual", date_opened: "2018-01-10",
                        date_of_first_delinquency: "2022-03-01",
                    },
                },
                {
                    // CROSS_BUREAU only: differs from TU, but self-consistent.
                    stable_item_key: "bt_tl_exp",
                    bureau: "experian",
                    furnisher: "SOME BANK",
                    masked_account: "****1111",
                    observation: {
                        status: "Collection", balance: 900, past_due: 900,
                        responsibility: "Individual", date_opened: "2018-01-10",
                        date_of_first_delinquency: "2022-03-01",
                    },
                },
            ],
        },
    ],
    collections: [], inquiries: [], public_records: [],
};

const analysis = await analyzeCreditReport(report, { asOf: ASOF });
const decisions = await decideDisputes(analysis, { report });

const S = (r, k) => r.itemStrategies.find((s) => s.stableItemKey === k);

console.log("\n=== Round 1: no history -> first dispute, no escalation ===\n");

const r1 = await selectStrategy(decisions, {});
const tu1 = S(r1, "bt_tl_tu");

check("strategyOk", r1.strategyOk, true);
check("no history -> all treated as first dispute", r1.summary.allTreatedAsFirstDispute, true);
check("round 1", tu1.round, 1);
check("NOT escalated", tu1.escalated, false);
check("Metro 2 -> BT-ST-0010", tu1.strategy.strategy, "BT-ST-0010");
check("zero escalations", r1.summary.escalations, 0);

console.log("\n=== Escalation is EARNED by conduct, not by round number ===\n");

// The bureau VERIFIED an item that contradicts itself. It cannot have
// reasonably investigated a record that contradicts itself.
const verifiedSelfEvident = {
    bt_tl_tu: { rounds: [{ round: 1, strategy: "BT-ST-0010", outcome: PRIOR_OUTCOME.VERIFIED }] },
};

const r2 = await selectStrategy(decisions, { itemHistory: verifiedSelfEvident });
const tu2 = S(r2, "bt_tl_tu");

check("round 2", tu2.round, 2);
check("VERIFIED + SELF_EVIDENT -> escalated", tu2.escalated, true);
check("...to Failure to Investigate", tu2.strategy.strategy, "BT-ST-0011");
check("...escalation grounds recorded", tu2.escalationGrounds.includes("contradict"), true);
check("...escalation ALWAYS reviewed by a human", tu2.humanReview, true);

console.log("\n--- The SAME verification on WEAKER evidence must NOT claim misconduct ---");

// Experian's tradeline is self-consistent — our evidence there is only
// CROSS_BUREAU. Experian may hold data we can't see. We cannot say it failed
// to investigate merely because it disagreed with us.
const verifiedCrossBureau = {
    bt_tl_exp: { rounds: [{ round: 1, strategy: "BT-ST-0001", outcome: PRIOR_OUTCOME.VERIFIED }] },
};

const r3 = await selectStrategy(decisions, { itemHistory: verifiedCrossBureau });
const exp3 = S(r3, "bt_tl_exp");

check("EXP evidence is CROSS_BUREAU", exp3.evidenceClass, "CROSS_BUREAU");
check("still escalates (verified, unresolved)", exp3.escalated, true);
check("...but NOT to Failure to Investigate", exp3.strategy.strategy === "BT-ST-0011", false);
check("...to the Furnisher instead", exp3.strategy.strategy, "BT-ST-0002");

console.log("\n--- Reinsertion escalates IMMEDIATELY, no round threshold ---");

const reappeared = {
    bt_tl_tu: { rounds: [{ round: 1, strategy: "BT-ST-0010", outcome: PRIOR_OUTCOME.REAPPEARED }] },
};

const r4 = await selectStrategy(decisions, { itemHistory: reappeared });
const tu4 = S(r4, "bt_tl_tu");

check("reappeared -> escalated at round 2", tu4.escalated, true);
check("...to Notice & Cure", tu4.strategy.strategy, "BT-ST-0013");

console.log("\n--- Promised correction not made -> Failure to Update ---");

const notUpdated = {
    bt_tl_tu: { rounds: [{ round: 1, strategy: "BT-ST-0010", outcome: PRIOR_OUTCOME.CORRECTED, stillPresentUnchanged: true }] },
};

const r5 = await selectStrategy(decisions, { itemHistory: notUpdated });
check("corrected-but-unchanged -> BT-ST-0012", S(r5, "bt_tl_tu").strategy.strategy, "BT-ST-0012");

console.log("\n--- It worked. Stop. ---");

const deleted = {
    bt_tl_tu: { rounds: [{ round: 1, strategy: "BT-ST-0010", outcome: PRIOR_OUTCOME.DELETED }] },
};

const r6 = await selectStrategy(decisions, { itemHistory: deleted });
const tu6 = S(r6, "bt_tl_tu");

check("deleted -> No Further Action", tu6.strategy.strategy, "BT-ST-0016");
check("...not escalated", tu6.escalated, false);
check("...no round assigned", tu6.round, null);

console.log("\n=== Bureaus escalate INDEPENDENTLY ===\n");

// TU failed to investigate. EXP corrected on round 1. Same account.
const mixedHistory = {
    bt_tl_tu: { rounds: [{ round: 1, strategy: "BT-ST-0010", outcome: PRIOR_OUTCOME.VERIFIED }] },
    bt_tl_exp: { rounds: [{ round: 1, strategy: "BT-ST-0001", outcome: PRIOR_OUTCOME.DELETED }] },
};

const r7 = await selectStrategy(decisions, { itemHistory: mixedHistory });

check("TU escalates", S(r7, "bt_tl_tu").escalated, true);
check("EXP stops (it worked)", S(r7, "bt_tl_exp").strategy.strategy, "BT-ST-0016");
check("...same account, different outcomes", S(r7, "bt_tl_tu").stableAccountKey === S(r7, "bt_tl_exp").stableAccountKey, true);

console.log("\n=== The six-round ceiling holds ===\n");

const sixRounds = {
    bt_tl_tu: {
        rounds: Array.from({ length: MAX_ROUNDS }, (_, i) => ({
            round: i + 1, strategy: "BT-ST-0010", outcome: PRIOR_OUTCOME.VERIFIED,
        })),
    },
};

const r8 = await selectStrategy(decisions, { itemHistory: sixRounds });
const tu8 = S(r8, "bt_tl_tu");

check(`${MAX_ROUNDS} rounds done -> No Further Action`, tu8.strategy.strategy, "BT-ST-0016");
check("...routed to a human", tu8.humanReview, true);
check("...round limit not exceeded", tu8.round, null);

console.log("\n=== Untrusted decisions are never strategised ===\n");

const bad = await selectStrategy({ decisionOk: false });
check("strategyOk false", bad.strategyOk, false);

console.log("\n=== Determinism ===\n");
const d1 = await selectStrategy(decisions, { itemHistory: mixedHistory });
const d2 = await selectStrategy(decisions, { itemHistory: mixedHistory });
check("identical input -> identical output", JSON.stringify(d1) === JSON.stringify(d2), true);

console.log("\n=== FULL CHAIN — Facts -> Decision -> Strategy ===\n");
console.log(S(r2, "bt_tl_tu").reasoningChain.join("\n"));

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
