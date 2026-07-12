/**
 * clientMemory.js
 *
 * Responsible ONLY for reading and initializing the client_state record.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — MILESTONE 5B ONLY
 *
 * This module does exactly three things:
 *   1. Read client_state by crc_client_id.
 *   2. Create a client_state record with Version 1 defaults if none exists.
 *   3. Return what it found or made.
 *
 * It does NOT write processing history. It does NOT write item history. It does
 * NOT advance rounds, set dates, determine dispute timing, or update state.
 * Those are later milestones and are governed by strict rules (a failed run
 * must never advance a round; a client must never be notified before CRC save
 * is verified). Nothing here touches them.
 * ---------------------------------------------------------------------------
 */

import { getSupabase } from "./supabase.js";

// The AI Memory current-state table. Single constant so a schema rename is a
// one-line change.
const CLIENT_STATE_TABLE = "client_state";

/**
 * Version 1 defaults for a brand-new client_state record.
 *
 * Every value here is either a known fact or an honest "we have not checked."
 * Nothing is invented.
 *
 *   ai_initialized: false
 *     Per the AI Memory Standard, this becomes true only AFTER the first
 *     SUCCESSFUL AI processing cycle. Merely reading a client is not a cycle.
 *
 *   credit_hero_access_state: "unknown"
 *     NOT "active". This milestone does not verify CreditHeroScore access, so
 *     claiming "active" would write a fabricated fact into the authoritative
 *     memory store. We record that we have not looked.
 *
 * All conditional fields (dates, counts, block reason, timestamps) are left
 * null until the processor has authoritative data to put in them.
 */
function buildInitialClientState(crcClientId, clientDisplayName) {
    return {
        crc_client_id: crcClientId,
        client_display_name: clientDisplayName,
        ai_initialized: false,
        current_round: 1,
        processing_state: "ready",
        process_complete: false,
        credit_hero_access_state: "unknown",
    };
}

/**
 * Read the client_state record for this client.
 *
 * @returns {Promise<object | null>} the record, or null if none exists
 */
async function readClientState(crcClientId) {
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .select("*")
        .eq("crc_client_id", crcClientId)
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to read client_state: ${error.message}`);
    }

    return data;
}

/**
 * Create a client_state record using Version 1 defaults.
 *
 * @returns {Promise<object>} the created record
 */
async function createClientState(crcClientId, clientDisplayName) {
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .insert(buildInitialClientState(crcClientId, clientDisplayName))
        .select()
        .single();

    if (error) {
        throw new Error(`Failed to create client_state: ${error.message}`);
    }

    return data;
}

/**
 * Load this client's AI memory, initializing it if the client has never been
 * processed before.
 *
 * Per the AI Memory Standard: "There is no separate migration mode. Every
 * client with an active CreditHeroScore membership and no AI Memory record is
 * treated as an initial AI processing client." So a missing record is not an
 * error — it is a new client, and we create it.
 *
 * @param {string} crcClientId    - authoritative CRC client key (never a name)
 * @param {string} clientDisplayName
 * @returns {Promise<{
 *   exists: boolean,
 *   created: boolean,
 *   current_round?: number,
 *   processing_state?: string,
 *   process_complete?: boolean
 * }>}
 */
export async function loadOrCreateClientMemory(crcClientId, clientDisplayName) {
    console.log(`Reading AI memory for crc_client_id "${crcClientId}"...`);

    const existing = await readClientState(crcClientId);

    if (existing) {
        console.log(
            `Existing memory found — round ${existing.current_round}, state "${existing.processing_state}".`
        );

        return {
            exists: true,
            created: false,
            current_round: existing.current_round,
            processing_state: existing.processing_state,
            process_complete: existing.process_complete,
        };
    }

    console.log("No memory record found. Initializing this client as a new AI processing client.");

    await createClientState(crcClientId, clientDisplayName);

    console.log("Client memory initialized.");

    return {
        exists: false,
        created: true,
    };
}
