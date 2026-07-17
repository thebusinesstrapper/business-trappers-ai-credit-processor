/**
 * m8Pdf.js — M8 secure-delivery PDF builder.
 *
 * Thin wrapper over the existing, frozen renderer (src/letterRenderer.js
 * -> renderLetterPdf). It does NOT re-render or alter letter wording. It only:
 *   1. produces one finalized PDF per SENDABLE M7 bureau letter,
 *   2. applies the M8 filename scheme (Round-[round]-[Bureau]-Dispute-Letter.pdf),
 *   3. enforces fail-closed PDF checks before a file is eligible for delivery.
 *
 * It never sends, uploads, prints, or mails. Buffers are returned to the caller.
 */

import { renderLetterPdf } from "./letterRenderer.js";
import { normalizeBureau } from "./crcBureauRecipients.js";

export const M8_PDF_VERSION = "BT-M8-PDF-1.0";

// Hard ceiling per the spec. Individual PDF must be UNDER 10 MB.
const MAX_PDF_BYTES = 10 * 1024 * 1024;

// Bureau label spelling for filenames, keyed by canonical bureau (as approved:
// "Experian" / "Equifax" / "TransUnion" as written).
const BUREAU_FILENAME_LABEL = Object.freeze({
    experian: "Experian",
    equifax: "Equifax",
    transunion: "TransUnion",
});

/**
 * Detect leftover template placeholders in the final letter body. The M7 body is
 * fully realized text, so any of these patterns means something did not fill in
 * and the PDF must NOT be delivered.
 *   {{var}} / {var} / [PLACEHOLDER] / <VAR> / %VAR%
 * We intentionally do NOT flag ordinary bracketed prose; we require an
 * all-caps/underscore token shape typical of unfilled variables.
 */
function findPlaceholders(body) {
    const patterns = [
        /\{\{[^}]+\}\}/g,               // {{name}}
        /\{[A-Z0-9_]{2,}\}/g,           // {ACCOUNT}
        /\[[A-Z0-9_]{2,}(?:\s[A-Z0-9_]+)*\]/g, // [CLIENT NAME]
        /<[A-Z0-9_]{2,}>/g,             // <VAR>
        /%[A-Z0-9_]{2,}%/g,             // %VAR%
    ];
    const hits = [];
    for (const re of patterns) {
        const m = body.match(re);
        if (m) hits.push(...m);
    }
    return Array.from(new Set(hits));
}

/**
 * Build the M8 filename for a letter. Round-[round]-[Bureau]-Dispute-Letter.pdf
 */
export function m8PdfFilename(letter) {
    const key = normalizeBureau(letter.bureau ?? letter.bureauName);
    const label = BUREAU_FILENAME_LABEL[key];
    const round = Number(letter.round);
    if (!label) throw new Error(`m8PdfFilename: unsupported bureau "${letter.bureau ?? letter.bureauName}".`);
    if (!Number.isInteger(round) || round < 1) {
        throw new Error(`m8PdfFilename: invalid round "${letter.round}".`);
    }
    return `Round-${round}-${label}-Dispute-Letter.pdf`;
}

/**
 * Validate + render ONE letter to a delivery-eligible PDF. Fail-closed: returns
 * { ok:false, failureReason, bureau } on any problem; never throws for expected
 * validation failures (callers get a structured reason + affected bureau).
 */
export async function buildOneBureauPdf(letter) {
    const bureauKey = normalizeBureau(letter?.bureau ?? letter?.bureauName);
    const fail = (reason) => ({ ok: false, bureau: bureauKey ?? null, failureReason: reason });

    // ---- pre-render content checks -------------------------------------------
    if (!letter || typeof letter !== "object") return fail("Letter object missing.");
    if (!bureauKey) return fail(`Unsupported or unknown bureau "${letter.bureau ?? letter.bureauName}".`);
    if (typeof letter.body !== "string" || letter.body.trim() === "") {
        return fail(`Final letter content is missing for ${bureauKey}.`);
    }
    // Bureau identity must match the letter's own body: the body must name its
    // own bureau and must NOT be internally tagged for a different one.
    const label = BUREAU_FILENAME_LABEL[bureauKey];
    const bodyLc = letter.body.toLowerCase();
    const bureauMentioned =
        bodyLc.includes(label.toLowerCase()) ||
        (bureauKey === "transunion" && bodyLc.includes("trans union"));
    if (!bureauMentioned) {
        return fail(`Bureau identity mismatch: ${label} letter body does not reference ${label}.`);
    }
    // No leftover placeholders.
    const placeholders = findPlaceholders(letter.body);
    if (placeholders.length > 0) {
        return fail(`Placeholder(s) remain in ${label} letter: ${placeholders.slice(0, 5).join(", ")}.`);
    }
    // No internal AI notes / JSON / diagnostics leaking into the body.
    if (/reasoningTrace|stableItemKey|complianceGated|"chain"|findingCode/i.test(letter.body)) {
        return fail(`${label} letter body appears to contain internal diagnostic content.`);
    }

    let filename;
    try { filename = m8PdfFilename(letter); }
    catch (e) { return fail(e.message); }

    // ---- render (reuses the frozen renderer) ---------------------------------
    let buffer;
    try {
        buffer = await renderLetterPdf(letter); // Uint8Array
    } catch (e) {
        return fail(`PDF render failed for ${label}: ${e.message}`);
    }

    const bytes = buffer?.length ?? 0;
    if (!bytes || bytes < 100) return fail(`${label} PDF is empty.`);
    if (bytes >= MAX_PDF_BYTES) {
        return fail(`${label} PDF is ${bytes} bytes, at/over the 10 MB limit.`);
    }

    return { ok: true, bureau: bureauKey, filename, buffer, bytes };
}

/**
 * Build delivery-eligible PDFs for every SENDABLE letter in an M7 letterResult.
 * Fail-closed at the set level: if the result is not certified sendable, build
 * nothing. Attach only the bureaus actually generated by M7.
 *
 * @returns {Promise<{ ok, round, pdfs: Array<{bureau,filename,buffer,bytes}>,
 *                     failures: Array<{bureau,failureReason}>, failureReason }>}
 */
export async function buildBureauPdfs(letterResult) {
    if (!letterResult || letterResult.lettersOk !== true) {
        return { ok: false, round: null, pdfs: [], failures: [],
            failureReason: "letterResult.lettersOk is not true; no PDFs built." };
    }
    const letters = Array.isArray(letterResult.letters) ? letterResult.letters : [];
    if (letters.length === 0) {
        return { ok: false, round: null, pdfs: [], failures: [],
            failureReason: "No sendable letters in letterResult." };
    }

    const pdfs = [];
    const failures = [];
    let round = null;
    const seenFilenames = new Set();

    for (const letter of letters) {
        if (round === null && Number.isInteger(Number(letter.round))) round = Number(letter.round);
        const result = await buildOneBureauPdf(letter);
        if (!result.ok) {
            failures.push({ bureau: result.bureau, failureReason: result.failureReason });
            continue;
        }
        // Guard against accidental duplicate bureau/round collisions.
        if (seenFilenames.has(result.filename)) {
            failures.push({ bureau: result.bureau,
                failureReason: `Duplicate PDF filename ${result.filename}.` });
            continue;
        }
        seenFilenames.add(result.filename);
        pdfs.push(result);
    }

    // Fail closed: if ANY sendable letter failed to produce a valid PDF, the
    // whole set is not deliverable (partial delivery is prohibited downstream).
    const ok = failures.length === 0 && pdfs.length > 0;
    return {
        ok,
        round,
        pdfs,
        failures,
        failureReason: ok ? null
            : (failures[0]?.failureReason ?? "No valid PDFs produced."),
    };
}
