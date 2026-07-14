/**
 * recipientLibrary.js
 *
 * BUSINESS TRAPPERS RECIPIENT STANDARD™
 * Confidential & Proprietary.
 *
 * ===========================================================================
 * NO GENERIC GREETINGS. EVER.
 *
 *   FORBIDDEN:  "Dear Credit Reporting Agency"
 *               "Dear Sir or Madam"
 *               "To Whom It May Concern"
 *
 * A generic greeting is the single clearest tell that a letter was mass-produced
 * and mail-merged. It says, in the first line a bureau reads, that the sender
 * did not know or care who they were writing to — and it invites the letter to
 * be treated exactly as what it appears to be.
 *
 * A real consumer writing to Experian writes to EXPERIAN.
 *
 * ===========================================================================
 * THE RECIPIENT IS DERIVED, NOT SELECTED.
 *
 * This is NOT a voice library, and it is deliberately kept apart from one. The
 * Opening, Transition and Closing libraries VARY — that is their whole purpose.
 * The recipient must NEVER vary: there is exactly one correct legal entity name
 * and one correct dispute address per bureau, and "variation" here would mean
 * getting it wrong.
 *
 * Mixing the two would eventually seed a bureau name into a rotation, and a
 * letter addressed to the wrong company is not a stylistic defect — it is a
 * dispute that never arrives.
 *
 * The bureau determines the recipient. Full stop.
 * ===========================================================================
 */

export const RECIPIENT_STANDARD_VERSION = "BT-RECIPIENT-1.0";

/**
 * Legal entity names and consumer dispute addresses.
 *
 * These are FACTS, not style. They are verified against each bureau's published
 * consumer dispute address and change only when a bureau changes them.
 */
export const BUREAUS = Object.freeze({
    transunion: {
        key: "transunion",
        shortName: "TransUnion",
        legalName: "TransUnion LLC",
        addressLines: [
            "TransUnion LLC",
            "Consumer Dispute Center",
            "P.O. Box 2000",
            "Chester, PA 19016-2000",
        ],
        greeting: "Dear TransUnion Representative,",
    },

    experian: {
        key: "experian",
        shortName: "Experian",
        legalName: "Experian Information Solutions, Inc.",
        addressLines: [
            "Experian Information Solutions, Inc.",
            "P.O. Box 4500",
            "Allen, TX 75013",
        ],
        greeting: "Dear Experian Representative,",
    },

    equifax: {
        key: "equifax",
        shortName: "Equifax",
        legalName: "Equifax Information Services LLC",
        addressLines: [
            "Equifax Information Services LLC",
            "P.O. Box 740256",
            "Atlanta, GA 30374-0256",
        ],
        greeting: "Dear Equifax Representative,",
    },
});

/**
 * Resolve the recipient for a bureau.
 *
 * FAILS CLOSED. An unknown bureau does NOT fall back to a generic greeting —
 * that is precisely the failure this module exists to prevent, and a fallback
 * would quietly reintroduce it the first time a bureau key was misspelled.
 *
 * No recipient, no letter.
 */
export function resolveRecipient(bureau) {
    const entry = BUREAUS[String(bureau ?? "").toLowerCase()];

    if (!entry) {
        return {
            ok: false,
            error:
                `Unknown bureau "${bureau}". No recipient can be resolved, and this engine does NOT ` +
                `fall back to a generic greeting — "Dear Credit Reporting Agency" is exactly what the ` +
                `Recipient Standard forbids. No letter is generated.`,
        };
    }

    return {
        ok: true,
        bureau: entry.key,
        shortName: entry.shortName,
        legalName: entry.legalName,
        addressBlock: entry.addressLines.join("\n"),
        greeting: entry.greeting,
    };
}

/** Every bureau this engine can write to. */
export function supportedBureaus() {
    return Object.keys(BUREAUS);
}
