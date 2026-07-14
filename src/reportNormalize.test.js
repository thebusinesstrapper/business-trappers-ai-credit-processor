/**
 * reportNormalize.test.js
 * Run: node src/reportNormalize.test.js
 */

import { readFileSync } from "fs";
import { normalizeReport, BASIS, MODEL_VERSION } from "./reportNormalize.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(60)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

/** A liability with every REQUIRED field present, so tests isolate one thing at a time. */
const liability = (over = {}) => ({
    "@ArrayAccountIdentifier": "ARR-1",
    "@TradelineHashSimple": "h1",
    "@_AccountIdentifier": "****6095",
    "@_AccountOwnershipType": "Individual",
    "@_AccountOpenedDate": "2019-03-14",
    "@_UnpaidBalanceAmount": "4200",
    "@RawAccountStatus": "O",
    "@RawAccountType": "Installment",
    "@IsClosedIndicator": "N",
    "@IsChargeoffIndicator": "N",
    "@IsCollectionIndicator": "N",
    "@IsStudentLoan": "N",
    _CREDITOR: { "@_Name": "NAVY FEDERAL CR UNION" },
    CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" },
    ...over,
});

const payload = (liabilities) => ({
    CREDIT_RESPONSE: {
        "@MISMOVersionID": "2.4",
        "@CreditReportFirstIssuedDate": "2026-07-13",
        BORROWER: { "@_FirstName": "Elizabeth" },
        CREDIT_LIABILITY: liabilities,
    },
});

console.log("\n=== THE BASIS RULE — THE HEART OF THE AMENDMENT ===\n");

const mixed = normalizeReport(payload([
    // One bureau -> the value IS TransUnion's.
    liability({ "@ArrayAccountIdentifier": "ARR-1", "@TradelineHashSimple": "h1" }),

    // Three bureaus, ONE value. Array asserts it for the group. No individual
    // bureau asserted it to us.
    liability({
        "@ArrayAccountIdentifier": "ARR-2", "@TradelineHashSimple": "h2",
        "@_UnpaidBalanceAmount": "9000",
        CREDIT_REPOSITORY: [
            { "@_SourceType": "TransUnion" },
            { "@_SourceType": "Experian" },
            { "@_SourceType": "Equifax" },
        ],
    }),
]), { crcClientId: "15" });

check("extraction succeeds", mixed.extraction_ok, true);
check("model version", mixed.report.model_version, MODEL_VERSION);

const all = mixed.report.accounts.flatMap((a) => a.bureau_tradelines);
const single = all.find((t) => t.observation.balance === 4200);
const shared = all.filter((t) => t.observation.balance === 9000);

check("single-bureau -> BUREAU_SPECIFIC", single.observation.basis, BASIS.BUREAU_SPECIFIC);
check("...shared_with is null", single.observation.shared_with, null);

check("3-bureau liability -> 3 tradelines", shared.length, 3);
check("...each SHARED_ACROSS_BUREAUS", shared.every((t) => t.observation.basis === BASIS.SHARED_ACROSS_BUREAUS), true);
check("...each names the OTHER two", shared[0].observation.shared_with.length, 2);
check("...but the VALUE IS PRESERVED", shared[0].observation.balance, 9000);

// Nothing is discarded. We keep the value AND the truth about its attributability.
check("every tradeline has a distinct key", new Set(all.map((t) => t.stable_item_key)).size, all.length);

console.log("\n=== (ACCOUNT, BUREAU) COLLISION FAILS CLOSED ===\n");

// Both shapes coexist in the real payload, so ONE bureau can report ONE account
// through TWO liabilities: a merged {TU, EXP} row AND a separate {TU} row.
// That yields two TransUnion tradelines for one account -> two letters about the
// same item, or a reconciliation that double-counts.
const collision = normalizeReport(payload([
    liability({
        "@ArrayAccountIdentifier": "ARR-9", "@TradelineHashSimple": "hA",
        CREDIT_REPOSITORY: [{ "@_SourceType": "TransUnion" }, { "@_SourceType": "Experian" }],
    }),
    liability({
        "@ArrayAccountIdentifier": "ARR-9", "@TradelineHashSimple": "hB",
        CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" },   // TU again, same account
    }),
]), { crcClientId: "15" });

check("collision -> extraction_ok FALSE", collision.extraction_ok, false);
check("...names the colliding bureau", /COLLISION/.test(collision.errors[0]), true);
check("...refuses to merge or choose", /rather than merging or choosing/.test(collision.errors[0]), true);
check("...records it for manual review", collision.key_resolution.tradelines.ambiguous.length, 1);

console.log("\n=== REQUIRED FIELDS: HARD STOP, NOT A WARNING ===\n");

// The Constitution forbids disputing authorized-user accounts. Without a
// responsibility value we CANNOT identify them — and a missing value must NEVER
// be read as "not an authorized user."
const noOwnership = normalizeReport(payload([
    (() => { const l = liability(); delete l["@_AccountOwnershipType"]; return l; })(),
]), { crcClientId: "15" });

check("missing responsibility -> extraction_ok FALSE", noOwnership.extraction_ok, false);
check("...explains the AU prohibition", /authorized-user/i.test(noOwnership.errors[0]), true);
check("...and refuses the unsafe default", /never be read as "not an authorized user/.test(noOwnership.errors[0]), true);

const noAccount = normalizeReport(payload([
    (() => { const l = liability(); delete l["@_AccountIdentifier"]; return l; })(),
]), { crcClientId: "15" });

check("missing masked account -> HARD STOP", noAccount.extraction_ok, false);

console.log("\n=== NORMALIZATION EMITS FACTS. IT DECIDES NOTHING. ===\n");

// A CLOSED account is not automatically non-disputable. "Closed" is a STATUS.
// Eligibility belongs to the Strategy Engine.
const closedPositive = normalizeReport(payload([
    liability({
        "@IsClosedIndicator": "Y",
        "@_UnpaidBalanceAmount": "0",
        "@RawAccountStatus": "C",
        "@IsChargeoffIndicator": "N",
    }),
]), { crcClientId: "15" });

const closedTl = closedPositive.report.accounts[0].bureau_tradelines[0];

check("a CLOSED, ZERO-BALANCE account is still EMITTED", closedPositive.report.accounts.length, 1);
check("...is_closed captured as a FACT", closedTl.observation.is_closed, true);
check("...zero balance is 0, NOT null", closedTl.observation.balance, 0);

// Business Trappers policy: DoE / Aidvantage student loans are disputable EVEN
// WHEN REPORTING POSITIVELY. That policy is NOT inferred here — the normalizer
// emits the indicators and the Strategy Engine applies the rule. A normalizer that
// dropped "positive" accounts would make the policy unimplementable, invisibly.
const studentLoan = normalizeReport(payload([
    liability({
        "@IsStudentLoan": "Y",
        "@IsFedGuaranteedStudentLoan": "Y",
        "@IsChargeoffIndicator": "N",
        "@_PastDueAmount": "0",
        _CREDITOR: { "@_Name": "DEPT OF EDUCATION/AIDVANTAGE" },
    }),
]), { crcClientId: "15" });

const sl = studentLoan.report.accounts[0].bureau_tradelines[0];

check("positively-reporting student loan is EMITTED", studentLoan.report.accounts.length, 1);
check("...is_student_loan captured", sl.observation.is_student_loan, true);
check("...federal guarantee captured", sl.observation.is_fed_guaranteed_student_loan, true);

// The proof of separation: the normalizer has no vocabulary for eligibility.
const src = readFileSync(new URL("./reportNormalize.js", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

check("no 'negative' classification in code", /isNegative|is_negative|negativeItems/.test(src), false);
// NARROW, DELIBERATELY. The word "eligibility" appears legitimately in the note
// string that EXPLAINS why eligibility is not computed here. A guardrail that
// fires on innocent prose is one people learn to override — and then it protects
// nothing. So we test for eligibility LOGIC, not for a word.
check("no eligibility FUNCTION defined", /function \w*(eligib|disputab|negativ)\w*\s*\(/i.test(src), false);
check("no eligibility branch on indicators", /if\s*\([^)]*is_chargeoff[^)]*\)|if\s*\([^)]*is_collection[^)]*\)/.test(src), false);
check("no negative/positive classification", /isNegative|is_negative|negativeItems|positiveAccounts/.test(src), false);
check("does not import a decision engine", /decideDisputes|selectStrategy/.test(src), false);
check("does not import Playwright", /playwright/i.test(src), false);

console.log("\n=== THE COUNTS ARE SEPARATED ===\n");

check("raw liability rows", mixed.counts.raw_liability_rows, 2);
check("unique accounts", mixed.counts.unique_accounts, 2);
check("account x bureau tradelines", mixed.counts.account_bureau_tradelines, 4);
check("...which is NOT the row count", mixed.counts.account_bureau_tradelines !== mixed.counts.raw_liability_rows, true);
check("bureau-specific observations", mixed.counts.observations_bureau_specific, 1);
check("shared observations", mixed.counts.observations_shared, 3);

// #4 and #5 are deliberately absent — computing them here would put eligibility
// inside the normalizer, the exact coupling that was ruled out.
check("does NOT report eligible-negative count", "eligible_negative_tradelines" in mixed.counts, false);
check("does NOT report excluded count", "excluded_tradelines" in mixed.counts, false);
check("...and says why", /Eligibility is determined by the Strategy Engine/.test(mixed.counts.note), true);

console.log("\n=== NEVER INFER, NEVER DEFAULT ===\n");

// A field we cannot read is null. NEVER 0 — zero is a fact, absence is not.
// Extraction §6.1: a fabricated balance becomes a fabricated fact in a letter.
const sparse = normalizeReport(payload([
    (() => { const l = liability(); delete l["@_PastDueAmount"]; return l; })(),
]), { crcClientId: "15" });

check("unreadable number -> null, not 0", sparse.report.accounts[0].bureau_tradelines[0].observation.past_due, null);
check("...and the miss is recorded", sparse.completeness.fields_not_found.includes("past_due"), true);

// An unrecognised bureau is never guessed.
const badBureau = normalizeReport(payload([
    liability({ CREDIT_REPOSITORY: { "@_SourceType": "TotallyUnknownBureau" } }),
]), { crcClientId: "15" });

check("unknown bureau -> no tradeline emitted", badBureau.counts.account_bureau_tradelines, 0);
check("...and it is warned about", badBureau.completeness.warnings.some((w) => /no recognisable bureau/.test(w)), true);

console.log("\n=== NO RELATIONSHIP IS INVENTED ===\n");

// Without @ArrayAccountIdentifier there is NO correlation evidence. We do NOT fall
// back to furnisher-name matching — the furnisher name is not identity evidence
// across bureaus, and a wrong merge corrupts dispute memory irreversibly.
const noArrayId = normalizeReport(payload([
    (() => { const l = liability({ "@TradelineHashSimple": "x1" }); delete l["@ArrayAccountIdentifier"]; return l; })(),
    (() => { const l = liability({ "@TradelineHashSimple": "x2", CREDIT_REPOSITORY: { "@_SourceType": "Experian" } }); delete l["@ArrayAccountIdentifier"]; return l; })(),
]), { crcClientId: "15" });

check("same furnisher, no array id -> NOT merged", noArrayId.counts.unique_accounts, 2);
check("...and it says so", noArrayId.completeness.warnings.some((w) => /invent a relationship/.test(w)), true);

console.log("\n=== IDENTITY IS EVIDENCE, NEVER IDENTITY ===\n");

// CRC is authoritative for consumer identity. Nothing downstream may populate a
// letter header from the report.
check("BORROWER kept under reported_personal_information", !!mixed.report.reported_personal_information.raw, true);
check("crc_client_id is a TAG only", mixed.report.crc_client_id, "15");

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
