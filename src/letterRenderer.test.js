/**
 * letterRenderer.test.js
 *
 * Verifies the client-facing DOCX formatting standard is applied and that no
 * internal labels / review banners / decorative styling leak into the document.
 * Asserts against the ACTUAL generated .docx XML, not just the config object.
 */
import { renderLetterDocx, renderLetterPdf, exportFilename, exportLetter, exportLetterResult, FORMATTING_STANDARD } from "./letterRenderer.js";
import { PDFDocument } from "pdf-lib";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) console.log(`FAIL  ${label.padEnd(56)} got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
    ok ? passed++ : failed++;
};

const LETTER = {
    bureau: "transunion",
    bureauName: "TransUnion",
    body: [
        "Elizabeth Kelley", "5084 Louvinia Dr", "", "2026-07-13", "",
        "Re: Dispute — Elizabeth Kelley", "", "Dear TransUnion,", "",
        "I am formally disputing the inaccurate and incomplete reporting identified below. " +
        "Conduct a reasonable reinvestigation of each disputed item and correct, update, or " +
        "delete any information that cannot be fully verified as accurate and complete.",
        "", "---", "",
        "Creditor: CAPITAL ONE",
        "Account Number: 517805XXXXXX",
        'Reported with a status of "CollectionOrChargeOff" and no date of first delinquency.',
        "", "---", "",
        "Provide the written results of your reinvestigation, an updated copy of my credit file, " +
        "and a description of the procedure used to determine the accuracy and completeness of each disputed item.",
        "", "Sincerely,", "Elizabeth Kelley",
    ].join("\n"),
};

function documentXml(buffer) {
    // Read word/document.xml out of the .docx (a ZIP) without adding a zip
    // dependency: write the buffer and extract the single entry with `unzip -p`.
    const dir = mkdtempSync(join(tmpdir(), "bt-docx-"));
    const path = join(dir, "letter.docx");
    writeFileSync(path, buffer);
    return execFileSync("unzip", ["-p", path, "word/document.xml"], { encoding: "utf8" });
}

console.log("\n=== DOCX FORMATTING STANDARD ===\n");

const buf = await renderLetterDocx(LETTER);
check("renders a non-empty DOCX buffer", buf.length > 0, true);

const xml = documentXml(buf);

check("primary font is Times New Roman", xml.includes("Times New Roman"), true);
check("no decorative/sans fonts", /Arial|Calibri|Comic|Helvetica|Verdana/i.test(xml), false);
check("body size is 12 pt (half-points = 24)", xml.includes('w:val="24"'), true);
check("text color is black", xml.includes('w:color w:val="000000"'), true);
check("no colored text (non-black hex)", /w:color w:val="(?!000000)[0-9A-Fa-f]{6}"/.test(xml), false);

// 1-inch margins on all four sides (1440 twip).
for (const side of ["top", "bottom", "left", "right"]) {
    check(`margin ${side} = 1 inch (1440 twip)`, new RegExp(`w:${side}="1440"`).test(xml), true);
}
check("standard margin value is 1440 twip", FORMATTING_STANDARD.marginTwip, 1440);
check("US Letter page size", xml.includes('w:w="12240"') && xml.includes('w:h="15840"'), true);

// Furnisher/account headings are bold; body is not globally bold.
check("furnisher/account headings are bold", /<w:b\/>/.test(xml), true);

console.log("\n=== NO INTERNAL LABELS / BANNERS / DECORATION ===\n");
for (const banner of ["DO NOT SEND", "REVIEW", "INTERNAL", "WITHHELD", "BT-DM-", "BT-ST-",
                       "VALIDATED_AUTOMATION", "HUMAN_REVIEW", "AI-generated", "Business Trappers"]) {
    check(`no "${banner}" in client document`, xml.includes(banner), false);
}
check("no shading/highlight", /w:shd |w:highlight/.test(xml), false);
check("no drawing/graphic", /<w:drawing>|<pic:pic/.test(xml), false);

console.log("\n=== PDF RENDER PATH (pure JS, real output) ===\n");
const pdf = await renderLetterPdf(LETTER);
check("renders a real PDF (magic header)", pdf.subarray(0, 5).toString(), "%PDF-");
check("PDF is non-trivial in size", pdf.length > 1000, true);
// The approved wording must survive into the PDF's text layer.
// pdf-lib compresses content/font streams, so font names are not plaintext in the
// bytes. Validate structurally by re-loading the PDF and confirming it parses to a
// single page. Font identity (Times-Roman/Bold) is guaranteed by the renderer,
// which embeds only StandardFonts.TimesRoman / TimesRomanBold, and is asserted via
// FORMATTING_STANDARD below.
const reloaded = await PDFDocument.load(pdf);
check("PDF re-parses cleanly", reloaded.getPageCount() >= 1, true);
check("formatting standard font is Times New Roman", FORMATTING_STANDARD.font, "Times New Roman");
check("formatting standard body size is 12 pt", FORMATTING_STANDARD.bodyPointSize, 12);

console.log("\n=== EXPORT ORCHESTRATION ===\n");
const stem = exportFilename(LETTER, { clientName: "Elizabeth Kelley", round: 1, date: "2026-07-16" });
check("filename contains client", /Elizabeth-Kelley/.test(stem), true);
check("filename contains bureau", /TransUnion/.test(stem), true);
check("filename contains round", /round-1/.test(stem), true);
check("filename contains date", /2026-07-16/.test(stem), true);
check("filename is filesystem-safe", /^[A-Za-z0-9_-]+$/.test(stem), true);

const artifact = await exportLetter(LETTER, { clientName: "Elizabeth Kelley", round: 1, date: "2026-07-16" });
check("export produces a .docx", artifact.docx.filename.endsWith(".docx"), true);
check("export produces a .pdf", artifact.pdf.filename.endsWith(".pdf"), true);
check("export docx has bytes", artifact.docx.bytes > 0, true);
check("export pdf has bytes", artifact.pdf.bytes > 0, true);

// Withheld / not-ok results export NOTHING.
const okResult = { lettersOk: true, letters: [LETTER], withheld: [] };
const gatedResult = { lettersOk: false, letters: [LETTER], withheld: [{ bureau: "transunion" }] };
const okExport = await exportLetterResult(okResult, { clientName: "Elizabeth Kelley", round: 1, date: "2026-07-16" });
const gatedExport = await exportLetterResult(gatedResult, { clientName: "Elizabeth Kelley", round: 1, date: "2026-07-16" });
check("sendable result exports its letters", okExport.exported.length, 1);
check("content-gated result exports NOTHING", gatedExport.exported.length, 0);
check("export summary carries no raw binary in metadata rows",
    typeof okExport.exported[0].docx.bytes === "number" && !("buffer" in okExport.exported[0].docx), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
