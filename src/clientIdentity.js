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

/**
 * Build a verified identity from a CRC client profile read.
 *
 * @param {object} profile   fields read from the CRC client profile page
 * @param {object} meta      { crcClientId, retrievedAt, sourceUrl }
 */
export function fromCrcProfile(profile, meta = {}) {
    return {
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
    };
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
