/**
 * closingLibrary.js
 *
 * BUSINESS TRAPPERS CLOSING LIBRARY™
 * Confidential & Proprietary.
 *
 * ###########################################################################
 * ##  STATUS: KRIS_APPROVED_V1                                             ##
 * ##  Approval date: 2026-07-16                                            ##
 * ##                                                                       ##
 * ##  Incorporates the firm results-demand closing Kris approved on        ##
 * ##  2026-07-16. SUPERSEDES the prior soft "thank you" closings, which    ##
 * ##  are retired from the production selection pool.                      ##
 * ###########################################################################
 *
 * ===========================================================================
 * KRIS FIRM-LANGUAGE RULES (enforced by test):
 *   - Demand the written results, an updated file copy, and the procedure.
 *   - State the expectation that each item be corrected, updated, or deleted
 *     per the reinvestigation results.
 *   - NO soft thank-you paragraph. NO "I would appreciate". NO gratitude for
 *     legally required action. Nothing that makes the demand sound optional.
 *
 * The signature block is NOT part of this library. It is identity, and identity
 * comes from CRC.
 * ===========================================================================
 */

export const CLOSING_LIBRARY_VERSION = "BT-CLOSING-LIB-1.1";

// Machine-readable. Surfaced on every letter.
export const APPROVED_BY_BUSINESS_TRAPPERS = true;
export const APPROVAL = "KRIS_APPROVED_V1";
export const APPROVAL_DATE = "2026-07-16";

/**
 * The approved firm closing. Two paragraphs: the results demand, then the
 * expectation of action. Used verbatim.
 */
const APPROVED_RESULTS_DEMAND =
    "Provide the written results of your reinvestigation, an updated copy of my credit file, " +
    "and a description of the procedure used to determine the accuracy and completeness of each disputed item.";

const APPROVED_ACTION_EXPECTATION =
    "I expect each item to be corrected, updated, or deleted as required by the results of your reinvestigation.";

export const CLOSINGS = Object.freeze([
    {
        id: "CLOSE-KRIS-001",
        paragraphs: [APPROVED_RESULTS_DEMAND, APPROVED_ACTION_EXPECTATION],
    },
    {
        id: "CLOSE-KRIS-002",
        // Firm results demand, distinct wording for deterministic variation. No
        // soft "Please provide" lead-in and no redundant "in writing, the written
        // results"; the demand is stated directly and is never softened. Kept
        // textually distinct from CLOSE-KRIS-001 so no two letters read identically.
        paragraphs: [
            "Provide, in writing, the results of your reinvestigation, an updated copy of my credit " +
            "file, and a description of the procedure used to determine the accuracy and completeness " +
            "of each disputed item.",
            APPROVED_ACTION_EXPECTATION,
        ],
    },
    {
        id: "CLOSE-KRIS-003",
        paragraphs: [
            "Provide the written results of your reinvestigation, an updated copy of my credit file, and " +
            "a description of the procedure you used to determine the accuracy and completeness of each disputed item.",
            "I expect each item to be corrected, updated, or deleted as the results of your reinvestigation require.",
        ],
    },
]);

/** The approved closing text, exported for tests/verification. */
export const APPROVED_CLOSING_TEXT = [APPROVED_RESULTS_DEMAND, APPROVED_ACTION_EXPECTATION].join("\n\n");

/** Render a closing as text. */
export function renderClosing(entry) {
    return entry.paragraphs.join("\n\n");
}
