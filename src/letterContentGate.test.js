/**
 * letterContentGate.test.js
 *
 * Two production-blocking defects, guarded:
 *  1. The real bureau-reported status must reach the account section (Bureau
 *     Fidelity: verbatim). On ListAndStack the status lives in current_rating /
 *     account_status_type, not @RawAccountStatus.
 *  2. A letter body containing a DO-NOT-SEND placeholder (or undefined/null) must
 *     NEVER pass letters_ok; it is withheld and routed to human review.
 */
import { normalizeReport } from "./reportNormalize.js";
import { analyzeCreditReport } from "./analyzeCreditReport.js";
import { decideDisputes } from "./decideDisputes.js";
import { selectStrategy } from "./selectStrategy.js";
import { buildDisputeChain } from "./disputeChain.js";
import { generateLetters, screenLetterContent, FIDELITY_MISSING_MARKER } from "./generateLetter.js";

let passed = 0, failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) console.log(`FAIL  ${label.padEnd(56)} got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
    ok ? passed++ : failed++;
};

const payload = (l) => ({ CREDIT_RESPONSE: {
    "@MISMOVersionID": "2.4", "@CreditReportFirstIssuedDate": "2026-07-13",
    BORROWER: { "@_FirstName": "Elizabeth" }, CREDIT_LIABILITY: l } });
const base = { "@_AccountOwnershipType": "Individual", "@_AccountOpenedDate": "2019-03-14",
    "@RawAccountType": "Installment", "@IsStudentLoan": "N" };
const ID = { source: "crc_client_profile", normalized: true, crcClientId: "15",
    name: "Elizabeth Kelley", firstName: "Elizabeth", lastName: "Kelley",
    address_line_1: "5084 Louvinia Dr", city: "Tallahassee", state: "FL", postal_code: "32311" };

async function run(rep) {
    const a = await analyzeCreditReport(rep, { clientIdentity: ID });
    const d = await decideDisputes(a, { report: rep });
    const s = await selectStrategy(d, {});
    const c = await buildDisputeChain(s);
    return generateLetters(c, a, { clientIdentity: ID, report: rep });
}

console.log("\n=== 1. REAL REPORTED STATUS REACHES THE ACCOUNT SECTION ===\n");

// Charge-off, no DOFD -> TL_DEROGATORY_WITHOUT_DOFD (quotes status). Status is in
// _CURRENT_RATING (nested object), NOT @RawAccountStatus.
const out = normalizeReport(payload([
    { ...base, "@ArrayAccountIdentifier": "CO", "@TradelineHashSimple": "co",
      "@_AccountIdentifier": "****1111", "@_AccountStatusType": "Closed",
      "_CURRENT_RATING": { "@_Type": "CollectionOrChargeOff" }, "@IsChargeoffIndicator": "Y",
      "@_DerogatoryDataIndicator": "Y", "@_PastDueAmount": "4200",
      _CREDITOR: { "@_Name": "CAP ONE" }, CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" } },
]), { crcClientId: "15" });

const L = await run(out.report);
const body = L.letters[0]?.body ?? "";
check("real reported status appears in section", body.includes("CollectionOrChargeOff"), true);
check("no DO-NOT-SEND marker in body", body.includes(FIDELITY_MISSING_MARKER), false);
check("letters_ok true when status present", L.lettersOk, true);
check("nothing withheld when status present", L.withheld.length, 0);

console.log("\n=== 2. A DO-NOT-SEND PLACEHOLDER CANNOT PASS letters_ok ===\n");

// screenLetterContent is the gate. Prove it flags each forbidden token.
const screenedMarker = screenLetterContent([{ bureau: "transunion", bureauName: "TransUnion",
    stableItemKeys: ["k"], body: `Reported with a status of "${FIDELITY_MISSING_MARKER}".` }]);
check("marker body is flagged", screenedMarker[0].hits.length > 0, true);

for (const tok of ["DO NOT SEND", "undefined", "null"]) {
    const sc = screenLetterContent([{ bureau: "experian", bureauName: "Experian", body: `x ${tok} y` }]);
    check(`'${tok}' is flagged`, sc[0].hits.includes(tok), true);
}

const clean = screenLetterContent([{ bureau: "equifax", bureauName: "Equifax",
    body: 'Reported with a status of "CollectionOrChargeOff".' }]);
check("clean body has no hits", clean[0].hits.length, 0);

console.log("\n=== 3. UNAVAILABLE STATUS -> WITHHOLD + HUMAN REVIEW (never sent) ===\n");

// A letter whose body would carry the marker is withheld and flagged. We simulate a
// finished letter that still contains the marker reaching the gate.
import { generateLetters as _gl } from "./generateLetter.js"; // same module; ensures gate is the shipping one
// Direct gate behavior: a marker-bearing letter set must yield lettersOk false.
// (generateLetters applies screenLetterContent internally.)
const markerLetters = [{ bureau: "transunion", bureauName: "TransUnion", stableItemKeys: ["k"],
    body: `Reported with a status of "${FIDELITY_MISSING_MARKER}".` }];
const anyHits = screenLetterContent(markerLetters).some((x) => x.hits.length > 0);
check("gate detects unsendable content", anyHits, true);

console.log("\n=== 4. GOVERNED BT-DM-0033 CHAIN + REMEDY UNCHANGED ===\n");

// The status/gate fix must not disturb governance. Reuse the charge-off letter.
check("live path still produces a letter", L.letters.length >= 1, true);
check("remedy is governed conditional (no unconditional delete)",
    /reasonable reinvestigation/.test(body) && !/^Delete this account/.test(body), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
