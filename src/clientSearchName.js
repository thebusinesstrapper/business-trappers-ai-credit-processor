/**
 * clientSearchName.js — CRC CLIENT SEARCH suffix handling (search-only).
 *
 * WHY THIS EXISTS. CRC's Clients search does not reliably return a client when a
 * personal-name suffix ("II", "IV", ...) is included in the search text, so
 * clients like "Joseph Manning II" and "William Harrell IV" are not found by an
 * exact full-name search. This module produces a SEARCH-ONLY fallback name with
 * a recognized trailing suffix removed, and verifies which returned CRC row is
 * the correct client.
 *
 * IDENTITY IS NEVER REWRITTEN. The authoritative client name — suffix included —
 * is preserved everywhere (Supabase, queue, dashboard, letters, identity/final
 * verification). Nothing here mutates or persists a name. The base name exists
 * ONLY as a transient CRC search string; the caller keeps using the full name
 * for identity and for final verification of the row it opens.
 *
 * PURE. No I/O, no Playwright, no Supabase. The caller (openClient) performs the
 * actual search and row opening; this module only decides the search text and
 * which row (if any) is unambiguously correct.
 */

// Recognized PERSONAL-name suffixes, matched case-insensitively at the END of
// the name only. Distinct from itemKey.js's furnisher/business suffix list
// (INC, LLC, ...) on purpose — different domain, different rules.
const PERSONAL_NAME_SUFFIXES = Object.freeze([
    "Jr", "Jr.", "Sr", "Sr.", "II", "III", "IV", "V",
]);

// Build one alternation that matches a trailing suffix, tolerating a trailing
// period and surrounding whitespace. Longer forms first so "Jr." wins over "Jr".
const SUFFIX_PATTERN = new RegExp(
    "\\s+(" +
        PERSONAL_NAME_SUFFIXES
            .map((s) => s.replace(/\./g, "\\.?"))
            .sort((a, b) => b.length - a.length)
            .join("|") +
        ")\\.?\\s*$",
    "i"
);

/**
 * Whether a name ends in a recognized personal suffix.
 * @param {string} name
 * @returns {boolean}
 */
export function hasPersonalNameSuffix(name) {
    if (typeof name !== "string") return false;
    return SUFFIX_PATTERN.test(name.trim());
}

/**
 * The CRC-search base name: the full name with a single recognized trailing
 * suffix removed. Returns null when there is no recognized suffix (so the caller
 * knows there is no distinct fallback to try). NEVER used as an identity value.
 * @param {string} name
 * @returns {string|null}
 */
export function baseSearchName(name) {
    if (typeof name !== "string") return null;
    const trimmed = name.trim();
    const stripped = trimmed.replace(SUFFIX_PATTERN, "").trim();
    // Only a real change, and only if something meaningful remains, counts.
    if (stripped && stripped !== trimmed) return stripped;
    return null;
}

/**
 * The ordered list of CRC search terms to try: the FULL authoritative name
 * first, then the suffix-free base name as a fallback (only when one exists).
 * De-duplicated, order preserved.
 * @param {string} fullName
 * @returns {string[]}
 */
export function searchTermsFor(fullName) {
    const terms = [];
    if (typeof fullName === "string" && fullName.trim()) terms.push(fullName.trim());
    const base = baseSearchName(fullName);
    if (base && !terms.includes(base)) terms.push(base);
    return terms;
}

/** Normalize a displayed name for comparison: collapse spaces, lowercase. */
function normalizeForCompare(value) {
    return typeof value === "string"
        ? value.replace(/\s+/g, " ").trim().toLowerCase()
        : "";
}

/**
 * Choose the correct CRC row from search results, using existing identity
 * signals in priority order:
 *   1. Known CRC client ID (authoritative) — an exact id match wins outright.
 *   2. Exact full displayed-name match (suffix included).
 *   3. Exact base-name match (suffix-free), used only for the fallback search.
 *
 * FAILS CLOSED. If, after these checks, more than one row is still plausible and
 * none is uniquely identified, returns ambiguous:true with
 * blockedReason "ambiguous_client_match" — the caller must route to Manual
 * Review and must NOT auto-open a row.
 *
 * @param {Array<{clientName?:string, crcClientId?:string|number}>} rows
 * @param {{ fullName:string, knownCrcClientId?:string|number|null }} identity
 * @returns {{ matched:true, row:object }
 *          | { matched:false, ambiguous:true, blockedReason:"ambiguous_client_match", candidates:number }
 *          | { matched:false, ambiguous:false, candidates:0 }}
 */
export function selectClientRow(rows, identity) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (list.length === 0) return { matched: false, ambiguous: false, candidates: 0 };

    const fullName = identity?.fullName ?? "";
    const knownId =
        identity?.knownCrcClientId != null ? String(identity.knownCrcClientId) : null;

    // 1. Known CRC client ID is authoritative.
    if (knownId) {
        const byId = list.filter((r) => String(r.crcClientId ?? "") === knownId);
        if (byId.length === 1) return { matched: true, row: byId[0] };
        // Two rows claiming the same id is a data problem — fail closed.
        if (byId.length > 1) {
            return {
                matched: false,
                ambiguous: true,
                blockedReason: "ambiguous_client_match",
                candidates: byId.length,
            };
        }
    }

    // 2. Exact full displayed-name match (suffix included).
    const wantFull = normalizeForCompare(fullName);
    const byFull = list.filter((r) => normalizeForCompare(r.clientName) === wantFull);
    if (byFull.length === 1) return { matched: true, row: byFull[0] };
    if (byFull.length > 1) {
        return {
            matched: false,
            ambiguous: true,
            blockedReason: "ambiguous_client_match",
            candidates: byFull.length,
        };
    }

    // 3. Exact base-name match (suffix-free) for the fallback search. A single
    //    row whose displayed name equals the base name is accepted; more than
    //    one plausible base-name row fails closed rather than guessing.
    const base = baseSearchName(fullName);
    if (base) {
        const wantBase = normalizeForCompare(base);
        const byBase = list.filter((r) => normalizeForCompare(r.clientName) === wantBase);
        if (byBase.length === 1) return { matched: true, row: byBase[0] };
        if (byBase.length > 1) {
            return {
                matched: false,
                ambiguous: true,
                blockedReason: "ambiguous_client_match",
                candidates: byBase.length,
            };
        }
    }

    // No unique identification. If several rows came back, that is ambiguous;
    // if effectively none matched, report no candidates (caller decides).
    if (list.length > 1) {
        return {
            matched: false,
            ambiguous: true,
            blockedReason: "ambiguous_client_match",
            candidates: list.length,
        };
    }
    return { matched: false, ambiguous: false, candidates: 0 };
}

export const CLIENT_SEARCH_SUFFIXES = PERSONAL_NAME_SUFFIXES;
