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
const single = all.find((t) => t.observation.normalized.balance === 4200);
const shared = all.filter((t) => t.observation.normalized.balance === 9000);

check("single-bureau -> BUREAU_SPECIFIC", single.observation.basis, BASIS.BUREAU_SPECIFIC);
check("...shared_with is null", single.observation.shared_with, null);

check("3-bureau liability -> 3 tradelines", shared.length, 3);
check("...each SHARED_ACROSS_BUREAUS", shared.every((t) => t.observation.basis === BASIS.SHARED_ACROSS_BUREAUS), true);
check("...each names the OTHER two", shared[0].observation.shared_with.length, 2);
check("...but the normalized VALUE IS PRESERVED", shared[0].observation.normalized.balance, 9000);
// LAYER 2: the reported string is kept verbatim alongside the normalized number.
check("...and the REPORTED string is verbatim", shared[0].observation.reported.balance, "9000");

// Nothing is discarded. We keep the value AND the truth about its attributability.
check("every tradeline has a distinct key", new Set(all.map((t) => t.stable_item_key)).size, all.length);

console.log("\n=== FOLD ON IDENTITY: MERGED + SINGLE IS ONE TRADELINE ===\n");

// The legal unit is the BUREAU TRADELINE, not Array's row. Array serialises one
// TransUnion tradeline as a merged {TU, EXP} row AND a separate {TU} row in the
// same report. Both describe the SAME TransUnion tradeline. This is ~30 of the 32
// production collisions. It is the NORMAL case — fold, do not reject.
//
// Identity = bureau + masked-last-4 + normalized furnisher. Same masked account,
// same furnisher -> same tradeline, even though the hashes and shapes differ.
const fold = normalizeReport(payload([
    liability({
        "@ArrayAccountIdentifier": "ARR-9", "@TradelineHashSimple": "hMERGED",
        "@_AccountIdentifier": "****6095",
        "@_UnpaidBalanceAmount": "4200",
        CREDIT_REPOSITORY: [{ "@_SourceType": "TransUnion" }, { "@_SourceType": "Experian" }],
    }),
    liability({
        "@ArrayAccountIdentifier": "ARR-9", "@TradelineHashSimple": "hSINGLE",
        "@_AccountIdentifier": "****6095",
        "@_UnpaidBalanceAmount": "4200",
        CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" },   // same TU tradeline
    }),
]), { crcClientId: "15" });

check("folds cleanly -> extraction_ok TRUE", fold.extraction_ok, true);

// The account has Experian (merged) + TransUnion (folded) = 2 bureau tradelines,
// NOT 3. The two TU observations became ONE TU tradeline.
const foldAcct = fold.report.accounts.find((a) => a.array_account_identifier === "ARR-9");
const tuTradelines = foldAcct.bureau_tradelines.filter((t) => t.bureau === "transunion");
check("TransUnion collapses to ONE tradeline", tuTradelines.length, 1);
check("...fold recorded in key_resolution", fold.key_resolution.tradelines.folded, 1);

// BUREAU-SPECIFIC WINS. The single-{TU} row is TU's own reporting; the merged
// row's value is SHARED. The primary observation must be the bureau-specific one.
check("bureau-specific observation wins", tuTradelines[0].observation.basis, BASIS.BUREAU_SPECIFIC);

// THE LOSER IS NOT DISCARDED. The merged (shared) observation is kept as evidence.
check("the folded-away observation is preserved", tuTradelines[0].folded_observations.length, 1);
check("...it was the SHARED one", tuTradelines[0].folded_observations[0].basis, BASIS.SHARED_ACROSS_BUREAUS);

console.log("\n=== SAME BUREAU + DIFFERENT LAST-4 -> SEPARATE, NOT CONFLICT ===\n");

// Same Array id + bureau, DIFFERENT masked last-4. Per the corrected rule, a
// reused @ArrayAccountIdentifier that maps to different last-4 values is unreliable
// for grouping: these are SEPARATE accounts, kept as separate tradelines. They do
// NOT fail closed and do NOT route to manual review. (This is the Aidvantage shape.)
const twoAccounts = normalizeReport(payload([
    liability({
        "@ArrayAccountIdentifier": "ARR-X", "@TradelineHashSimple": "h1",
        "@_AccountIdentifier": "****1111",
        CREDIT_REPOSITORY: { "@_SourceType": "Equifax" },
    }),
    liability({
        "@ArrayAccountIdentifier": "ARR-X", "@TradelineHashSimple": "h2",
        "@_AccountIdentifier": "****9999",              // DIFFERENT last-4
        CREDIT_REPOSITORY: { "@_SourceType": "Equifax" },
    }),
]), { crcClientId: "15" });

check("different last-4 -> extraction_ok TRUE", twoAccounts.extraction_ok, true);
check("...NOT manual review", twoAccounts.key_resolution.tradelines.ambiguous.length, 0);
const twoAcct = twoAccounts.report.accounts.find((a) => a.array_account_identifier === "ARR-X");
const eq = twoAcct.bureau_tradelines.filter((t) => t.bureau === "equifax");
check("...two separate Equifax tradelines", eq.length, 2);

// A differing HASH alone is NOT an identity conflict — the hash is change
// detection and drifts on the same tradeline by design. Same number + furnisher
// with different hashes must still fold.
const hashDrift = normalizeReport(payload([
    liability({ "@ArrayAccountIdentifier": "ARR-H", "@TradelineHashSimple": "hAAA",
        "@_AccountIdentifier": "****5555", CREDIT_REPOSITORY: { "@_SourceType": "Equifax" } }),
    liability({ "@ArrayAccountIdentifier": "ARR-H", "@TradelineHashSimple": "hBBB",
        "@_AccountIdentifier": "****5555", CREDIT_REPOSITORY: { "@_SourceType": "Equifax" } }),
]), { crcClientId: "15" });

check("hash drift alone still FOLDS", hashDrift.extraction_ok, true);
check("...to one Equifax tradeline", hashDrift.report.accounts.find((a) => a.array_account_identifier === "ARR-H").bureau_tradelines.filter((t) => t.bureau === "equifax").length, 1);

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
check("...is_closed captured as a FACT", closedTl.observation.normalized.is_closed, true);
check("...zero balance is 0, NOT null", closedTl.observation.normalized.balance, 0);
check("...and reported verbatim as \"0\"", closedTl.observation.reported.balance, "0");

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
check("...is_student_loan captured", sl.observation.normalized.is_student_loan, true);
check("...federal guarantee captured", sl.observation.normalized.is_fed_guaranteed_student_loan, true);

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

console.log("\n=== NEW INDICATORS ARE FACTS, NOT VERDICTS ===\n");

const flagged = normalizeReport(payload([
    liability({
        "@_ConsumerDisputeIndicator": "Y",   // FCRA §611 — already disputed
        "@_DerogatoryDataIndicator": "Y",    // the bureau's OWN derogatory flag
        "@_AccountStatusType": "ChargeOff",
        "@_AccountOwnershipType": "AuthorizedUser",
    }),
]), { crcClientId: "15" });

const f = flagged.report.accounts[0].bureau_tradelines[0].observation;

check("consumer_disputed captured", f.normalized.consumer_disputed, true);
check("derogatory captured", f.normalized.derogatory, true);
check("account_status_type captured (reported, verbatim)", f.reported.account_status_type, "ChargeOff");

// RESPONSIBILITY IS KEPT VERBATIM AND NOT INTERPRETED.
//
// We have not seen the value vocabulary. "AuthorizedUser" / "Authorized User" /
// "A" / "3" are all plausible. A wrong guess would not fail loudly — it would
// SILENTLY DISPUTE the accounts the Constitution protects. So the normalizer
// stores the string and the Decision Engine interprets it.
check("responsibility stored VERBATIM (reported)", f.reported.responsibility, "AuthorizedUser");
check("...NOT collapsed to a boolean", "is_authorized_user" in f.reported, false);

const nsrc = readFileSync(new URL("./reportNormalize.js", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// The proof: the normalizer contains no authorized-user vocabulary at all. It
// cannot be wrong about a spelling it never mentions.
// NARROW. The phrase "authorized user" appears legitimately in the error message
// that EXPLAINS why we refuse to interpret this field. A guardrail that fires on
// its own explanation is one people learn to override.
//
// What must not exist is VALUE-MATCHING LOGIC — a comparison against a spelling
// we have never seen in the data.
check("no comparison against an AU value", /(===|==|\.includes\(|\.startsWith\()\s*["']\s*Authorized/i.test(nsrc), false);
check("no AU boolean derived", /is_authorized_user\s*[:=]/.test(nsrc), false);

// An item ALREADY marked as disputed is still emitted — BT-RN-0021 (Failure to
// Mark as Disputed) needs to see it. Dropping it here would delete the evidence.
check("an already-disputed item is still emitted", flagged.report.accounts.length, 1);
check("...and a derogatory one is not auto-classified", /is_negative|isNegative/.test(nsrc), false);

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

check("unreadable number -> null, not 0", sparse.report.accounts[0].bureau_tradelines[0].observation.normalized.past_due, null);
// The base fixture carries no @_PastDueAmount key at all, so past_due is
// NEVER_FOUND (no candidate key on any row) — the genuine "mapping" case.
check("...key on no row -> never_found", sparse.completeness.fields_never_found.includes("past_due"), true);

// An unrecognised bureau is never guessed.
const badBureau = normalizeReport(payload([
    liability({ CREDIT_REPOSITORY: { "@_SourceType": "TotallyUnknownBureau" } }),
]), { crcClientId: "15" });

check("unknown bureau -> no tradeline emitted", badBureau.counts.account_bureau_tradelines, 0);
check("...and it is warned about", badBureau.completeness.warnings.some((w) => /no recognisable bureau/.test(w)), true);

console.log("\n=== DEFINED-BUT-UNREAD IS NOT 'NEVER FOUND' ===\n");

// THE CONTRADICTION: /debug/field-map resolved credit_business_type (118 rows),
// credit_loan_type (103), terms_description (67) — yet M6 reported all three as
// "fields_never_found." Both cannot be true.
//
// Cause: those three are DEFINED in the field map but never READ into the model.
// field-map probes the payload directly and finds them; the normalizer only marks
// keysSeen for fields it reads, so it never marked them — and the old never_found
// check compared against EVERY defined key. A field we never look for cannot be
// "not found."
const withThose = normalizeReport(payload([
    liability({
        "@CreditBusinessType": "Bank",
        "@CreditLoanType": "Installment",
        "@_TermsDescription": "60 months",
    }),
]), { crcClientId: "15" });

// They are present in the payload...
check("credit_business_type NOT flagged never_found", withThose.completeness.fields_never_found.includes("credit_business_type"), false);
check("credit_loan_type NOT flagged never_found", withThose.completeness.fields_never_found.includes("credit_loan_type"), false);
check("terms_description NOT flagged never_found", withThose.completeness.fields_never_found.includes("terms_description"), false);

// ...and are honestly surfaced as defined-but-unread, not buried.
check("they ARE surfaced as defined_but_not_read", withThose.completeness.fields_defined_but_not_read.includes("credit_business_type"), true);
check("...all three", withThose.completeness.fields_defined_but_not_read.length, 3);

// never_found only concerns fields the normalizer actually reads.
const { FIELD } = await import("./reportNormalize.js");
check("more fields defined than read", Object.keys(FIELD).length > (Object.keys(FIELD).length - withThose.completeness.fields_defined_but_not_read.length), true);

console.log("\n=== VALID NULL vs MISSING KEY — THE COMPLETENESS FIX ===\n");

// This is the exact production case: DOFD resolves on 11/119 rows and is
// legitimately absent on 108. The key is CORRECT. The old completeness logic
// reported it as "not found" AND warned about it — on a field working perfectly.
const dofdMix = normalizeReport(payload([
    liability({ "@_FirstDelinquencyDate": "2022-05-01" }),                    // DOFD populated
    liability({ "@ArrayAccountIdentifier": "ARR-2", "@TradelineHashSimple": "h2",
                "@_FirstDelinquencyDate": "" }),                              // KEY present, value empty
]), { crcClientId: "15" });

// The KEY was seen (row 1), so DOFD is NOT a mapping defect...
check("DOFD present on some rows -> NOT never_found", dofdMix.completeness.fields_never_found.includes("dofd"), false);
// ...but it WAS null somewhere, so it is transparently listed as present-but-null.
check("DOFD null on some rows -> present_but_null", dofdMix.completeness.fields_present_but_null.includes("dofd"), true);
// And it does not generate a warning — the old bug did exactly that.
check("no warning for a working optional field", dofdMix.completeness.warnings.some((w) => /"dofd"/.test(w)), false);

// A truly unmapped key — one that appears on NO row — IS surfaced.
// (Simulate by asking for a field whose candidates the fixture never sets.)
const noClosed = normalizeReport(payload([
    (() => { const l = liability(); return l; })(),   // no date_closed anywhere
]), { crcClientId: "15" });
check("date_closed on no row -> never_found", noClosed.completeness.fields_never_found.includes("date_closed"), true);
check("...and IS warned about", noClosed.completeness.warnings.some((w) => /date_closed/.test(w)), true);

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

console.log("\n=== BUREAU FIDELITY: TWO LAYERS, NEVER CROSSED ===\n");

// Layer 2 keeps the bureau's string EXACTLY. Layer 1/normalized holds the coerced
// value for reasoning. The refactor's whole point: the original is never thrown
// away, so a faithful letter CAN be generated from the model.
const fidelity = normalizeReport(payload([
    liability({
        "@_UnpaidBalanceAmount": "$4,200.00",     // bureau's formatting, verbatim
        "@RawAccountStatus": "Charge-Off",
        "@_FirstDelinquencyDate": "05/01/2022",   // bureau's date format
    }),
]), { crcClientId: "15" });

const fo = fidelity.report.accounts[0].bureau_tradelines[0].observation;

// LAYER 2 — exactly as reported. No reformatting, no coercion.
check("reported balance is the bureau's STRING", fo.reported.balance, "$4,200.00");
check("reported status verbatim", fo.reported.account_status, "Charge-Off");
check("reported DOFD in the bureau's own format", fo.reported.dofd, "05/01/2022");

// NORMALIZED — coerced for reasoning. Different values, same source.
check("normalized balance is a NUMBER", fo.normalized.balance, 4200);
check("normalized DOFD is ISO", fo.normalized.date_of_first_delinquency, "2022-05-01");

// The two layers must NOT be the same object/value — that is the whole point.
check("layers hold DIFFERENT representations", fo.reported.balance !== fo.normalized.balance, true);

// Nothing in reported was coerced to a number or ISO date.
const reportedValues = Object.values(fo.reported).filter((v) => v !== null);
check("no reported value is a JS number", reportedValues.some((v) => typeof v === "number"), false);

console.log("\n=== LISTANDSTACK: ABBREVIATION DUPLICATES FOLD (18-PAIR REGRESSION) ===\n");

// A merged/primary row + a bureau-specific secondary row for the SAME tradeline,
// with the furnisher name abbreviated differently. Same bureau, same last-4.
// Frozen Standard: furnisher naming must not split what account-number joins.
// These MUST fold — they were the 18 false IDENTITY CONFLICTs.
function abbrevPair(arrayId, last4, nameA, nameB) {
    return normalizeReport(payload([
        liability({
            "@ArrayAccountIdentifier": arrayId, "@TradelineHashSimple": arrayId + "-a",
            "@_AccountIdentifier": "****" + last4, _CREDITOR: { "@_Name": nameA },
            CREDIT_REPOSITORY: [{ "@_SourceType": "TransUnion" }, { "@_SourceType": "Experian" }],
        }),
        liability({
            "@ArrayAccountIdentifier": arrayId, "@TradelineHashSimple": arrayId + "-b",
            "@_AccountIdentifier": "****" + last4, _CREDITOR: { "@_Name": nameB },
            CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" },
        }),
    ]), { crcClientId: "15" });
}

const cases = [
    ["ARR-NAVY", "6095", "NAVY FEDERAL CR UNION", "NAVY FCU"],
    ["ARR-BARC", "0609", "BARCLAYS BANK DELAWARE", "BRCLYSBANKDE"],
    ["ARR-KOHL", "9305", "CAP1/KOHLS DEPT STORE", "CAP1/KOHLS"],
    ["ARR-CAP1", "0101", "CAP ONE AUTO", "CAPONEAUTO"],
];

for (const [arrayId, last4, nameA, nameB] of cases) {
    const r = abbrevPair(arrayId, last4, nameA, nameB);
    check(`${nameA} / ${nameB} -> extraction_ok`, r.extraction_ok, true);

    const acct = r.report.accounts.find((a) => a.array_account_identifier === arrayId);
    const tu = acct.bureau_tradelines.filter((t) => t.bureau === "transunion");
    check(`  ...folds to ONE TransUnion tradeline`, tu.length, 1);
    // Bureau Fidelity: the bureau-specific reported furnisher string is preserved.
    check(`  ...reported furnisher preserved verbatim`,
        typeof tu[0].furnisher === "string" && tu[0].furnisher.length > 0, true);
    check(`  ...fold recorded`, r.key_resolution.tradelines.folded >= 1, true);
}

console.log("\n=== SEPARATE STUDENT LOANS STAY SEPARATE (DIFFERENT LAST-4) ===\n");

// Two Aidvantage student loans: DIFFERENT last-4 (9526 vs 6571). Even if Array
// reused one @ArrayAccountIdentifier, different last-4 = different accounts. They
// must NOT collide and must NOT route to manual review.
const aidvantage = normalizeReport(payload([
    liability({
        "@ArrayAccountIdentifier": "ARR-AID", "@TradelineHashSimple": "aid-a",
        "@_AccountIdentifier": "****9526", "@IsStudentLoan": "Y",
        _CREDITOR: { "@_Name": "DEPT OF ED/AIDVANTAGE" },
        CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" },
    }),
    liability({
        "@ArrayAccountIdentifier": "ARR-AID", "@TradelineHashSimple": "aid-b",
        "@_AccountIdentifier": "****6571", "@IsStudentLoan": "Y",
        _CREDITOR: { "@_Name": "DPT ED/AIDV" },
        CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" },
    }),
]), { crcClientId: "15" });

check("Aidvantage pair -> extraction_ok (no false conflict)", aidvantage.extraction_ok, true);
check("...NOT routed to manual review", aidvantage.key_resolution.tradelines.ambiguous.length, 0);

// Two distinct TransUnion tradelines, one per last-4.
const aidAcct = aidvantage.report.accounts.find((a) => a.array_account_identifier === "ARR-AID");
const aidTu = aidAcct.bureau_tradelines.filter((t) => t.bureau === "transunion");
check("...two separate TransUnion tradelines", aidTu.length, 2);
const last4s = aidTu.map((t) => t.masked_account).sort();
check("...distinct masked accounts preserved", last4s.length === new Set(last4s).size, true);

// Report order preserved: 9526 (row 0) before 6571 (row 1).
check("...preserved in report order", aidTu[0].source_row_index < aidTu[1].source_row_index, true);

console.log("\n=== STATUS SOURCE: FIELD-CONTRACT REGRESSION (live-report shape) ===\n");

// The live report carries NO @RawAccountStatus. Status lives in @_AccountStatusType
// and _CURRENT_RATING. Before the fix, normalized.status was null and EVERY
// tradeline looked non-negative. These fixtures use the real field shape.

// 1. CHARGE-OFF — _CURRENT_RATING = "CollectionOrChargeOff", no @RawAccountStatus.
const chargeoff = normalizeReport(payload([
    liability({
        "@_AccountIdentifier": "****1111", "@RawAccountStatus": undefined,
        "@_AccountStatusType": "Closed", "_CURRENT_RATING": "CollectionOrChargeOff",
        "@IsChargeoffIndicator": "Y", "@_DerogatoryDataIndicator": "Y",
        "@_PastDueAmount": "4200", "@_FirstDelinquencyDate": "2022-01-10",
        _CREDITOR: { "@_Name": "CAP ONE AUTO" },
        CREDIT_REPOSITORY: { "@_SourceType": "TransUnion" },
    }),
]), { crcClientId: "15" });
const coTl = chargeoff.report.accounts[0].bureau_tradelines[0];
check("charge-off: status populated (not null)", coTl.observation.normalized.status !== null, true);
check("charge-off: status carries the rating word", /CHARGEOFF|COLLECTIONORCHARGEOFF|COLLECTION/i.test(coTl.observation.normalized.status), true);
check("charge-off: reported.account_status untouched (fidelity)", "account_status" in coTl.observation.reported, true);

// 2. OPEN ACCOUNT WITH HISTORICAL 30/60 LATES — currently open, derog history.
const lates = normalizeReport(payload([
    liability({
        "@_AccountIdentifier": "****2222", "@RawAccountStatus": undefined,
        "@_AccountStatusType": "Open", "_CURRENT_RATING": "Late30Days",
        "@IsClosedIndicator": "N", "@_DerogatoryDataIndicator": "Y",
        "_LATE_COUNT": { "@_30Days": "2", "@_60Days": "1", "@_90Days": "0" },
        _CREDITOR: { "@_Name": "BARCLAYS BANK DELAWARE" },
        CREDIT_REPOSITORY: { "@_SourceType": "Experian" },
    }),
]), { crcClientId: "15" });
const lateTl = lates.report.accounts[0].bureau_tradelines[0];
check("late account: status populated (not null)", lateTl.observation.normalized.status !== null, true);

// 3. CLEAN POSITIVE — open, current, no derog. Must stay non-negative.
const clean = normalizeReport(payload([
    liability({
        "@_AccountIdentifier": "****3333", "@RawAccountStatus": undefined,
        "@_AccountStatusType": "Open", "_CURRENT_RATING": "Current",
        "@IsClosedIndicator": "N", "@IsChargeoffIndicator": "N",
        "@IsCollectionIndicator": "N", "@_DerogatoryDataIndicator": "N",
        "@_PastDueAmount": "0",
        _CREDITOR: { "@_Name": "NAVY FEDERAL CR UNION" },
        CREDIT_REPOSITORY: { "@_SourceType": "Equifax" },
    }),
]), { crcClientId: "15" });
const cleanTl = clean.report.accounts[0].bureau_tradelines[0];
check("clean positive: status populated", cleanTl.observation.normalized.status !== null, true);
check("clean positive: status is Current", /CURRENT/i.test(cleanTl.observation.normalized.status), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
