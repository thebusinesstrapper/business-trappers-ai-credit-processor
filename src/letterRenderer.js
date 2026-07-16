/**
 * letterRenderer.js
 *
 * BUSINESS TRAPPERS CLIENT-FACING LETTER RENDERER™
 * Confidential & Proprietary.
 *
 * ===========================================================================
 * PURPOSE
 *
 * Turn an approved, already-assembled letter (plain-text body produced by the
 * Letter Engine) into a client-facing document that Business Trappers saves to
 * Credit Cloud for the consumer to retrieve.
 *
 * The document must resemble ORDINARY CONSUMER CORRESPONDENCE prepared in
 * Microsoft Word — not a branded, AI-styled, or decorated layout. A bureau
 * should see a normal letter a person typed.
 *
 * FORMATTING STANDARD (fixed, enforced by test):
 *   Font family ............ Times New Roman (serif fallback only if unavailable)
 *   Body font size ......... 12 pt
 *   Furnisher/account head . 12 pt bold
 *   Margins ................ 1 inch on all sides
 *   Line spacing ........... single
 *   Paragraph spacing ...... 6 pt after
 *   Alignment .............. left
 *   Text color ............. black
 *   No decorative fonts, colored text, banners, shaded tables, graphic
 *   headings, or branded/AI layouts. No internal labels or review banners.
 *
 * SEPARATION OF CONCERNS: this module is PRESENTATION ONLY. It never selects
 * content, never makes a legal statement, and never alters wording. It renders
 * exactly the approved body it is given. Voice/law/logic live elsewhere.
 * ===========================================================================
 */

import {
    Document,
    Packer,
    Paragraph,
    TextRun,
    AlignmentType,
    convertInchesToTwip,
} from "docx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const RENDERER_VERSION = "BT-LETTER-RENDERER-1.0";

// The fixed formatting standard. Exported so tests assert against ONE source.
export const FORMATTING_STANDARD = Object.freeze({
    font: "Times New Roman",
    // docx sizes are in HALF-points: 12 pt = 24.
    bodyHalfPoints: 24,
    bodyPointSize: 12,
    headingBold: true,
    marginTwip: convertInchesToTwip(1), // 1 inch
    lineSpacing: 240,                   // single (240 twip = 1 line)
    spacingAfterTwip: 120,              // 6 pt after (20 twip per pt * 6)
    alignment: "left",
    color: "000000",                    // black
});

// A furnisher/account heading line looks like "Creditor: X" or "Account Number: Y".
// These render 12 pt BOLD. Everything else is 12 pt regular. This is presentation
// only — the classification never changes a word of content.
const HEADING_LINE = /^(Creditor|Account Number|Furnisher|Re:)\b/;

/**
 * Build a docx Paragraph for one line of the letter body, applying the standard.
 * A blank line becomes an empty spacer paragraph (preserving the body's rhythm).
 */
function paragraphForLine(line) {
    const isHeading = HEADING_LINE.test(line.trim());
    return new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: {
            after: FORMATTING_STANDARD.spacingAfterTwip,
            line: FORMATTING_STANDARD.lineSpacing,
            lineRule: "auto",
        },
        children: [
            new TextRun({
                text: line,
                font: FORMATTING_STANDARD.font,
                size: FORMATTING_STANDARD.bodyHalfPoints,
                bold: isHeading ? true : false,
                color: FORMATTING_STANDARD.color,
            }),
        ],
    });
}

/**
 * Render one approved letter to a DOCX Buffer.
 *
 * @param {object} letter  A letter from the Letter Engine: { body, bureau, ... }.
 *                         `body` is the approved plain text. This function does
 *                         not inspect or alter the wording.
 * @returns {Promise<Buffer>} the .docx bytes.
 */
export async function renderLetterDocx(letter) {
    if (!letter || typeof letter.body !== "string" || letter.body.length === 0) {
        throw new Error("renderLetterDocx: letter.body (non-empty string) is required.");
    }

    // The body uses "---" as a visual separator between sections. In a Word
    // document that reads as ordinary correspondence, we drop the literal rule
    // characters and let paragraph spacing do the separating.
    const lines = letter.body
        .split("\n")
        .filter((line) => line.trim() !== "---");

    const doc = new Document({
        // No title, subject, or "creator: AI" metadata that would brand the file.
        creator: "",
        description: "",
        title: "",
        styles: {
            default: {
                document: {
                    run: {
                        font: FORMATTING_STANDARD.font,
                        size: FORMATTING_STANDARD.bodyHalfPoints,
                        color: FORMATTING_STANDARD.color,
                    },
                },
            },
        },
        sections: [
            {
                properties: {
                    page: {
                        // US Letter, 1-inch margins on all sides.
                        size: { width: 12240, height: 15840 },
                        margin: {
                            top: FORMATTING_STANDARD.marginTwip,
                            bottom: FORMATTING_STANDARD.marginTwip,
                            left: FORMATTING_STANDARD.marginTwip,
                            right: FORMATTING_STANDARD.marginTwip,
                        },
                    },
                },
                children: lines.map(paragraphForLine),
            },
        ],
    });

    return Packer.toBuffer(doc);
}

// ---- PDF RENDERING (pure JS, no system dependency) ----------------------
//
// PDF is produced directly with pdf-lib using the Standard-14 Times-Roman
// font — identical metrics to Times New Roman and requires NO font embedding
// and NO system package (no LibreOffice). This is the smallest stable approach
// that runs on Railway's default Nixpacks build with only an npm dependency.
// The DOCX and PDF are rendered from the SAME letter body and the SAME
// FORMATTING_STANDARD, so they present identically.

// US Letter, points. 1 inch = 72 pt.
const PDF_PAGE = { width: 612, height: 792 };
const PDF_MARGIN = 72;                     // 1 inch
const PDF_FONT_SIZE = FORMATTING_STANDARD.bodyPointSize; // 12 pt
const PDF_LINE_HEIGHT = PDF_FONT_SIZE * 1.15;            // single spacing
const PDF_PARA_AFTER = 6;                  // 6 pt after each source line
const PDF_TEXT_WIDTH = PDF_PAGE.width - PDF_MARGIN * 2;

// Greedy word-wrap to the printable width using the font's real glyph metrics.
function wrapLine(text, font, size) {
    if (text === "") return [""];
    const words = text.split(/\s+/);
    const lines = [];
    let current = "";
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) > PDF_TEXT_WIDTH && current) {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines;
}

/**
 * Render one approved letter to a PDF Buffer, applying the formatting standard.
 * Pure JS — no converter injection, no system package.
 *
 * @param {object} letter  { body, bureau, ... }. Wording is rendered verbatim.
 * @returns {Promise<Buffer>} the .pdf bytes.
 */
export async function renderLetterPdf(letter) {
    if (!letter || typeof letter.body !== "string" || letter.body.length === 0) {
        throw new Error("renderLetterPdf: letter.body (non-empty string) is required.");
    }

    const pdf = await PDFDocument.create();
    // No Author/Creator/Producer branding on the client-facing file.
    pdf.setTitle("");
    pdf.setAuthor("");
    pdf.setCreator("");
    pdf.setProducer("");
    pdf.setSubject("");

    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const fontBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const black = rgb(0, 0, 0);

    // Same body handling as DOCX: drop literal "---" separators.
    const sourceLines = letter.body.split("\n").filter((line) => line.trim() !== "---");

    let page = pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
    let y = PDF_PAGE.height - PDF_MARGIN;

    const newPageIfNeeded = () => {
        if (y < PDF_MARGIN) {
            page = pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
            y = PDF_PAGE.height - PDF_MARGIN;
        }
    };

    for (const raw of sourceLines) {
        const isHeading = /^(Creditor|Account Number|Furnisher|Re:)\b/.test(raw.trim());
        const useFont = isHeading ? fontBold : font;
        // A blank source line is vertical space only.
        const wrapped = raw === "" ? [""] : wrapLine(raw, useFont, PDF_FONT_SIZE);
        for (const line of wrapped) {
            newPageIfNeeded();
            if (line !== "") {
                page.drawText(line, {
                    x: PDF_MARGIN,
                    y: y - PDF_FONT_SIZE,
                    size: PDF_FONT_SIZE,
                    font: useFont,
                    color: black,
                });
            }
            y -= PDF_LINE_HEIGHT;
        }
        // 6 pt paragraph spacing after each source line.
        y -= PDF_PARA_AFTER;
    }

    const bytes = await pdf.save();
    return Buffer.from(bytes);
}

// ---- EXPORT ORCHESTRATION -----------------------------------------------

/**
 * Build a safe, descriptive filename stem (no extension) for an exported
 * letter: client, bureau, round, and date. Filesystem- and URL-safe.
 */
export function exportFilename(letter, context = {}) {
    const safe = (v) =>
        String(v ?? "")
            .normalize("NFKD")
            .replace(/[^A-Za-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "unknown";
    const client = safe(context.clientName ?? letter.clientName ?? "client");
    const bureau = safe(letter.bureauName ?? letter.bureau ?? "bureau");
    const round = safe(`round-${context.round ?? letter.round ?? 1}`);
    const date = safe(context.date ?? new Date().toISOString().slice(0, 10));
    return `${client}_${bureau}_${round}_${date}`;
}

/**
 * Export a single successful letter to DOCX + PDF buffers with metadata.
 * Presentation only — never alters wording, never sends or uploads.
 *
 * @returns {Promise<{ filenameStem, docx: {filename, buffer, bytes},
 *                     pdf: {filename, buffer, bytes} }>}
 */
export async function exportLetter(letter, context = {}) {
    const stem = exportFilename(letter, context);
    const docxBuffer = await renderLetterDocx(letter);
    const pdfBuffer = await renderLetterPdf(letter);
    return {
        filenameStem: stem,
        rendererVersion: RENDERER_VERSION,
        docx: { filename: `${stem}.docx`, buffer: docxBuffer, bytes: docxBuffer.length },
        pdf: { filename: `${stem}.pdf`, buffer: pdfBuffer, bytes: pdfBuffer.length },
    };
}

/**
 * Export all SENDABLE letters from a letter-generation result.
 *
 * CRITICAL: only `result.letters` are exported. Withheld / content-gated letters
 * (in `result.withheld`) are NEVER exported. Returns metadata only — binary
 * buffers are returned to the caller for saving, and are NOT intended to be
 * placed inside the ordinary M7 JSON response.
 *
 * @param {object} letterResult  the object returned by generateLetters(...)
 * @param {object} context       { clientName, round, date }
 * @returns {Promise<{ exported: Array, skipped: Array }>}
 */
export async function exportLetterResult(letterResult, context = {}) {
    const exported = [];
    // Fail-closed: if the result is not certified sendable, export nothing.
    if (!letterResult || letterResult.lettersOk !== true) {
        return {
            exported: [],
            skipped: [{ reason: "letterResult.lettersOk is not true; nothing exported." }],
        };
    }
    for (const letter of letterResult.letters ?? []) {
        const artifact = await exportLetter(letter, context);
        // Metadata only — no binary in this summary list.
        exported.push({
            bureau: letter.bureau,
            bureauName: letter.bureauName,
            docx: { filename: artifact.docx.filename, bytes: artifact.docx.bytes },
            pdf: { filename: artifact.pdf.filename, bytes: artifact.pdf.bytes },
            buffers: { docx: artifact.docx.buffer, pdf: artifact.pdf.buffer },
        });
    }
    return { exported, skipped: [] };
}
