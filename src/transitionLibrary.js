/**
 * transitionLibrary.js
 *
 * BUSINESS TRAPPERS TRANSITION LIBRARY™
 * Confidential & Proprietary.
 *
 * ###########################################################################
 * ##  STATUS: V1 MINIMAL — sufficient to unblock production validation.    ##
 * ##                                                                       ##
 * ##  Deliberately SMALL. A transition is one line; the variation that     ##
 * ##  matters lives in the Opening Library. Expanding this is not on the   ##
 * ##  critical path and must not delay the real report run.                ##
 * ###########################################################################
 *
 * ===========================================================================
 * The bridge from the introduction into the account sections.
 *
 * Small, but it is the seam a reader notices. Without it, a letter lurches from
 * a personal introduction straight into a formatted block — which is exactly
 * what a generated document looks like.
 *
 * SAME HARD CONSTRAINT AS THE OPENING LIBRARY:
 *
 *   Every sentence must be true of EVERY client, in EVERY round, about EVERY
 *   account in the letter.
 *
 * A transition is especially prone to two failures, because it is where a writer
 * naturally reaches for a summarising claim:
 *
 *   COUNTING   "The three accounts below..."
 *              The count varies per letter. A hardcoded number would be wrong
 *              the moment the letter changes, and nobody would notice — the
 *              sentence still reads perfectly.
 *
 *   CHARACTER  "Each of the following accounts is being reported fraudulently."
 *              The transition speaks for ALL accounts. Most letters mix a proven
 *              defect with a bare §611 request, and a blanket characterisation
 *              would assert something untrue about the milder ones.
 *
 * A transition may say only that the disputed accounts follow, and that each
 * carries its own explanation. Nothing more.
 * ===========================================================================
 */

export const TRANSITION_LIBRARY_VERSION = "BT-TRANSITION-LIB-1.0";

// Machine-readable. The Letter Engine surfaces this on every letter so a
// placeholder library can never be mistaken for an approved one.
export const APPROVED_BY_BUSINESS_TRAPPERS = true;
export const APPROVAL = "V1_MINIMAL";

export const TRANSITIONS = Object.freeze([
    { id: "TRANS-001", text: "The accounts I am disputing are set out below." },
    { id: "TRANS-002", text: "Each disputed account is listed separately below." },
    { id: "TRANS-003", text: "I have described each account I am disputing individually below." },
    { id: "TRANS-004", text: "The disputed accounts are identified below, each with its own explanation." },
]);
