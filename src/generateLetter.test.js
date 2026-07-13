/**
 * generateLetter.test.js
 * Run: node src/intelligence/generateLetter.test.js
 *
 * THE ANALYSIS ENGINE EXPLAINS. THE LETTER ENGINE ASSERTS.
 *
 * These tests enforce the three rules, and they check the GENERATED TEXT — not
 * the intent behind it. A leak rule that only checks what we meant to write
 * catches nothing.
 */

import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes } from "./decideDisputes.js";
import { selectStrategy } from "./selectStrategy.js";
import { buildDisputeChain } from "./disputeChain.js";
import { generateLetters } from "./generateLetter.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(64)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

const ASOF = new Date("2026-07-13T00:00:00Z");

const clientIdentity = {
    name: "Elizabeth Kelley",
    address: "1420 Meridian Road\nTallahassee, FL 32303",
};

// One account. TU masks it "****6095"; Experian masks it "6095XXXXXXXX".
// TU says Charge-off; Experian says Current.
const report = {
    extraction_ok: true,
    crc_client_id: 15,
    reported_personal_information: { names: ["ELIZABETH KELLEY"], ssns: ["123-45-6789"], dates_of_birth: ["1980-04-02"] },
    accounts: [{
        stable_account_key: "bt_ac_navy",
        bureau_tradelines: [
            {
                stable_item_key: "bt_tl_tu", bureau: "transunion",
                furnisher: "NAVY FEDERAL CR UNION", masked_account: "****6095",
                observation: {
                    status: "Charge-off", balance: 0, past_due: 4200,
                    responsibility: "Individual", date_opened: "2019-03-14",
                    date_of_first_delinquency: null,
                },
            },
            {
                stable_item_key: "bt_tl_exp", bureau: "experian",
                furnisher: "NAVY FCU", masked_account: "6095XXXXXXXX",
                observation: {
                    status: "Current", balance: 4200, past_due: 0,
                    responsibility: "Individual", date_opened: "2019-03-14",
                },
            },
        ],
    }],
    collections: [], inquiries: [], public_records: [],
};

async function run(rpt = report, extra = {}) {
    const analysis = await analyzeCreditReport(rpt, { clientIdentity, asOf: ASOF });
    const decisions = await decideDisputes(analysis, { report: rpt });
    const strategies = await selectStrategy(decisions, extra);
    const chain = await buildDisputeChain(strategies);
    return generateLetters(chain, analysis, { clientIdentity, letterDate: ASOF, report: rpt });
}

const result = await run();
const L = (b) => result.letters.find((l) => l.bureau === b);

console.log("\n=== RULE 1: cross-bureau evidence is INTERNAL ONLY ===\n");

check("letters generated", result.letters.length, 2);
check("leak check PASSES", result.summary.crossBureauLeakCheck, "PASS");
check("lettersOk", result.lettersOk, true);

const tu = L("transunion");
const exp = L("experian");

// Checked against the GENERATED BODY. This is the assertion that matters.
check("TU letter never says 'Experian'", tu.body.includes("Experian"), false);
check("TU letter never says 'Equifax'", tu.body.includes("Equifax"), false);
check("Experian letter never says 'TransUnion'", exp.body.includes("TransUnion"), false);

console.log("\n--- Cross-bureau conflicts are DISPUTED, never ASSERTED ---");

// We know ONE bureau is wrong. We do NOT know it is this one. Claiming this
// bureau's value is false would invent a fact.
check("Experian letter DISPUTES accuracy", exp.body.includes("I dispute the accuracy"), true);
check("...and does NOT assert the value is false", /is inaccurate|is false|is incorrect/i.test(exp.body), false);
check("...cites reinvestigation, not accusation", exp.body.includes("§ 611"), true);

console.log("\n--- Self-evident defects ARE asserted ---");

check("TU asserts the zero-balance contradiction", tu.body.includes("past-due amount of $4,200 and a balance of $0"), true);
check("...states the standard it fails", tu.body.includes("cannot carry an amount past due"), true);

console.log("\n=== RULE 2: concise. No reasoning, no narration ===\n");

check("no 'Analysis' narration", /analysis engine|our engine|we found|we determined/i.test(tu.body), false);
check("no evidence-class leakage", /SELF_EVIDENT|CROSS_BUREAU|BT-DM-|BT-ST-|BT-RN-/i.test(tu.body), false);
check("no confidence/automation talk", /confidence|automation|escalation earned/i.test(tu.body), false);

// ONE authority per account. Stacking reads as intimidation and dilutes the one
// that governs.
const authCount = (tu.body.match(/FCRA §/g) ?? []).length;
check("exactly ONE statute cited per account", authCount, 1);
check("...the STRONGEST applicable (DOFD, not accuracy)", tu.body.includes("§ 605(c)"), true);

// No repeated sentence structure.
const disputeLines = (exp.body.match(/I dispute the accuracy/g) ?? []).length;
check("cross-bureau disputes collapse to ONE sentence", disputeLines, 1);
check("...naming all disputed fields", exp.body.includes("balance, past-due amount and status"), true);

console.log("\n=== RULE 3: the bureau's OWN account number ===\n");

check("TU letter carries TU's masking", tu.body.includes("Account Number: ****6095"), true);
check("Experian letter carries EXPERIAN's masking", exp.body.includes("Account Number: 6095XXXXXXXX"), true);
check("TU never shows Experian's format", tu.body.includes("6095XXXXXXXX"), false);
check("Experian never shows TU's format", exp.body.includes("****6095"), false);

console.log("\n--- An account we cannot identify is an account we do not send ---");

const noMask = JSON.parse(JSON.stringify(report));
noMask.accounts[0].bureau_tradelines[0].masked_account = null;

const withheldResult = await run(noMask);
const tuWithheld = withheldResult.letters.find((l) => l.bureau === "transunion");

check("no account number -> item WITHHELD", withheldResult.summary.itemsWithheld, 1);
check("...and no TransUnion letter is sent", tuWithheld, undefined);
check("...withholding reason recorded", withheldResult.withheld[0].reason.includes("cannot identify"), true);

console.log("\n=== Identity comes from CRC, never the report ===\n");

const noIdentity = await generateLetters(
    await buildDisputeChain(await selectStrategy(await decideDisputes(await analyzeCreditReport(report, { asOf: ASOF }), { report }), {})),
    await analyzeCreditReport(report, { asOf: ASOF }),
    { report }
);

check("no CRC identity -> NO letters", noIdentity.lettersOk, false);
check("...and none generated", noIdentity.letters.length, 0);
check("...reason stated", noIdentity.errors[0].includes("evidence, never identity"), true);

console.log("\n=== Determinism ===\n");

const a = await run();
const b = await run();
check("identical input -> byte-identical letters", JSON.stringify(a.letters) === JSON.stringify(b.letters), true);

console.log("\n=== THE EXPERIAN LETTER (cross-bureau only) ===\n");
console.log(exp.body);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
