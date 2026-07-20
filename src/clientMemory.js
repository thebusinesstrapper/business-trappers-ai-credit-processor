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
/**
 * Read the FULL client_state row (all columns) or null.
 *
 * Exported deliberately: loadOrCreateClientMemory() returns only a delivery-focused
 * subset (round / processing_state / process_complete), which is right for the
 * delivery path but drops the inactive-workflow timestamps. Callers that need the
 * whole row — the CreditHero inactive branch reading inactive_notice_sent_at —
 * read it here instead of through that subset.
 */
export async function readClientState(crcClientId) {
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


/**
 * Durable M8 delivery protection using the governed processing_state values
 * already enforced by Supabase:
 *
 *   ready -> processing -> waiting
 *
 * The database constraint permits only:
 *   ready, processing, waiting, blocked, complete
 *
 * `current_round` remains unchanged here. When a later workflow legitimately
 * advances the round, it must explicitly return the client to `ready`.
 */

/**
 * Atomically acquire the live-delivery lock for one client and round.
 *
 * `processing` is the durable lock. `waiting` means the current round has
 * already been delivered and is waiting for bureau results.
 */
export async function acquireDeliveryLock(crcClientId, clientDisplayName, round) {
    const id = String(crcClientId);
    const memory = await loadOrCreateClientMemory(id, clientDisplayName);
    const current = await readClientState(id);

    if (!current) {
        throw new Error(`client_state was not available after initialization for CRC client ${id}.`);
    }

    const expectedRound = Number(round);
    const storedRound = Number(current.current_round);

    if (!Number.isInteger(expectedRound) || expectedRound < 1) {
        return {
            ok: false,
            reason: "invalid_round",
            currentState: current.processing_state ?? null,
        };
    }

    if (storedRound !== expectedRound) {
        return {
            ok: false,
            reason: "round_mismatch",
            expectedRound,
            storedRound,
            currentState: current.processing_state ?? null,
        };
    }

    const previousState = current.processing_state ?? "ready";
    const lockedState = "processing";
    const deliveredState = "waiting";

    if (previousState === deliveredState) {
        return {
            ok: false,
            reason: "duplicate_delivery_prevented",
            currentState: previousState,
            deliveredState,
        };
    }

    if (previousState === lockedState) {
        return {
            ok: false,
            reason: "delivery_already_in_progress",
            currentState: previousState,
            lockedState,
        };
    }

    if (previousState !== "ready") {
        return {
            ok: false,
            reason: "client_not_ready_for_delivery",
            currentState: previousState,
        };
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({ processing_state: lockedState })
        .eq("crc_client_id", id)
        .eq("current_round", expectedRound)
        .eq("processing_state", previousState)
        .select("crc_client_id, current_round, processing_state")
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to acquire M8 delivery lock: ${error.message}`);
    }

    if (!data) {
        return {
            ok: false,
            reason: "delivery_lock_conflict",
            previousState,
            lockedState,
        };
    }

    return {
        ok: true,
        crcClientId: id,
        round: expectedRound,
        previousState,
        lockedState,
        createdMemory: memory.created === true,
    };
}

/** Mark a confirmed secure-message delivery as waiting for bureau results. */
export async function markDeliveryCompleted(crcClientId, round, lockedState) {
    const id = String(crcClientId);
    const deliveredState = "waiting";
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({ processing_state: deliveredState })
        .eq("crc_client_id", id)
        .eq("current_round", Number(round))
        .eq("processing_state", lockedState)
        .select("crc_client_id, current_round, processing_state")
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to mark M8 delivery complete: ${error.message}`);
    }

    if (!data) {
        return {
            ok: false,
            reason: "delivery_completion_conflict",
            deliveredState,
        };
    }

    return {
        ok: true,
        deliveredState,
        state: data.processing_state,
    };
}

/**
 * Release the lock only when Submit definitely did not happen.
 */
export async function releaseDeliveryLock(
    crcClientId,
    round,
    lockedState,
    previousState
) {
    const id = String(crcClientId);
    const supabase = getSupabase();

    const safePreviousState =
        ["ready", "blocked", "complete"].includes(previousState)
            ? previousState
            : "ready";

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({ processing_state: safePreviousState })
        .eq("crc_client_id", id)
        .eq("current_round", Number(round))
        .eq("processing_state", lockedState)
        .select("crc_client_id, current_round, processing_state")
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to release M8 delivery lock: ${error.message}`);
    }

    return {
        ok: Boolean(data),
        state: data?.processing_state ?? null,
    };
}

/**
 * NARROW WRITER for the CreditHero inactive-monitoring workflow.
 *
 * WHAT IT CANNOT DO, BY CONSTRUCTION.
 *
 * The update object below is built from a fixed whitelist. current_round,
 * processing_state, process_complete and every lock column are simply not
 * assignable through it — not guarded against, absent. A dispute cycle cannot be
 * advanced, completed, locked or unlocked by anything on the inactive path.
 *
 * It also matches on crc_client_id ALONE. markDeliveryCompleted() adds
 * current_round and processing_state to its .eq() chain because it is doing a
 * compare-and-swap against a lock it holds. This writer holds no lock and must
 * never behave as though it does, so it neither reads nor depends on delivery
 * state.
 *
 * @param {string|number} crcClientId
 * @param {object} fields  any subset of the whitelist below
 */
export async function recordCreditHeroState(crcClientId, fields = {}) {
    const id = String(crcClientId);

    if (!/^\d+$/.test(id)) {
        throw new Error(`recordCreditHeroState: invalid crcClientId "${crcClientId}".`);
    }

    // The whitelist IS the safety boundary.
    const WRITABLE = [
        "credit_hero_access_state",
        "last_credit_hero_check_at",
        "inactive_notice_sent_at",
        "inactive_reminder_sent_at",
        "inactive_notice_last_error",
    ];

    const update = {};

    for (const key of WRITABLE) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
            update[key] = fields[key];
        }
    }

    if (Object.keys(update).length === 0) {
        return { ok: false, reason: "no_writable_fields_supplied" };
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update(update)
        .eq("crc_client_id", id)
        .select(
            "crc_client_id, credit_hero_access_state, last_credit_hero_check_at, " +
            "inactive_notice_sent_at, inactive_reminder_sent_at, inactive_notice_last_error"
        )
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to record CreditHero state: ${error.message}`);
    }

    if (!data) {
        return { ok: false, reason: "client_state_row_not_found" };
    }

    return { ok: true, written: Object.keys(update), state: data };
}
