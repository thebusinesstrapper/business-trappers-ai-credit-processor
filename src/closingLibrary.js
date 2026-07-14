/**
 * closingLibrary.js
 *
 * BUSINESS TRAPPERS CLOSING LIBRARY™
 * Confidential & Proprietary. Kris-approved text only.
 *
 * ===========================================================================
 * SAME HARD CONSTRAINT. The closing is where letters go wrong most often,
 * because it is where a writer reaches for leverage:
 *
 *   THREATS      "If this is not resolved I will be forced to take legal action."
 *                The Writing Style Guide forbids threats, and the Letter
 *                Generation Engine's Never Rules forbid threatening litigation.
 *                It is also a commitment made on the consumer's behalf that she
 *                never authorized and may not want.
 *
 *   DEADLINES    "You have 30 days to respond or the items must be deleted."
 *                This states a legal conclusion as though it were automatic. It
 *                is not, and asserting it is a legal claim the Closing Library —
 *                which holds no authorities — has no business making.
 *
 *   PROMISES     "I look forward to these items being removed."
 *                Presumes the outcome of an investigation that has not happened.
 *
 *   HISTORY      "I should not have to write to you again."
 *                False for a first-round letter.
 *
 * A closing may ask for the results in writing and thank the reader. That is
 * the whole permitted surface — and it is enough. A calm, professional close is
 * more credible than a threatened one, and it keeps the record clean if the
 * matter ever does escalate.
 *
 * The signature block is NOT part of this library. It is identity, and identity
 * comes from CRC.
 * ===========================================================================
 */

export const CLOSING_LIBRARY_VERSION = "BT-CLOSING-LIB-1.0";

export const CLOSINGS = Object.freeze([
    {
        id: "CLOSE-001",
        paragraphs: [
            "Please provide the results of your investigation in writing.",
            "Thank you for your attention to this matter.",
        ],
    },
    {
        id: "CLOSE-002",
        paragraphs: [
            "I would appreciate receiving the results of your investigation in writing once it is complete.",
            "Thank you for your time.",
        ],
    },
    {
        id: "CLOSE-003",
        paragraphs: [
            "Please send me the results of your investigation in writing when it has been completed.",
            "Thank you for looking into this.",
        ],
    },
    {
        id: "CLOSE-004",
        paragraphs: [
            "I ask that the results of your investigation be provided to me in writing.",
            "Thank you for your prompt attention to this matter.",
        ],
    },
    {
        id: "CLOSE-005",
        paragraphs: [
            "Please confirm the outcome of your investigation to me in writing.",
            "I appreciate your assistance.",
        ],
    },
    {
        id: "CLOSE-006",
        paragraphs: [
            "When your investigation is complete, please provide the results to me in writing.",
            "Thank you for your help with this.",
        ],
    },
    {
        id: "CLOSE-007",
        paragraphs: [
            "I would like to receive written notice of the results of your investigation.",
            "Thank you for your attention to these accounts.",
        ],
    },
]);

/** Render a closing as text. */
export function renderClosing(entry) {
    return entry.paragraphs.join("\n\n");
}
