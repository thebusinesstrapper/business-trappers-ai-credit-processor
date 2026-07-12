/**
 * crcClientId.js
 *
 * Responsible ONLY for deriving the authoritative CRC Client ID from the
 * client dashboard URL.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The AI Memory database keys every record on crc_client_id. It is the unique
 * key on client_state and the join key for run history and item history.
 *
 * It must NEVER be substituted with the client display name. Per the AI Memory
 * & Client State Architecture, client_display_name is a "convenience field
 * only; CRC remains authoritative." Keying memory on a name means two clients
 * with the same name collide into one memory record, and a client who changes
 * their name silently orphans their entire dispute history. Both are
 * irreversible data-integrity failures.
 *
 * Therefore this module FAILS CLOSED: if it cannot extract an ID with
 * confidence, it returns null. The caller must then decline to write memory.
 * A missing memory record is recoverable. A memory record under the wrong key
 * is not.
 * ---------------------------------------------------------------------------
 */

/**
 * Candidate URL shapes, tried in order.
 *
 * We do not yet know which shape CRC actually uses — this is derived live from
 * page.url() on the first production run. Each pattern is anchored on an
 * explicit client path segment or query parameter, so a pattern can only match
 * an ID that CRC has genuinely labelled as a client identifier. A bare
 * "grab the first number in the URL" match is deliberately NOT included: it
 * would happily return a page number, a tab index, or a timestamp.
 *
 * Supports both numeric IDs and UUIDs.
 */
const ID = "([0-9a-fA-F-]{6,})";

const URL_PATTERNS = [
    // /app/client/12345 , /client/12345/dashboard
    new RegExp(`/clients?/${ID}(?:[/?#]|$)`),

    // /app/clients/12345/overview
    new RegExp(`/client[_-]?id/${ID}(?:[/?#]|$)`),

    // ?client_id=12345 , ?clientId=12345
    new RegExp(`[?&]client[_-]?id=${ID}`),

    // #/client/12345 (hash routing)
    new RegExp(`#.*?/clients?/${ID}(?:[/?#]|$)`),
];

/**
 * Extract the CRC Client ID from a client dashboard URL.
 *
 * @param {string} url - the URL of an OPEN client dashboard
 * @returns {string | null} the client ID, or null if it cannot be determined
 */
export function extractCrcClientId(url) {
    if (!url) return null;

    for (const pattern of URL_PATTERNS) {
        const match = url.match(pattern);

        if (match && match[1]) {
            return match[1];
        }
    }

    return null;
}

/**
 * Read the CRC Client ID from the currently-open client dashboard.
 *
 * The raw URL is always logged. On the first production run this is how we
 * learn CRC's actual URL shape — and if extraction misses, the log tells us
 * exactly which pattern to add.
 *
 * @param {import('playwright').Page} page - an OPEN client dashboard
 * @returns {string | null}
 */
export function getCrcClientId(page) {
    const url = page.url();

    console.log("Client dashboard URL:", url);

    const clientId = extractCrcClientId(url);

    if (!clientId) {
        console.error(
            "Could not derive crc_client_id from the client dashboard URL. " +
            "AI Memory will NOT be written for this run — memory is never keyed " +
            "on the client display name."
        );
        return null;
    }

    console.log("Derived crc_client_id:", clientId);

    return clientId;
}
