/**
 * crcBureauRecipients.js
 *
 * BUSINESS TRAPPERS — CRC RECIPIENT MAP (M8)
 * Confidential & Proprietary.
 *
 * ===========================================================================
 * PURPOSE
 *
 * Credit Repair Cloud's Dispute Wizard asks for the bureau recipient as FIVE
 * DISCRETE FORM FIELDS: Company Name, Address, City, State (a dropdown), and
 * ZIP. The M7 letter engine, by contrast, stores each bureau's dispute address
 * as a single multi-line block (recipientLibrary.js) — correct for a letter,
 * wrong for a form.
 *
 * This module is the SEPARATE, CRC-SPECIFIC source of those discrete fields. It
 * exists so that M8 never has to parse a City/State/ZIP out of an address
 * string at runtime (fragile, and a way to silently mis-file a dispute). Every
 * field here is STORED EXPLICITLY and VALIDATED.
 *
 * SEPARATION: this module does NOT import from, modify, or depend on
 * recipientLibrary.js or any M7 code. The VALUES were taken, once, from the
 * currently-approved recipientLibrary.js records (they must stay in agreement),
 * but they are copied in as literals here — not parsed, not derived at runtime.
 *
 * FAIL CLOSED: an unsupported bureau, or a record missing/!malformed on any
 * required field, returns { ok: false }. The caller routes to Manual Review.
 * No generic fallback address is ever produced.
 * ===========================================================================
 */

export const CRC_RECIPIENTS_VERSION = "BT-CRC-RECIPIENTS-1.0";

/**
 * Discrete CRC form fields per bureau, keyed by normalized bureau name.
 *
 * Values copied verbatim from the approved recipientLibrary.js address blocks:
 *   TransUnion: "TransUnion LLC" / "Consumer Dispute Center" / "P.O. Box 2000"
 *               / "Chester, PA 19016-2000"
 *   Experian:   "Experian Information Solutions, Inc." / "P.O. Box 4500"
 *               / "Allen, TX 75013"
 *   Equifax:    "Equifax Information Services LLC" / "P.O. Box 740256"
 *               / "Atlanta, GA 30374-0256"
 *
 * The "address" field carries the street/PO-box portion. Where the approved
 * block has an extra routing line (TransUnion's "Consumer Dispute Center"), it
 * is preserved inside the single CRC Address field so no approved line is lost.
 */
const CRC_RECIPIENTS = Object.freeze({
    experian: Object.freeze({
        companyName: "Experian Information Solutions, Inc.",
        address: "P.O. Box 4500",
        address2: "",                     // no second line for Experian
        city: "Allen",
        state: "TX",
        zip: "75013",
    }),
    transunion: Object.freeze({
        // The approved TransUnion block has TWO address lines. They are preserved
        // SEPARATELY here — never combined. CRC's form has an optional second
        // address field; whether CRC renders "Address" then "Address 2" (and
        // whether the preferred mailing order below can be preserved) is PENDING
        // LIVE DISCOVERY. Do not silently reorder or merge these.
        //
        //   Preferred mailing order:
        //     TransUnion LLC
        //     Consumer Dispute Center
        //     P.O. Box 2000
        //     Chester, PA 19016-2000
        companyName: "TransUnion LLC",
        address: "P.O. Box 2000",
        address2: "Consumer Dispute Center",
        city: "Chester",
        state: "PA",
        zip: "19016-2000",
    }),
    equifax: Object.freeze({
        companyName: "Equifax Information Services LLC",
        address: "P.O. Box 740256",
        address2: "",                     // no second line for Equifax
        city: "Atlanta",
        state: "GA",
        zip: "30374-0256",
    }),
});

// PENDING DISCOVERY (TransUnion two-line address):
//   1. the actual field name/selector for CRC's optional second-address field;
//   2. whether CRC prints Address first and Address 2 second;
//   3. whether the preferred mailing order (company / Consumer Dispute Center /
//      P.O. Box 2000 / Chester, PA 19016-2000) can be preserved;
//   4. whether CRC accepts and preserves ZIP+4 in the ZIP field. If CRC does not
//      accept ZIP+4, STOP and report — do not silently shorten the approved ZIP.
// If CRC renders the optional field AFTER the main Address with no way to
// preserve the order, STOP and report before implementing M8 — do not combine
// the lines or change the approved block.
export const TRANSUNION_ADDRESS_ORDER_PENDING_DISCOVERY = true;

/** The bureaus this map supports. */
export function supportedCrcBureaus() {
    return Object.keys(CRC_RECIPIENTS);
}

/**
 * Normalize a bureau name to a supported key, safely.
 *
 * Accepts the common spellings/casings/spacings CRC or the letter object might
 * present ("Experian", "EXPERIAN", "trans union", "TransUnion", "equifax ").
 * Returns a canonical key ("experian" | "transunion" | "equifax") or null.
 *
 * Deliberately conservative: anything it does not positively recognize returns
 * null, so the caller fails closed rather than guessing.
 */
export function normalizeBureau(bureau) {
    if (typeof bureau !== "string") return null;
    const collapsed = bureau.trim().toLowerCase().replace(/[\s._-]+/g, "");
    if (collapsed === "experian") return "experian";
    if (collapsed === "transunion") return "transunion";
    if (collapsed === "equifax") return "equifax";
    return null;
}

// US state abbreviation set — used to validate the STORED records and to give
// the caller a positive check that the State value is a real two-letter code
// (CRC's State control is a dropdown of abbreviations).
const US_STATES = new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC",
]);

/** A ZIP is valid if it is 5 digits or ZIP+4 (5 digits, hyphen, 4 digits). */
export function isValidZip(zip) {
    return typeof zip === "string" && /^\d{5}(-\d{4})?$/.test(zip);
}

/** A state is valid if it is a known US two-letter abbreviation. */
export function isValidState(state) {
    return typeof state === "string" && US_STATES.has(state);
}

/**
 * Validate that a recipient record has every required field, well-formed.
 * Returns { ok: true } or { ok: false, error }.
 */
function validateRecord(record) {
    const required = ["companyName", "address", "city", "state", "zip"];
    for (const field of required) {
        const value = record?.[field];
        if (typeof value !== "string" || value.trim() === "") {
            return { ok: false, error: `Recipient record is missing or empty field "${field}".` };
        }
    }
    // address2 is OPTIONAL, but when present it must be a string (never null/other).
    if (record.address2 !== undefined && typeof record.address2 !== "string") {
        return { ok: false, error: `Recipient field "address2" must be a string when present.` };
    }
    if (!isValidState(record.state)) {
        return { ok: false, error: `Recipient state "${record.state}" is not a valid US abbreviation.` };
    }
    if (!isValidZip(record.zip)) {
        return { ok: false, error: `Recipient ZIP "${record.zip}" is not a valid 5- or 9-digit ZIP.` };
    }
    return { ok: true };
}

/**
 * Resolve the discrete CRC form fields for a bureau. FAILS CLOSED.
 *
 * @param {string} bureau  any casing/spacing of experian | transunion | equifax
 * @returns {{ ok: true, bureau, recipient: {companyName,address,city,state,zip} }
 *          | { ok: false, error }}
 */
export function crcRecipientFor(bureau) {
    const key = normalizeBureau(bureau);
    if (!key) {
        return {
            ok: false,
            error:
                `Unsupported bureau "${bureau}". CRC recipient data exists only for ` +
                `Experian, TransUnion, and Equifax. No recipient resolved; route to Manual Review.`,
        };
    }
    const record = CRC_RECIPIENTS[key];
    const valid = validateRecord(record);
    if (!valid.ok) {
        return { ok: false, error: `CRC recipient record for "${key}" is invalid: ${valid.error}` };
    }
    // Return a shallow copy so callers cannot mutate the frozen source.
    return { ok: true, bureau: key, recipient: { ...record } };
}
