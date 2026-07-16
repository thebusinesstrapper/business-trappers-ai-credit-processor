/**
 * openingLibrary.js
 *
 * BUSINESS TRAPPERS OPENING LIBRARY™
 * Confidential & Proprietary.
 *
 * ###########################################################################
 * ##  STATUS: KRIS_APPROVED_V1                                             ##
 * ##  Approval date: 2026-07-16                                            ##
 * ##                                                                       ##
 * ##  These openings are APPROVED Business Trappers content, incorporating ##
 * ##  the firm dispute language Kris approved on 2026-07-16. They SUPERSEDE ##
 * ##  the prior SUZANNE_APPROVED_V1 soft/courtesy openings, which are      ##
 * ##  retired from the production selection pool.                          ##
 * ##                                                                       ##
 * ##  Editing an entry is a GOVERNANCE change requiring re-approval.       ##
 * ##  It is not a code change.                                             ##
 * ###########################################################################
 *
 * ===========================================================================
 * THIS FILE IS CONTENT, NOT LOGIC.
 *
 * It is maintained INDEPENDENTLY of dispute reasons and legal authorities.
 * Nothing here cites a statute, names a Decision Record, or references a
 * strategy. Voice and law are separate assets and version separately.
 *
 * ===========================================================================
 * THE HARD CONSTRAINT — READ THIS BEFORE ADDING ANYTHING
 *
 *   EVERY SENTENCE MUST BE TRUE OF EVERY CLIENT, IN EVERY ROUND,
 *   ABOUT EVERY ACCOUNT IN THE LETTER.
 *
 * FORBIDDEN, and enforced by test: MOTIVE, HARM, HISTORY, EMOTION, URGENCY,
 * ACCOUNT-specific claims. See governance for the full rationale.
 *
 * KRIS FIRM-LANGUAGE RULES (enforced by test):
 *   - State the dispute and the reinvestigation demand immediately.
 *   - No soft/courtesy language: no "I would appreciate", no "Thank you",
 *     no "Please investigate" as the demand, no gratitude for required action.
 *   - The reinvestigation demand must not sound optional.
 *
 * FACT-SPECIFIC OPENINGS: an opening that makes a shared-defect statement
 * (e.g. the Metro 2 missing-DOFD opening) may be selected ONLY when that defect
 * is true of EVERY disputed section in the letter. That gating is enforced by
 * the Letter Engine (which knows the sections), never by this content file.
 * ===========================================================================
 */

export const OPENING_LIBRARY_VERSION = "BT-OPENING-LIB-1.1";

// Machine-readable. The Letter Engine surfaces this on every letter so a
// placeholder library can never be mistaken for an approved one.
export const APPROVED_BY_BUSINESS_TRAPPERS = true;
export const APPROVAL = "KRIS_APPROVED_V1";
export const APPROVAL_DATE = "2026-07-16";

/**
 * GENERAL FIRM OPENINGS.
 *
 * `kind: "general"` — safe for ANY CRA dispute letter regardless of the mix of
 * dispute reasons, because they make no account-specific claim. These are the
 * default selection pool. Every one carries Kris's approved firm demand
 * verbatim as its final paragraph.
 *
 * They vary in STRUCTURE (how they lead in), never in the firmness or substance
 * of the demand — the approved demand sentence is identical across all of them.
 */
const APPROVED_GENERAL_DEMAND =
    "I am formally disputing the inaccurate and incomplete reporting identified below. " +
    "Conduct a reasonable reinvestigation of each disputed item and correct, update, or " +
    "delete any information that cannot be fully verified as accurate and complete.";

export const OPENINGS = Object.freeze([
    {
        id: "OPEN-GEN-001",
        kind: "general",
        // The approved general firm opening, used verbatim and unadorned.
        paragraphs: [APPROVED_GENERAL_DEMAND],
    },
    {
        id: "OPEN-GEN-002",
        kind: "general",
        paragraphs: [
            "This letter is a formal dispute of the reporting identified below.",
            APPROVED_GENERAL_DEMAND,
        ],
    },
    {
        id: "OPEN-GEN-003",
        kind: "general",
        paragraphs: [
            "I have reviewed my credit file and am disputing the entries identified below as inaccurate or incomplete.",
            APPROVED_GENERAL_DEMAND,
        ],
    },
    {
        id: "OPEN-GEN-004",
        kind: "general",
        paragraphs: [
            "The entries identified below are being reported inaccurately or incompletely, and I am formally disputing them.",
            APPROVED_GENERAL_DEMAND,
        ],
    },
    {
        id: "OPEN-GEN-005",
        kind: "general",
        paragraphs: [
            "I am submitting this formal dispute regarding the reporting identified below.",
            APPROVED_GENERAL_DEMAND,
        ],
    },
    {
        id: "OPEN-GEN-006",
        kind: "general",
        paragraphs: [
            "The reporting identified below is inaccurate and incomplete, and I dispute it formally.",
            APPROVED_GENERAL_DEMAND,
        ],
    },
]);

/**
 * FACT-SPECIFIC OPENINGS.
 *
 * `kind` names the shared defect the opening asserts. The Letter Engine may
 * select one of these ONLY when `requires` is true of every disputed section.
 * Otherwise it falls back to a general opening. This content never self-selects.
 */
export const FACT_SPECIFIC_OPENINGS = Object.freeze([
    {
        id: "OPEN-METRO2-DOFD-001",
        kind: "metro2_missing_dofd",
        // Selected only when every disputed section is a Metro 2 missing-DOFD
        // defect (BT-DM-0033) AND every section reports "CollectionOrChargeOff"
        // with no Date of First Delinquency. Enforced by the Letter Engine.
        requires: "metro2_missing_dofd",
        paragraphs: [
            'I am formally disputing the inaccurate and incomplete reporting identified below. ' +
            'Each listed tradeline is being reported as "CollectionOrChargeOff" without a Date of First Delinquency.',
            "The omission of the Date of First Delinquency prevents the lawful reporting period from " +
            "being determined and leaves the reporting incomplete and unverifiable as presented. " +
            "Conduct a reasonable reinvestigation of each disputed item and correct, update, or delete " +
            "any information that cannot be fully verified as accurate and complete.",
            "Each disputed tradeline is identified separately below.",
        ],
    },
]);

/** The approved general firm demand, exported for tests/verification. */
export const APPROVED_GENERAL_OPENING_TEXT = APPROVED_GENERAL_DEMAND;

/** Render an opening as text. */
export function renderOpening(entry) {
    return entry.paragraphs.join("\n\n");
}
