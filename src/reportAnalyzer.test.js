/**
 * reportAnalyzer.test.js
 * Run: node src/reportAnalyzer.test.js
 *
 * ===========================================================================
 * THE ANALYZER WAS WRITTEN AGAINST AN IMAGINED SCHEMA.
 *
 * Every pattern anchored on a quote followed by a generic English word —
 * "tradelines", "inquiry", "scores". MISMO 2.4 names its containers
 * "CREDIT_LIABILITY", "CREDIT_INQUIRY", "CREDIT_SCORE". The quote is followed by
 * CREDIT_, so every pattern missed, and a complete tri-bureau report was reported
 * as "not a report".
 *
 * DIAGNOSTIC ONLY. These tests also assert the analyzer NEVER gates anything —
 * completeness is not confidence (Extraction System §5.2), and
 * `looks_like_complete_report` is exactly the field a future caller would reach
 * for as a gate.
 * ===========================================================================
 */

import { readFileSync } from "fs";
import { analyzeReportShape } from "./spikeReportJson.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(60)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

// A MISMO 2.4 / Array.io payload, shaped as the live capture reports it.
const mismo = {
    CREDIT_RESPONSE: {
        CREDIT_REPOSITORY_INCLUDED: {
            EquifaxIndicator: "Y",
            ExperianIndicator: "Y",
            TransUnionIndicator: "Y",
        },
        CREDIT_FILE: [
            { CreditRepositorySourceType: "TransUnion", ResultStatusType: "Ready" },
            { CreditRepositorySourceType: "Experian", ResultStatusType: "Ready" },
            { CreditRepositorySourceType: "Equifax", ResultStatusType: "Ready" },
        ],
        CREDIT_LIABILITY: [
            {
                _AccountIdentifier: "****6095",
                _AccountType: "Installment",
                CREDIT_REPOSITORY: [
                    { _SourceType: "TransUnion", _AccountStatusType: "ChargeOff" },
                    { _SourceType: "Experian", _AccountStatusType: "Current" },
                ],
                _PAYMENT_PATTERN: { _Data: "CCCCC1CCC" },
                _CREDITOR: { _Name: "NAVY FEDERAL CR UNION" },
            },
            {
                _AccountIdentifier: "****1234",
                _AccountType: "Collection",
                IsCollectionIndicator: "true",
                CREDIT_REPOSITORY: [{ _SourceType: "Equifax" }],
            },
        ],
        CREDIT_INQUIRY: [
            { _Date: "2026-01-05", _Name: "UNKNOWN LENDER", CREDIT_REPOSITORY: { _SourceType: "TransUnion" } },
        ],
        CREDIT_SCORE: [
            { _Value: "612", CreditRepositorySourceType: "TransUnion" },
            { _Value: "605", CreditRepositorySourceType: "Experian" },
        ],
        CREDIT_SUMMARY: [{ _Name: "TotalAccounts", _Value: "14" }],
        CREDIT_BORROWER: { _FirstName: "Elizabeth", _LastName: "Kelley" },
    },
};

console.log("\n=== MISMO 2.4 IS RECOGNISED ===\n");

const result = analyzeReportShape(mismo);

check("schema detected as MISMO_2_4", result.schema, "MISMO_2_4");
check("looks_like_complete_report", result.looks_like_complete_report, true);

console.log("\n--- Sections ---");

check("CREDIT_LIABILITY  -> tradelines", result.sections_present.tradelines, true);
check("CREDIT_INQUIRY    -> inquiries", result.sections_present.inquiries, true);
check("CREDIT_SCORE      -> scores", result.sections_present.scores, true);
check("CREDIT_FILE       -> credit_files", result.sections_present.credit_files, true);
check("CREDIT_SUMMARY    -> summary", result.sections_present.summary, true);
check("CREDIT_BORROWER   -> personal_information", result.sections_present.personal_information, true);
check("_PAYMENT_PATTERN  -> payment_history", result.sections_present.payment_history, true);
check("CREDIT_REPOSITORY -> repositories", result.sections_present.repositories, true);

console.log("\n--- Collections are NOT a MISMO section ---");

// In MISMO a collection is a CREDIT_LIABILITY carrying a collection marker, not a
// container of its own. Looking for a "collections" section and finding none does
// not mean the report has no collections — it means the schema does not work that
// way. The old analyzer would have reported `collections: false` on a report full
// of them, which is worse than reporting nothing.
check("collection detected via its marker", result.sections_present.collections, true);
check("...and the schema quirk is stated", /not a separate section/i.test(result.sections_present.collections_note), true);

console.log("\n--- Bureaus and nesting ---");

check("all three bureaus found", result.bureaus_found.length, 3);
check("nesting resolved, not guessed", /MERGED/.test(result.bureau_nesting), true);

console.log("\n--- CreditRepositorySourceType elsewhere must not fake 'SEPARATE' ---");

// A string match cannot answer the nesting question. CreditRepositorySourceType
// appears all over a real payload — CREDIT_FILE carries one per bureau (there are
// three files) and so does CREDIT_SCORE. A regex looking for it ANYWHERE reports
// "separate" on every report ever captured, including merged ones.
//
// The fixture above is MERGED (CREDIT_REPOSITORY beneath CREDIT_LIABILITY) yet its
// files and scores are stamped per bureau. A correct detector inspects the
// LIABILITIES, not the document.
check("merged, despite source types on files/scores", /^MERGED/.test(result.bureau_nesting), true);
check("...not reported as BOTH/MIXED", /MIXED|BOTH/.test(result.bureau_nesting), false);

// And a genuinely separate payload must be detected as such.
const separatePayload = {
    CREDIT_RESPONSE: {
        CREDIT_FILE: [{ CreditRepositorySourceType: "TransUnion" }],
        CREDIT_LIABILITY: [
            { _AccountIdentifier: "****6095", CreditRepositorySourceType: "TransUnion" },
            { _AccountIdentifier: "****6095", CreditRepositorySourceType: "Experian" },
        ],
    },
};

check("separate shape detected", /^SEPARATE/.test(analyzeReportShape(separatePayload).bureau_nesting), true);

// Neither shape -> we say so. We do not pick one.
const ambiguous = {
    CREDIT_RESPONSE: { CREDIT_FILE: [{}], CREDIT_LIABILITY: [{ _AccountIdentifier: "****6095" }] },
};

check("ambiguous -> unknown, never guessed", /^unknown/.test(analyzeReportShape(ambiguous).bureau_nesting), true);

console.log("\n=== THE OLD HEURISTIC FAILED ON THIS EXACT PAYLOAD ===\n");

// Reproduce the old logic so the bug is on the record, not just in a comment.
const flat = JSON.stringify(mismo);
const oldHas = (p) => new RegExp(p, "i").test(flat);

const oldSections = {
    tradelines: oldHas('"(trade|tradelines?|accounts?)"'),
    inquiries: oldHas('"inquir(y|ies)"'),
    scores: oldHas('"scores?"'),
};

check("old: tradelines -> MISSED", oldSections.tradelines, false);
check("old: inquiries  -> MISSED", oldSections.inquiries, false);
check("old: scores     -> MISSED", oldSections.scores, false);
check("old: complete   -> FALSE on a complete report", oldSections.tradelines && oldSections.inquiries, false);

console.log("\n=== A REPORT WITH NO INQUIRIES IS STILL COMPLETE ===\n");

// The OLD heuristic required inquiries. A consumer with no recent hard inquiries
// has a complete report with zero of them — and would have been classified as
// incomplete. Requiring a section that is legitimately empty is how a good report
// gets thrown away.
const noInquiries = JSON.parse(JSON.stringify(mismo));
delete noInquiries.CREDIT_RESPONSE.CREDIT_INQUIRY;

const r2 = analyzeReportShape(noInquiries);

check("no inquiries -> still MISMO", r2.schema, "MISMO_2_4");
check("no inquiries -> still complete", r2.looks_like_complete_report, true);
check("...and inquiries correctly reported absent", r2.sections_present.inquiries, false);

console.log("\n=== A NON-REPORT IS NOT FORCED INTO THE MISMO MAP ===\n");

const notAReport = analyzeReportShape({ status: "ok", user: { id: 15 }, items: [] });

check("unknown schema", notAReport.schema, "UNKNOWN");
check("...not a complete report", notAReport.looks_like_complete_report, false);
check("...nesting is not asserted", /unknown/i.test(notAReport.bureau_nesting), true);

console.log("\n=== DIAGNOSTIC ONLY — IT MUST NEVER GATE ===\n");

// Completeness is not confidence (Extraction §5.2). looks_like_complete_report is
// exactly the field someone would later branch on, and a heuristic that becomes
// load-bearing will one day silently drop a real report.
check("the payload says so itself", /never gates extraction/i.test(result.note), true);

const m6 = readFileSync(new URL("./milestone6.js", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

check("milestone6 does NOT branch on looks_like_complete_report", /looks_like_complete_report/.test(m6), false);
check("...nor on sections_present", /sections_present/.test(m6), false);
check("...it only passes the analysis through", /analysis: report\.analysis/.test(m6), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
