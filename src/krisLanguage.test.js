/**
 * krisLanguage.test.js
 *
 * Verifies the Kris-approved firm dispute language (approved 2026-07-16) is in
 * production and that prohibited soft/only language cannot pass the content gate.
 *
 * Covers:
 *   - approved general firm opening exists
 *   - Metro 2 fact-specific opening used ONLY when every section supports it
 *   - mixed-reason letters fall back to the general firm opening
 *   - exact approved closing is used
 *   - "delete the item only if" is prohibited
 *   - the approved conditional remedy contains "delete the item if"
 *   - soft thank-you closings are not selected
 *   - placeholder / null / undefined / DO NOT SEND gates still work
 */
import { OPENINGS, FACT_SPECIFIC_OPENINGS, renderOpening,
         APPROVED_GENERAL_OPENING_TEXT, APPROVAL as OPENING_APPROVAL,
         APPROVAL_DATE as OPENING_APPROVAL_DATE } from "./openingLibrary.js";
import { CLOSINGS, renderClosing, APPROVED_CLOSING_TEXT } from "./closingLibrary.js";
import { selectVoice } from "./voice.js";
import { screenLetterContent, FIDELITY_MISSING_MARKER } from "./generateLetter.js";
import { remedyFor } from "./selectStrategy.js";

let passed = 0, failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) console.log(`FAIL  ${label.padEnd(56)} got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
    ok ? passed++ : failed++;
};

console.log("\n=== APPROVAL METADATA ===\n");
check("openings KRIS_APPROVED_V1", OPENING_APPROVAL, "KRIS_APPROVED_V1");
check("approval date 2026-07-16", OPENING_APPROVAL_DATE, "2026-07-16");

console.log("\n=== APPROVED GENERAL FIRM OPENING ===\n");
check("general opening text is the Kris-approved firm demand",
    APPROVED_GENERAL_OPENING_TEXT,
    "I am formally disputing the inaccurate and incomplete reporting identified below. " +
    "Conduct a reasonable reinvestigation of each disputed item and correct, update, or " +
    "delete any information that cannot be fully verified as accurate and complete.");
check("the general firm opening is in the pool",
    OPENINGS.some((o) => renderOpening(o).includes(APPROVED_GENERAL_OPENING_TEXT)), true);
check("every general opening states a formal dispute",
    OPENINGS.every((o) => /formally disputing/i.test(renderOpening(o))), true);
check("every general opening demands a reasonable reinvestigation",
    OPENINGS.every((o) => /reasonable reinvestigation/i.test(renderOpening(o))), true);

console.log("\n=== METRO 2 FACT-SPECIFIC OPENING GATING ===\n");
const metro2Opening = FACT_SPECIFIC_OPENINGS.find((o) => o.requires === "metro2_missing_dofd");
check("Metro 2 opening exists", !!metro2Opening, true);
check("Metro 2 opening quotes CollectionOrChargeOff without DOFD",
    /"CollectionOrChargeOff" without a Date of First Delinquency/.test(renderOpening(metro2Opening)), true);

// Selection: when the engine asserts the shared defect, the fact-specific opening is chosen.
const ctx = { crcClientId: 15, bureau: "transunion", round: 1, reportDate: "2026-07-13" };
const withDefect = selectVoice({ ...ctx, sharedDefect: "metro2_missing_dofd" });
check("shared defect -> Metro 2 opening selected", withDefect.opening.id, "OPEN-METRO2-DOFD-001");
check("Metro 2 opening text used",
    /without a Date of First Delinquency/.test(withDefect.opening.text), true);

// Mixed-reason letter: no shared defect asserted -> general firm opening.
const noDefect = selectVoice({ ...ctx });
check("no shared defect -> general opening (not Metro 2)",
    noDefect.opening.id.startsWith("OPEN-GEN-"), true);
check("mixed-reason opening still states formal dispute",
    /formally disputing/i.test(noDefect.opening.text), true);

console.log("\n=== APPROVED CLOSING ===\n");
check("approved closing text is exact",
    APPROVED_CLOSING_TEXT,
    "Provide the written results of your reinvestigation, an updated copy of my credit file, " +
    "and a description of the procedure used to determine the accuracy and completeness of each disputed item.\n\n" +
    "I expect each item to be corrected, updated, or deleted as required by the results of your reinvestigation.");
check("a closing renders the exact approved text",
    CLOSINGS.some((c) => renderClosing(c) === APPROVED_CLOSING_TEXT), true);
check("every closing demands written results",
    CLOSINGS.every((c) => /written results of your reinvestigation/i.test(renderClosing(c))), true);
check("every closing demands the procedure",
    CLOSINGS.every((c) => /description of the procedure/i.test(renderClosing(c))), true);
check("no closing thanks the reader",
    CLOSINGS.every((c) => !/thank you/i.test(renderClosing(c))), true);
check("no closing uses 'I would appreciate'",
    CLOSINGS.every((c) => !/I would appreciate/i.test(renderClosing(c))), true);

console.log("\n=== 'ONLY' PROHIBITED; APPROVED REMEDY USES 'delete the item if' ===\n");
const remedy = remedyFor("BT-ST-0010", "BT-DM-0033");
check("BT-DM-0033 remedy contains 'delete the item if'",
    /delete the item if it cannot be verified or accurately corrected/.test(remedy), true);
check("BT-DM-0033 remedy does NOT contain 'only'", /delete the item only if/.test(remedy), false);

console.log("\n=== CONTENT GATE: PROHIBITED LANGUAGE + PLACEHOLDERS ===\n");
const gate = (body) => screenLetterContent([{ bureau: "tu", bureauName: "TransUnion", body }])[0].hits;
check("'delete the item only if' is gated", gate("... delete the item only if verified ...").includes("delete the item only if"), true);
check("'I would appreciate' is gated", gate("I would appreciate a response").includes("I would appreciate"), true);
check("'Thank you for your' is gated", gate("Thank you for your time.").includes("thank you for your"), true);
check("'Please investigate' is gated", gate("Please investigate this.").includes("please investigate"), true);
check("DO NOT SEND marker still gated", gate(`x ${FIDELITY_MISSING_MARKER} y`).length > 0, true);
check("standalone null still gated", gate('status of "null"').includes("null"), true);
check("standalone undefined still gated", gate("x undefined y").includes("undefined"), true);
check("clean firm body passes gate", gate(APPROVED_GENERAL_OPENING_TEXT + "\n\n" + APPROVED_CLOSING_TEXT).length, 0);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
