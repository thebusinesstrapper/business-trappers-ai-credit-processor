/**
 * statusContract.test.js
 *
 * Regression for the field-contract fix: the live report carries status in
 * @_AccountStatusType / _CURRENT_RATING, NOT @RawAccountStatus. Before the fix,
 * normalized.status was null, so every tradeline classified non-negative
 * (negativeTradelines: 0, letters: []). This proves the end-to-end classification:
 * charge-off + lates become actionable; a clean positive stays NO_ACTION; and the
 * report date reaches the analysis summary.
 */
import { normalizeReport } from "./reportNormalize.js";
import { analyzeCreditReport } from "./intelligence/analyzeCreditReport.js";
import { decideDisputes } from "./intelligence/decideDisputes.js";

let passed = 0, failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)} -> ${String(actual)}`);
    ok ? passed++ : failed++;
};

const payload = (l) => ({ CREDIT_RESPONSE: {
    "@MISMOVersionID": "2.4", "@CreditReportFirstIssuedDate": "2026-07-13",
    BORROWER: { "@_FirstName": "Elizabeth" }, CREDIT_LIABILITY: l } });
const base = { "@_AccountOwnershipType": "Individual", "@_AccountOpenedDate": "2019-03-14",
    "@RawAccountType": "Installment", "@IsStudentLoan": "N" };

// NOTE: no @RawAccountStatus anywhere — exactly the live-report shape.
const out = normalizeReport(payload([
    { ...base, "@ArrayAccountIdentifier": "CO", "@TradelineHashSimple": "co",
      "@_AccountIdentifier": "****1111", "@_AccountStatusType": "Closed",
      "_CURRENT_RATING": { "@_Type": "CollectionOrChargeOff" }, "@IsChargeoffIndicator": "Y",
      "@_DerogatoryDataIndicator": "Y", "@_PastDueAmount": "4200",
      "@_FirstDelinquencyDate": "2022-01-10",
      _CREDITOR: { "@_Name": "CAP ONE AUTO" }, CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" } },
    { ...base, "@ArrayAccountIdentifier": "LT", "@TradelineHashSimple": "lt",
      "@_AccountIdentifier": "****2222", "@_AccountStatusType": "Open",
      "_CURRENT_RATING": { "@_Type": "Late30Days" }, "@IsClosedIndicator": "N",
      "@_DerogatoryDataIndicator": "Y",
      "_LATE_COUNT": { "@_30Days": "2", "@_60Days": "1" },
      _CREDITOR: { "@_Name": "BARCLAYS BANK DELAWARE" }, CREDIT_REPOSITORY: { "@_SourceType": "Experian" } },
    { ...base, "@ArrayAccountIdentifier": "CL", "@TradelineHashSimple": "cl",
      "@_AccountIdentifier": "****3333", "@_AccountStatusType": "Open",
      "_CURRENT_RATING": { "@_Type": "Current" }, "@IsClosedIndicator": "N", "@IsChargeoffIndicator": "N",
      "@_DerogatoryDataIndicator": "N", "@_PastDueAmount": "0",
      _CREDITOR: { "@_Name": "NAVY FEDERAL CR UNION" }, CREDIT_REPOSITORY: { "@_SourceType": "Equifax" } },
]), { crcClientId: "15" });

console.log("\n=== STATUS POPULATES FROM THE REAL FIELDS ===\n");
const [co, lt, cl] = out.report.accounts
    .sort((a, b) => a.array_account_identifier.localeCompare(b.array_account_identifier))
    .map((a) => a.bureau_tradelines[0]);
// sorted: CL, CO, LT
const byId = Object.fromEntries(out.report.accounts.map(a => [a.array_account_identifier, a.bureau_tradelines[0]]));
check("charge-off status = CollectionOrChargeOff", byId.CO.observation.normalized.status, "CollectionOrChargeOff");
check("late status = Late30Days", byId.LT.observation.normalized.status, "Late30Days");
check("clean status = Current", byId.CL.observation.normalized.status, "Current");
check("no status is [object Object]", [byId.CO, byId.LT, byId.CL].every(t => t.observation.normalized.status !== "[object Object]"), true);

const a = await analyzeCreditReport(out.report, { clientIdentity: { crcClientId: "15", state: "FL" } });

console.log("\n=== REPORT DATE REACHES THE SUMMARY ===\n");
check("analysis reportDate is 2026-07-13", a.clientSummary?.reportDate, "2026-07-13");

console.log("\n=== NEGATIVITY CLASSIFICATION IS CORRECT ===\n");
const d = await decideDisputes(a, { report: out.report });
const outcome = (id) => d.itemDecisions.find(x => x.stableItemKey === byId[id].bureau_tradelines?.[0]?.stable_item_key || x.stableItemKey === byId[id].stable_item_key)?.outcome;
check("charge-off is actionable (not NO_ACTION)", outcome("CO") !== "NO_ACTION" && outcome("CO") !== undefined, true);
check("late account is actionable (not NO_ACTION)", outcome("LT") !== "NO_ACTION" && outcome("LT") !== undefined, true);
check("clean positive stays NO_ACTION", outcome("CL"), "NO_ACTION");

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
