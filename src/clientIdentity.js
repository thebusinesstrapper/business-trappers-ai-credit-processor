/**
 * clientIdentity.js
 *
 * IDENTITY PROVENANCE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 *
 * The Letter Engine used to accept any object with a `name` and an `address` and
 * print "IDENTITY SOURCE: CRC client profile (authoritative)" beneath it.
 *
 * That line was a STRING LITERAL. Nothing verified it. A demo fixture with a
 * fabricated address sailed straight through and appeared on a dispute letter
 * over the client's signature, and the package cheerfully certified its own
 * correctness.
 *
 * A safety guarantee that is ASSERTED rather than ENFORCED is worse than no
 * guarantee, because it stops people looking.
 *
 * So identity now carries PROVENANCE, and the Letter Engine refuses anything it
 * cannot trace to the CRC client profile. There is no fallback. There is no
 * "best effort". If CRC cannot be read, no letter is written.
 * ---------------------------------------------------------------------------
 */

export const IDENTITY_SOURCE = Object.freeze({
    CRC_CLIENT_PROFILE: "crc_client_profile",
});

/**
 * Sources that may NEVER supply identity, per Extraction Decision 3.
 *
 * These are enumerated rather than merely "not allowed" so that a future
 * developer reaching for one hits a named refusal instead of a silent success.
 */
export const FORBIDDEN_IDENTITY_SOURCES = Object.freeze([
    "credit_report",
    "reported_personal_information",
    "historical_report",
    "array_io",
    "cached_report",
    "browser_state",
    "credit_hero",
    "demo_fixture",
    "hardcoded",
]);

const REQUIRED_FIELDS = ["name", "address_line_1", "city", "state", "postal_code"];

// ===========================================================================
// NORMALIZATION
//
// The DOM gives us whatever CRC's form happens to hold: "  Elizabeth  Suzanne
// Kelley ", "Florida", "fl", a trailing newline from a textarea. Those strings
// go on a legal document, and they are also the values we COMPARE — so an
// un-normalized identity produces two distinct bugs:
//
//   1. "5084  Louvinia Dr" prints with a double space on a letter to a bureau.
//   2. A comparison against "5084 Louvinia Dr" reports a mismatch that is not
//      real — which, in the status writer's protected-field check, would look
//      exactly like the form having silently corrupted the address.
//
// NORMALIZATION IS NOT CLEANUP. It is deliberately CONSERVATIVE:
//
//   WE DO:     trim, collapse repeated whitespace, canonicalize the state code.
//   WE DO NOT: title-case, expand "Dr" to "Drive", reformat the ZIP, strip
//              punctuation, or "fix" anything else.
//
// Anything beyond whitespace and the state code would be the processor REWRITING
// the consumer's address. If CRC holds "5084 Louvinia Dr", the letter says
// "5084 Louvinia Dr". We are not the authority on her address; CRC is.
//
// The RAW string is preserved alongside every normalized value, so a
// normalization bug is diagnosable from the record without re-running a browser.
// ===========================================================================

/** Trim and collapse runs of whitespace. Nothing else. */
function collapse(value) {
    if (value === null || value === undefined) return null;

    const cleaned = String(value).replace(/\s+/g, " ").trim();

    return cleaned === "" ? null : cleaned;
}

/**
 * US state -> canonical two-letter code.
 *
 * CRC may hold "Florida", "florida", "FL", or "Fla." depending on who typed it
 * and when. A letter is addressed with the code, and identity comparisons must
 * not report a false mismatch between "Florida" and "FL".
 */
const STATE_CODES = Object.freeze({
    ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
    COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC",
    FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL",
    INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA",
    MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN",
    MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
    "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
    "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK",
    OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
    VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI",
    WYOMING: "WY", "PUERTO RICO": "PR",
});

const VALID_CODES = new Set(Object.values(STATE_CODES));

/**
 * Canonicalize a state to its two-letter code.
 *
 * FAILS CLOSED: an unrecognised state returns null, which trips the required-field
 * check and stops the letter. We do NOT pass through a value we cannot recognise
 * — a bureau letter addressed to an unparseable state is a letter that does not
 * arrive, and guessing is how "FL" becomes "FI".
 */
export function canonicalState(value) {
    const cleaned = collapse(value);
    if (!cleaned) return null;

    const upper = cleaned.toUpperCase().replace(/\./g, "");

    if (VALID_CODES.has(upper)) return upper;      // already "FL"
    if (STATE_CODES[upper]) return STATE_CODES[upper]; // "FLORIDA" -> "FL"
    if (upper === "FLA") return "FL";              // common abbreviation

    return null;
}

/**
 * Normalize an identity immediately after capture.
 *
 * The NORMALIZED values are what flow downstream into letter generation. The raw
 * DOM strings are retained under `raw` for audit only, and nothing reads them.
 */
export function normalizeIdentity(identity) {
    const raw = {
        name: identity.name ?? null,
        address_line_1: identity.address_line_1 ?? null,
        address_line_2: identity.address_line_2 ?? null,
        city: identity.city ?? null,
        state: identity.state ?? null,
        postal_code: identity.postal_code ?? null,
    };

    return {
        ...identity,

        firstName: collapse(identity.firstName),
        middleName: collapse(identity.middleName),
        lastName: collapse(identity.lastName),

        name: collapse(identity.name),
        address_line_1: collapse(identity.address_line_1),
        address_line_2: collapse(identity.address_line_2),
        city: collapse(identity.city),
        state: canonicalState(identity.state),
        postal_code: collapse(identity.postal_code),

        email: collapse(identity.email),
        phone: collapse(identity.phone),

        normalized: true,
        raw, // audit only. Nothing downstream reads this.
    };
}

/** Is a value already normalized? Used by verifyIdentity to refuse raw strings. */
function isNormalized(value) {
    if (value === null || value === undefined) return true;

    const s = String(value);

    return s === s.trim() && !/\s{2,}/.test(s);
}

/**
 * Build a verified identity from a CRC client profile read.
 *
 * @param {object} profile   fields read from the CRC client profile page
 * @param {object} meta      { crcClientId, retrievedAt, sourceUrl }
 */
export function fromCrcProfile(profile, meta = {}) {
    // Normalized here too, so EVERY construction path produces normalized values.
    // If one path did not, raw DOM strings could still reach a letter through it —
    // and that path would be the one nobody tested.
    return normalizeIdentity({
        source: IDENTITY_SOURCE.CRC_CLIENT_PROFILE,
        crcClientId: meta.crcClientId ?? null,
        retrievedAt: meta.retrievedAt ?? new Date().toISOString(),
        sourceUrl: meta.sourceUrl ?? null,

        name: profile.name ?? null,
        address_line_1: profile.address_line_1 ?? null,
        address_line_2: profile.address_line_2 ?? null,
        city: profile.city ?? null,
        state: profile.state ?? null,
        postal_code: profile.postal_code ?? null,
    });
}

/**
 * Verify an identity is usable for correspondence.
 *
 * FAILS CLOSED. Every failure mode returns a reason; none returns a default.
 *
 * @returns {{ ok: boolean, errors: string[], identity: object|null }}
 */
export function verifyIdentity(identity) {
    const errors = [];

    if (!identity || typeof identity !== "object") {
        return {
            ok: false,
            identity: null,
            errors: [
                "No client identity supplied. Identity comes from the CRC client profile and " +
                "nowhere else. No letter is generated without it.",
            ],
        };
    }

    // THE PROVENANCE CHECK. This is the one that would have caught the
    // fabricated demo address.
    if (identity.source !== IDENTITY_SOURCE.CRC_CLIENT_PROFILE) {
        errors.push(
            `Identity source is "${identity.source ?? "(none)"}", not "${IDENTITY_SOURCE.CRC_CLIENT_PROFILE}". ` +
            `Identity may come ONLY from the CRC client profile — never from a credit report, a ` +
            `historical report, Array.io, cached report data, browser state, or a test fixture. ` +
            `Letter generation stops rather than substituting another address.`
        );
    }

    if (FORBIDDEN_IDENTITY_SOURCES.includes(identity.source)) {
        errors.push(`Identity source "${identity.source}" is explicitly forbidden.`);
    }

    if (!identity.crcClientId) {
        errors.push(
            "Identity carries no CRC client ID, so it cannot be tied to a specific CRC client " +
            "record. An identity we cannot trace to a client is an identity we do not sign a " +
            "letter with."
        );
    }

    for (const field of REQUIRED_FIELDS) {
        if (!identity[field] || !String(identity[field]).trim()) {
            errors.push(`CRC client profile is missing a required field: ${field}.`);
        }
    }

    // ---- NORMALIZATION IS MANDATORY, NOT ADVISORY ------------------------
    //
    // Verification compares NORMALIZED values. If a module hands us raw DOM
    // strings, we refuse them rather than normalizing on the fly — because a
    // silent fix here would mean the raw string is what flowed downstream, and
    // the letter would still print the double space.
    if (identity.normalized !== true) {
        errors.push(
            "Identity has not been normalized. Raw DOM strings must never reach letter generation: " +
            "trailing whitespace prints on the letter, and an un-collapsed value produces false " +
            "mismatches in the protected-field comparison. Call normalizeIdentity() at capture."
        );
    }

    for (const field of REQUIRED_FIELDS) {
        if (!isNormalized(identity[field])) {
            errors.push(
                `Field "${field}" contains untrimmed or repeated whitespace: ` +
                `${JSON.stringify(identity[field])}. This would print verbatim on a bureau letter.`
            );
        }
    }

    // The state must be the canonical code. An unrecognised state is a letter
    // that does not arrive.
    if (identity.state && !VALID_CODES.has(String(identity.state))) {
        errors.push(
            `State "${identity.state}" is not a canonical two-letter code. CRC may hold "Florida" ` +
            `or "fl"; the letter must carry "FL", and comparisons must not report a false mismatch ` +
            `between the two.`
        );
    }

    return { ok: errors.length === 0, errors, identity: errors.length === 0 ? identity : null };
}

/** The mailing block, exactly as CRC holds it. */
export function formatAddress(identity) {
    return [
        identity.address_line_1,
        identity.address_line_2,
        `${identity.city}, ${identity.state} ${identity.postal_code}`,
    ]
        .filter(Boolean)
        .join("\n");
}
