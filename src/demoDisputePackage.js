/**
 * demoDisputePackage.js
 *
 * Runs the COMPLETE chain against a representative report and prints the dispute
 * package Kris reviews:
 *
 *   Analyze -> Decide -> Strategy -> Reason -> Instruction -> Blueprint -> Letter
 *
 * Run: node src/intelligence/demoDisputePackage.js
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes } from "./decideDisputes.js";
import { selectStrategy, PRIOR_OUTCOME } from "./selectStrategy.js";
import { buildDisputeChain } from "./disputeChain.js";
import { generateLetters } from "./generateLetter.js";

const ASOF = new Date("2026-07-13T00:00:00Z");

// IDENTITY COMES FROM CRC. The report is evidence, never identity.
const clientIdentity = {
    name: "Elizabeth Kelley",
    address: "1420 Meridian Road\nTallahassee, FL 32303",
    date_of_birth: "1980-04-02",
    ssn: "123-45-6789",
};

const report = {
    extraction_ok: true,
    crc_client_id: 15,
    report_date: "2026-07-10",
    model_version: "BT-CRM-1.0",

    reported_personal_information: {
        names: ["ELIZABETH KELLEY"],
        ssns: ["123-45-6789"],
        dates_of_birth: ["1980-04-02"],
    },

    accounts: [
        {
            stable_account_key: "bt_ac_navy",
            account_type: "Revolving",
            bureau_tradelines: [
                {
                    // Metro 2 self-contradiction: past due on a zero balance,
                    // AND charged off with no DOFD.
                    stable_item_key: "bt_tl_navy_tu",
                    bureau: "transunion",
                    furnisher: "NAVY FEDERAL CR UNION",
                    masked_account: "****6095",
                    observation: {
                        status: "Charge-off",
                        balance: 0,
                        past_due: 4200,
                        responsibility: "Individual",
                        date_opened: "2019-03-14",
                        date_of_first_delinquency: null,
                    },
                },
                {
                    // Same account. Experian says CURRENT. Cross-bureau conflict.
                    stable_item_key: "bt_tl_navy_exp",
                    bureau: "experian",
                    furnisher: "NAVY FCU",
                    masked_account: "6095XXXXXXXX",
                    observation: {
                        status: "Current",
                        balance: 4200,
                        past_due: 0,
                        responsibility: "Individual",
                        date_opened: "2019-03-14",
                    },
                },
            ],
        },
        {
            // AUTHORIZED USER. Constitution forbids disputing. Has findings anyway.
            stable_account_key: "bt_ac_au",
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_au_tu",
                    bureau: "transunion",
                    furnisher: "SPOUSE VISA",
                    masked_account: "****7777",
                    observation: {
                        status: "Charge-off",
                        balance: 0,
                        past_due: 800,
                        responsibility: "Authorized User",
                        date_opened: "2016-02-01",
                        date_of_first_delinquency: null,
                    },
                },
            ],
        },
    ],

    collections: [
        {
            stable_account_key: "bt_co_midland",
            original_creditor: null, // cannot verify a debt with no original creditor
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_coll_tu",
                    bureau: "transunion",
                    furnisher: "MIDLAND CREDIT MGMT",
                    masked_account: "****3311",
                    observation: {
                        status: "Collection",
                        balance: 1150,
                        past_due: 1150,
                        responsibility: "Individual",
                        date_opened: "2021-08-01",
                        date_of_first_delinquency: "2021-05-01",
                    },
                },
            ],
        },
    ],

    inquiries: [],
    public_records: [],
};

// TransUnion previously VERIFIED the Metro 2 contradiction. That earns escalation.
const itemHistory = {
    bt_tl_navy_tu: {
        rounds: [{ round: 1, strategy: "BT-ST-0010", outcome: PRIOR_OUTCOME.VERIFIED }],
    },
};

const line = (c = "=") => console.log(c.repeat(78));

// ---- Run the chain ---------------------------------------------------------

const analysis = await analyzeCreditReport(report, { clientIdentity, asOf: ASOF });
const decisions = await decideDisputes(analysis, { report });
const strategies = await selectStrategy(decisions, { itemHistory });
const chain = await buildDisputeChain(strategies);
const letters = await generateLetters(chain, analysis, { clientIdentity, letterDate: ASOF });

line();
console.log("BUSINESS TRAPPERS AI CREDIT PROCESSOR — DISPUTE PACKAGE");
console.log(`Client: ${clientIdentity.name}  |  CRC ID: ${report.crc_client_id}  |  Report: ${report.report_date}`);
line();

console.log(`\nFINDINGS:        ${analysis.clientSummary.totalFindings} across ${analysis.clientSummary.bureauTradelines} bureau tradelines`);
console.log(`DISPUTED:        ${decisions.summary.disputeCandidates + decisions.summary.requiringHumanReview}`);
console.log(`EXCLUDED:        ${decisions.summary.excludedByConstitution} (Constitutional)`);
console.log(`ESCALATIONS:     ${strategies.summary.escalations}`);
console.log(`LETTERS:         ${letters.summary.lettersGenerated} -> ${letters.summary.bureaus.join(", ")}`);
console.log(`IDENTITY SOURCE: ${letters.summary.identitySource}`);

console.log("\n");
line();
console.log("EXCLUDED BY THE CONSTITUTION — no dispute raised");
line();

for (const d of decisions.itemDecisions.filter((x) => x.outcome === "EXCLUDED")) {
    console.log(`\n  ${d.furnisher} (${d.bureau})`);
    console.log(`  RULE: ${d.exclusion.rule}`);
    console.log(`  ${d.exclusion.reason}`);
}

console.log("\n");
line();
console.log("REASONING TRACE");
line();

for (const letter of letters.letters) {
    for (const trace of letter.reasoningTrace) {
        console.log(`\n--- ${trace.furnisher} (${letter.bureauName}) — ${trace.stableItemKey}`);
        for (const step of trace.chain) console.log(`    ${step}`);
    }
}

console.log("\n");

for (const letter of letters.letters) {
    line();
    console.log(`LETTER ${letters.letters.indexOf(letter) + 1} of ${letters.letters.length} — ${letter.bureauName.toUpperCase()}`);
    console.log(`Round ${letter.round}${letter.escalated ? " (ESCALATION)" : ""}  |  ${letter.itemCount} account(s)  |  Review required: ${letter.requiresHumanReview}`);
    line();
    console.log("\n" + letter.body + "\n");
}

line();
console.log("STATUS: AWAITING HUMAN REVIEW. Nothing has been sent.");
line();
