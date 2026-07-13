/**
 * demoDisputePackage.js
 *
 * ###########################################################################
 * ##  THIS RUNS ON A SYNTHETIC FIXTURE. IT IS **NOT** A REAL CREDIT REPORT. ##
 * ##                                                                       ##
 * ##  Every tradeline below was AUTHORED BY HAND to exercise the pipeline. ##
 * ##  The client identity is a TEST FIXTURE and is REJECTED by the Letter  ##
 * ##  Engine unless explicitly marked as CRC-sourced.                      ##
 * ##                                                                       ##
 * ##  If this package looks like it is "missing tradelines", it is because ##
 * ##  this file only CONTAINS the tradelines typed into it. Nothing is     ##
 * ##  filtered. The reconciliation report below proves it.                 ##
 * ###########################################################################
 *
 * Run: node src/intelligence/demoDisputePackage.js
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes } from "./decideDisputes.js";
import { selectStrategy, PRIOR_OUTCOME } from "./selectStrategy.js";
import { buildDisputeChain } from "./disputeChain.js";
import { generateLetters } from "./generateLetter.js";
import { reconcile, formatReconciliation } from "./reconcile.js";
import { fromCrcProfile } from "./clientIdentity.js";

const ASOF = new Date("2026-07-13T00:00:00Z");

// ---------------------------------------------------------------------------
// IDENTITY — simulating a CRC client profile read.
//
// In production this comes from a CRC profile reader that DOES NOT YET EXIST.
// See the note at the end of this file. Here we construct it through
// fromCrcProfile() so it carries the provenance the Letter Engine demands —
// which is exactly what the fabricated address in the previous demo did not.
// ---------------------------------------------------------------------------
const clientIdentity = fromCrcProfile(
    {
        name: "Elizabeth Kelley",
        address_line_1: "5084 Louvinia Dr",
        city: "Tallahassee",
        state: "FL",
        postal_code: "32311",
    },
    { crcClientId: 15, sourceUrl: "https://app.creditrepaircloud.com/app/clients/15/dashboard", retrievedAt: ASOF.toISOString() }
);

const tl = (key, bureau, furnisher, masked, observation) => ({
    stable_item_key: key, bureau, furnisher, masked_account: masked, observation,
});

const report = {
    extraction_ok: true,
    crc_client_id: 15,
    report_date: "2026-07-10",
    model_version: "BT-CRM-1.0",

    reported_personal_information: {
        names: ["ELIZABETH KELLEY"], ssns: ["123-45-6789"], dates_of_birth: ["1980-04-02"],
    },

    accounts: [
        {
            // Metro 2 contradiction at TU. Experian says Current. Equifax silent.
            stable_account_key: "bt_ac_navy",
            bureau_tradelines: [
                tl("bt_tl_navy_tu", "transunion", "NAVY FEDERAL CR UNION", "****6095", {
                    status: "Charge-off", balance: 0, past_due: 4200, responsibility: "Individual",
                    date_opened: "2019-03-14", date_of_first_delinquency: null,
                }),
                tl("bt_tl_navy_exp", "experian", "NAVY FCU", "6095XXXXXXXX", {
                    status: "Current", balance: 4200, past_due: 0, responsibility: "Individual",
                    date_opened: "2019-03-14",
                }),
            ],
        },
        {
            // AUTHORIZED USER — Constitution forbids disputing. Has real findings.
            stable_account_key: "bt_ac_au",
            bureau_tradelines: [
                tl("bt_tl_au_tu", "transunion", "SPOUSE VISA", "****7777", {
                    status: "Charge-off", balance: 0, past_due: 800, responsibility: "Authorized User",
                    date_opened: "2016-02-01", date_of_first_delinquency: null,
                }),
            ],
        },
        {
            // OBSOLETE at all three bureaus. DOFD 2016 — well past 7y+180d.
            stable_account_key: "bt_ac_old",
            bureau_tradelines: [
                tl("bt_tl_old_tu", "transunion", "CAPITAL ONE", "****4412", {
                    status: "Charge-off", balance: 2300, past_due: 2300, responsibility: "Individual",
                    date_opened: "2014-05-01", date_of_first_delinquency: "2016-02-01",
                }),
                tl("bt_tl_old_eqf", "equifax", "CAP ONE BANK USA NA", "XXXX4412", {
                    status: "Charge-off", balance: 2300, past_due: 2300, responsibility: "Individual",
                    date_opened: "2014-05-01", date_of_first_delinquency: "2016-02-01",
                }),
            ],
        },
        {
            // NO MASKED ACCOUNT NUMBER at Equifax -> unsendable, must be WITHHELD.
            stable_account_key: "bt_ac_nomask",
            bureau_tradelines: [
                tl("bt_tl_nomask_eqf", "equifax", "SYNCHRONY BANK", null, {
                    status: "Charge-off", balance: 1900, past_due: 1900, responsibility: "Individual",
                    date_opened: "2020-01-01", date_of_first_delinquency: "2022-06-01",
                }),
            ],
        },
        {
            // POSITIVE account. Cross-bureau balance variance only.
            // Constitution: never dispute a positive account.
            stable_account_key: "bt_ac_good",
            bureau_tradelines: [
                tl("bt_tl_good_tu", "transunion", "AMEX", "****9001", {
                    status: "Current", balance: 1200, past_due: 0, responsibility: "Individual",
                    date_opened: "2021-01-01",
                }),
                tl("bt_tl_good_exp", "experian", "AMERICAN EXPRESS", "9001XXXXXXXX", {
                    status: "Current", balance: 2000, past_due: 0, responsibility: "Individual",
                    date_opened: "2021-01-01",
                }),
            ],
        },
    ],

    collections: [
        {
            stable_account_key: "bt_co_midland",
            original_creditor: null, // unverifiable
            bureau_tradelines: [
                tl("bt_tl_coll_tu", "transunion", "MIDLAND CREDIT MGMT", "****3311", {
                    status: "Collection", balance: 1150, past_due: 1150, responsibility: "Individual",
                    date_opened: "2021-08-01", date_of_first_delinquency: "2021-05-01",
                }),
                tl("bt_tl_coll_eqf", "equifax", "MIDLAND CREDIT", "XXXX3311", {
                    status: "Collection", balance: 1150, past_due: 1150, responsibility: "Individual",
                    date_opened: "2021-08-01", date_of_first_delinquency: "2021-05-01",
                }),
            ],
        },
    ],

    inquiries: [],
    public_records: [],
};

// TransUnion VERIFIED the Metro 2 contradiction on round 1. That earns escalation.
const itemHistory = {
    bt_tl_navy_tu: { rounds: [{ round: 1, strategy: "BT-ST-0010", outcome: PRIOR_OUTCOME.VERIFIED }] },
};

// ---- Run the pipeline ------------------------------------------------------

const analysis = await analyzeCreditReport(report, { clientIdentity, asOf: ASOF });
const decisions = await decideDisputes(analysis, { report });
const strategies = await selectStrategy(decisions, { itemHistory });
const chain = await buildDisputeChain(strategies);
const letters = await generateLetters(chain, analysis, { clientIdentity, letterDate: ASOF, report });

const recon = reconcile({ report, analysis, decisions, strategies, letters });

const line = (c = "=") => console.log(c.repeat(78));

line("#");
console.log("## SYNTHETIC FIXTURE — NOT A REAL CREDIT REPORT.");
console.log("## Every tradeline here was hand-authored in demoDisputePackage.js.");
line("#");

console.log("\n" + formatReconciliation(recon) + "\n");

line();
console.log(`IDENTITY SOURCE:  ${letters.summary.identitySource}`);
console.log(`CRC CLIENT ID:    ${letters.summary.identityCrcClientId}`);
console.log(`LEAK CHECK:       ${letters.summary.crossBureauLeakCheck}`);
console.log(`LETTERS:          ${letters.summary.lettersGenerated} (one per bureau)`);
line();

for (const letter of letters.letters) {
    console.log("");
    line();
    console.log(`${letter.bureauName.toUpperCase()} — ${letter.itemCount} account(s), highest round ${letter.round}`);
    console.log(`Review required: ${letter.requiresHumanReview}`);
    line();
    console.log("\n" + letter.body + "\n");
}

line();
console.log("STATUS: AWAITING HUMAN REVIEW. Nothing has been sent.");
line();

console.log(`
OPEN GAP — NO CRC PROFILE READER EXISTS.

openClient.js returns clientName and crcClientId. It does NOT return an address.
No module in this system reads the CRC client profile. The identity above was
constructed by hand through fromCrcProfile() to simulate one.

In production, generateLetters() will REFUSE to run until a real CRC profile
reader supplies identity with source="crc_client_profile". That refusal is now
enforced, not merely documented. Building the reader needs a CRC DOM discovery
spike — no selectors will be guessed.
`);
