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
 *
 * VERIFIED CRC URL STRUCTURE (observed live, Elizabeth Kelley):
 *
 *   https://app.creditrepaircloud.com/app/clients/15/dashboard
 *                                                ^^
 *                                                crc_client_id
 *
 * The ID is the numeric segment immediately following "/clients/".
 */

/**
 * The verified CRC client dashboard URL pattern.
 *
 * Deliberately strict:
 *
 *   - "/clients/" is required literally, so we can only ever match a segment
 *     CRC itself has labelled as a client.
 *   - \d+ is numeric-only, matching the observed ID format.
 *   - The trailing (?:[/?#]|$) requires the ID to be a COMPLETE path segment.
 *     Without it, "/clients/15x/report" would match and silently yield "15".
 */
const CLIENT_ID_PATTERN = /\/clients\/(\d+)(?:[/?#]|$)/;

/**
 * Extract the CRC Client ID from a client dashboard URL.
 *
 * @param {string} url - the URL of an OPEN client dashboard
 * @returns {string | null} the client ID, or null if it cannot be determined
 */
export function extractCrcClientId(url) {
    if (!url) return null;

    const match = url.match(CLIENT_ID_PATTERN);

    return match ? match[1] : null;
}

/**
 * Read the CRC Client ID from the currently-open client dashboard.
 *
 * The raw URL is always logged, so that if CRC ever changes its routing the
 * failure is immediately diagnosable rather than mysterious.
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
