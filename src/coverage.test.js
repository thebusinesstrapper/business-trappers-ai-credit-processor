/**
 * coverage.test.js
 * Run: node src/intelligence/coverage.test.js
 *
 * THE BUSINESS TRAPPERS COVERAGE RULING.
 *
 *   Every eligible negative bureau tradeline is disputed.
 *   The Analysis Engine decides HOW — never WHETHER.
 *
 * Every eligible negative must exit as exactly one of:
 *   SPECIFIC_STRATEGY | BASELINE_REINVESTIGATION | EXCLUDED | WITHHELD
 *
 * "No Findings" is NOT a legal exit for an eligible negative. These tests prove
 * the pipeline covers everything AND that reconciliation CATCHES the failure if
 * it does not — a coverage rule that cannot detect its own breach is decoration.
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes } from "./decideDisputes.js";
import { selectStrategy } from "./selectStrategy.js";
import { buildDisputeChain } from "./disputeChain.js";
import { generateLetters } from "./generateLetter.js";
import { reconcile, EXIT } from "./reconcile.js";
import { fromCrcProfile } from "./clientIdentity.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(62)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

const ASOF = new Date("2026-07-13T00:00:00Z");

const identity = fromCrcProfile(
    { name: "Elizabeth Suzanne Kelley", address_line_1: "5084 Louvinia Dr", city: "Tallahassee", state: "FL", postal_code: "32311" },
    { crcClientId: 15 }
);

const tl = (key, bureau, furnisher, masked, observation) => ({
    stable_item_key: key, bureau, furnisher, masked_account: masked,
    // Two-layer observation (Bureau Fidelity). The flat fields describe the
    // reasoning-layer values; the reported layer carries the verbatim strings the
    // letter quotes. account_status mirrors the status so the section can quote it.
    observation: {
        ...observation,
        reported: {
            account_status: observation.status ?? null,
            balance: observation.balance ?? null,
            past_due: observation.past_due ?? null,
            dofd: observation.date_of_first_delinquency ?? null,
            date_opened: observation.date_opened ?? null,
        },
        normalized: { ...observation },
    },
});

const report = {
    extraction_ok: true,
    crc_client_id: 15,
    reported_personal_information: { names: ["ELIZABETH KELLEY"], ssns: ["123-45-6789"], dates_of_birth: ["1980-04-02"] },
    accounts: [
        {
            // A. CLEAN CHARGE-OFF. No contradiction anywhere. THIS is the item that
            //    used to vanish as "No findings". It must now get a BASELINE dispute.
            stable_account_key: "bt_ac_syn",
            bureau_tradelines: [
                tl("bt_tl_syn_tu", "transunion", "SYNCHRONY BANK", "****8812", {
                    status: "Charge-off", balance: 1900, past_due: 1900, responsibility: "Individual",
                    date_opened: "2020-01-01", date_of_first_delinquency: "2022-06-01",
                }),
            ],
        },
        {
            // B. Metro 2 contradiction -> SPECIFIC strategy, never baseline.
            stable_account_key: "bt_ac_navy",
            bureau_tradelines: [
                tl("bt_tl_navy_tu", "transunion", "NAVY FEDERAL CR UNION", "****6095", {
                    status: "Charge-off", balance: 0, past_due: 4200, responsibility: "Individual",
                    date_opened: "2019-03-14", date_of_first_delinquency: null,
                }),
            ],
        },
        {
            // C. AUTHORIZED USER -> EXCLUDED.
            stable_account_key: "bt_ac_au",
            bureau_tradelines: [
                tl("bt_tl_au_tu", "transunion", "SPOUSE VISA", "****7777", {
                    status: "Charge-off", balance: 500, past_due: 500, responsibility: "Authorized User",
                    date_opened: "2016-02-01", date_of_first_delinquency: "2018-01-01",
                }),
            ],
        },
        {
            // D. NEGATIVE, NO ACCOUNT NUMBER -> WITHHELD (cannot be identified).
            stable_account_key: "bt_ac_nomask",
            bureau_tradelines: [
                tl("bt_tl_nomask_tu", "transunion", "MYSTERY LENDER", null, {
                    status: "Charge-off", balance: 700, past_due: 700, responsibility: "Individual",
                    date_opened: "2021-01-01", date_of_first_delinquency: "2023-01-01",
                }),
            ],
        },
        {
            // E. POSITIVE -> never disputed. Legally exits as NOT a negative.
            stable_account_key: "bt_ac_good",
            bureau_tradelines: [
                tl("bt_tl_good_tu", "transunion", "AMEX", "****9001", {
                    status: "Current", balance: 1200, past_due: 0, responsibility: "Individual",
                    date_opened: "2021-01-01",
                }),
            ],
        },
    ],
    collections: [], inquiries: [], public_records: [],
};

async function run({ withBaseline = true } = {}) {
    const analysis = await analyzeCreditReport(report, { clientIdentity: identity, asOf: ASOF });

    // The baseline path lives in the ANALYSIS engine (BT-DM-0054), emitted only
    // when no specific defect exists. `withBaseline: false` simulates it being
    // absent, to prove reconciliation CATCHES the resulting coverage gap.
    if (!withBaseline) {
        for (const t of analysis.tradelines) {
            t.findings = t.findings.filter((f) => f.code !== "TL_BASELINE_REINVESTIGATION");
        }
    }

    const decisions = await decideDisputes(analysis, { report });

    const strategies = await selectStrategy(decisions, {});
    const chain = await buildDisputeChain(strategies);
    const letters = await generateLetters(chain, analysis, {
        clientIdentity: identity, letterDate: ASOF, report, firstProductionValidation: true,
    });

    const recon = reconcile({ report, analysis, decisions, strategies, letters });

    return { analysis, decisions, strategies, chain, letters, recon };
}

console.log("\n=== WITH the baseline path: every eligible negative is covered ===\n");

const full = await run({ withBaseline: true });
const tu = full.recon.byBureau.find((b) => b.bureau === "transunion");
const journey = (k) => full.recon.journeys.find((j) => j.stableItemKey === k);

check("RECONCILES", full.recon.reconciles, true);
check("coverage holds", full.recon.coverageHolds, true);
check("no coverage violations", tu.coverage.violations.length, 0);

console.log("\n--- Each negative exits through exactly one legal door ---");

check("clean charge-off -> BASELINE", journey("bt_tl_syn_tu").exitCategory, EXIT.BASELINE_REINVESTIGATION);
check("Metro 2 defect -> SPECIFIC_STRATEGY", journey("bt_tl_navy_tu").exitCategory, EXIT.SPECIFIC_STRATEGY);
check("authorized user -> EXCLUDED", journey("bt_tl_au_tu").exitCategory, EXIT.EXCLUDED);
check("no account number -> WITHHELD", journey("bt_tl_nomask_tu").exitCategory, EXIT.WITHHELD);
check("positive account -> NOT disputed", journey("bt_tl_good_tu").disputed, false);

check("4 negatives, all covered", tu.coverage.covered, 4);
check("...1 specific", tu.coverage.specificStrategy, 1);
check("...1 baseline", tu.coverage.baselineReinvestigation, 1);
check("...1 excluded", tu.coverage.excluded, 1);
check("...1 withheld", tu.coverage.withheld, 1);

console.log("\n--- No duplicate sections: specific supersedes baseline ---");

const navySections = full.letters.letters
    .flatMap((l) => l.accountSections)
    .filter((s) => s.stableItemKey === "bt_tl_navy_tu");

check("Metro 2 item gets exactly ONE section", navySections.length, 1);
check("...and it is NOT the baseline wording", !!navySections[0].baseline, false);

const synSections = full.letters.letters
    .flatMap((l) => l.accountSections)
    .filter((s) => s.stableItemKey === "bt_tl_syn_tu");

check("clean charge-off gets exactly ONE section", synSections.length, 1);
check("...and it IS the baseline path", synSections[0].baseline, true);

console.log("\n--- The baseline letter asserts nothing it has not proven ---");

const body = synSections[0].text;

check("disputes completeness AND accuracy", body.includes("completeness and accuracy"), true);
check("requests a reasonable reinvestigation", /reasonable reinvestigation/i.test(body), true);
check("conditions the remedy on verification", /delete the item if it cannot be verified or accurately corrected/i.test(body), true);
check("remedy does NOT use the prohibited 'only' clause", /delete the item only if/i.test(body), false);
check("does NOT claim it is inaccurate", /is inaccurate|is false|is incorrect/i.test(body), false);
check("does NOT claim it is unverifiable", /cannot be verified\.|is unverifiable/i.test(body), false);
check("cites § 611", body.includes("§ 611"), true);
check("carries the bureau's account number", body.includes("****8812"), true);

console.log("\n=== WITHOUT baseline: reconciliation must CATCH the omission ===\n");

// A coverage rule that cannot detect its own breach is decoration. Skip the
// baseline step and confirm the clean charge-off is reported as a VIOLATION —
// not quietly summarised as "No findings" the way it used to be.
const broken = await run({ withBaseline: false });
const tuBroken = broken.recon.byBureau.find((b) => b.bureau === "transunion");

check("RECONCILES is NO", broken.recon.reconciles, false);
check("coverage does NOT hold", broken.recon.coverageHolds, false);
check("BOTH no-defect negatives reported", tuBroken.coverage.violations.length, 2);
check("...naming SYNCHRONY BANK", tuBroken.coverage.violations.some((v) => v.furnisher === "SYNCHRONY BANK"), true);
check("...as a POLICY_VIOLATION", broken.recon.journeys.find((j) => j.stableItemKey === "bt_tl_syn_tu").exitCategory, EXIT.POLICY_VIOLATION);
check("...and flagged as a bug", broken.recon.journeys.find((j) => j.stableItemKey === "bt_tl_syn_tu").bug, true);
check("...covered count falls short", tuBroken.coverage.covered, 2);

console.log("\n=== First production validation: every letter reviewed ===\n");

check("every letter requires review", full.letters.letters.every((l) => l.requiresHumanReview), true);
check("...for the right reason", full.letters.letters[0].reviewReason, "FIRST_PRODUCTION_VALIDATION");

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
