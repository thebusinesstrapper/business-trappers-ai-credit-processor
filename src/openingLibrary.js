/**
 * openingLibrary.js
 *
 * BUSINESS TRAPPERS OPENING LIBRARY™
 * Confidential & Proprietary.
 *
 * ###########################################################################
 * ##  STATUS: SUZANNE_APPROVED_V1                                          ##
 * ##                                                                       ##
 * ##  These 10 openings are APPROVED Business Trappers content.            ##
 * ##  They are the Version 1 production Opening Library.                   ##
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
 * strategy. Voice and law are separate assets and version separately: a
 * statutory change must never require editing prose, and a prose edit must
 * never be able to change a legal citation.
 *
 * Adding or editing an entry is a GOVERNANCE change requiring Kris's approval.
 * It is not a code change.
 *
 * ===========================================================================
 * THE HARD CONSTRAINT — READ THIS BEFORE ADDING ANYTHING
 *
 *   EVERY SENTENCE MUST BE TRUE OF EVERY CLIENT, IN EVERY ROUND,
 *   ABOUT EVERY ACCOUNT IN THE LETTER.
 *
 * A one-line opening is easy to keep honest. Three paragraphs is not — length
 * is surface area, and the natural-sounding filler that credit-repair letters
 * are full of is exactly where false statements hide. The consumer signs this.
 *
 * FORBIDDEN, and enforced by test:
 *
 *   MOTIVE     "I applied for a mortgage and discovered..."
 *              We do not know why she pulled her report. Inventing a reason is
 *              inventing a fact.
 *
 *   HARM       "These errors have damaged my credit and cost me opportunities."
 *              A damages claim. Unproven, and it converts a dispute letter into
 *              the opening of a lawsuit nobody authorized.
 *
 *   HISTORY    "As I told you in my previous letter..."
 *              FALSE for any first-round account. One bureau letter carries
 *              first-round AND escalated accounts side by side, and the opening
 *              speaks for ALL of them. Per-account history belongs in the
 *              account section, where it is true of that account alone.
 *
 *   EMOTION    "I am extremely frustrated by your repeated failures."
 *              The Writing Style Guide forbids it, and it reads as a template
 *              the moment a bureau sees it twice.
 *
 *   URGENCY    "I need this resolved before my closing date."
 *              A deadline we cannot verify, asserted on her behalf.
 *
 *   ACCOUNT    "The Capital One account is fraudulent."
 *              The opening speaks for the WHOLE letter. Account-specific claims
 *              belong in account sections, where they are supported.
 *
 * PERMITTED: that she reviewed her report, that she believes the listed items
 * are inaccurate or incomplete, and that she is requesting an investigation.
 * All three are true for every letter this system will ever send.
 * ===========================================================================
 */

export const OPENING_LIBRARY_VERSION = "BT-OPENING-LIB-1.0";

// Machine-readable. The Letter Engine surfaces this on every letter so a
// placeholder library can never be mistaken for an approved one.
export const APPROVED_BY_BUSINESS_TRAPPERS = true;
export const APPROVAL = "SUZANNE_APPROVED_V1";

/**
 * Each entry is 2–3 paragraphs, joined with a blank line.
 *
 * They differ in STRUCTURE, not just wording — sentence order, rhythm, and where
 * the request lands. Eight paraphrases of one sentence still read as one letter;
 * a bureau comparing a hundred of them would see the shape, not the synonyms.
 */
export const OPENINGS = Object.freeze([
    {
        id: "OPEN-001",
        paragraphs: [
            "I am writing to dispute information that appears on my credit file.",
            "I recently reviewed my credit report and found entries I believe are inaccurate or incomplete. I have identified each one below and explained why I am disputing it.",
            "I am asking that you conduct a reasonable investigation into each item and correct or remove anything that cannot be verified as accurate and complete.",
        ],
    },
    {
        id: "OPEN-002",
        paragraphs: [
            "I obtained a copy of my credit report and reviewed it carefully. Several entries do not appear to be accurate or complete, and I am writing to dispute them.",
            "Each account I am disputing is set out below, along with the specific problem I identified and the correction I am requesting.",
            "Please investigate each one and let me know the outcome.",
        ],
    },
    {
        id: "OPEN-003",
        paragraphs: [
            "This letter is to dispute information being reported on my credit file.",
            "After going through my credit report, I identified entries that I believe are being reported inaccurately or incompletely. I have listed each of them below with the reason for my dispute.",
            "I would like each item investigated, and I am asking that anything that cannot be verified as accurate and complete be corrected or removed from my file.",
        ],
    },
    {
        id: "OPEN-004",
        paragraphs: [
            "I am disputing the accuracy and completeness of several entries on my credit report.",
            "I have reviewed the report in detail. The accounts described below do not appear to be reported correctly, and I have set out what I found in each case.",
            "I am requesting a reasonable investigation of each account. If the information cannot be verified as accurate and complete, please correct it or remove it.",
        ],
    },
    {
        id: "OPEN-005",
        paragraphs: [
            "I am writing about information on my credit file that I believe is being reported in error.",
            "I reviewed my credit report and found the entries listed below. In each case I have described what appears to be wrong with the reporting.",
            "Please investigate each account and provide me with the results of your investigation.",
        ],
    },
    {
        id: "OPEN-006",
        paragraphs: [
            "I have reviewed my credit report and need to dispute several of the entries on it.",
            "The accounts are identified individually below. For each one I have explained the specific issue I found with the way it is being reported and what I am asking you to do about it.",
            "I am requesting a reasonable investigation of each item.",
        ],
    },
    {
        id: "OPEN-007",
        paragraphs: [
            "I am contacting you to dispute information appearing on my credit file.",
            "My review of the report identified accounts that I believe are inaccurate or incomplete. Each is described below, together with the reason it is being disputed.",
            "I ask that you investigate each account and correct or delete any information that cannot be verified as accurate and complete.",
        ],
    },
    {
        id: "OPEN-008",
        paragraphs: [
            "The purpose of this letter is to dispute entries on my credit report that I believe are inaccurate or incomplete.",
            "I have gone through the report and identified the accounts listed below. For each, I have set out the specific problem with the reporting.",
            "Please conduct a reasonable investigation and let me know in writing what you find.",
        ],
    },
    {
        id: "OPEN-009",
        paragraphs: [
            "I am disputing information on my credit file.",
            "I recently reviewed my report and found several entries that do not appear to be reported accurately or completely. Each one is identified below with the reason for the dispute.",
            "I am asking that each account be investigated and that anything which cannot be verified be corrected or removed.",
        ],
    },
    {
        id: "OPEN-010",
        paragraphs: [
            "I reviewed my credit report and identified information I believe is being reported incorrectly. I am writing to dispute it.",
            "Below I have listed each account individually, along with what I found and the action I am requesting.",
            "I would appreciate a reasonable investigation into each item and written notice of the results.",
        ],
    },
]);

/** Render an opening as text. */
export function renderOpening(entry) {
    return entry.paragraphs.join("\n\n");
}
