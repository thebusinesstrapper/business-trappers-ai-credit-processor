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
 * Field-specific guard for crc_client_status.
 *
 * This column is populated from live CRC DataGrid text, which is read, not
 * generated — so it is validated strictly. Anything that is not a real,
 * nonblank string is REJECTED. A rejected value returns null, which signals
 * the caller to OMIT the key entirely (never write null/"" over it), so a
 * known status already on the row can never be clobbered by a bad or missing
 * observation.
 *
 *   - null / undefined          -> rejected
 *   - non-string (number, etc.) -> rejected
 *   - ""                        -> rejected
 *   - "   " (whitespace only)   -> rejected
 *   - " Waiting For Bureau "    -> accepted, trimmed to "Waiting For Bureau"
 */
function validCrcClientStatus(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/**
 * NARROW WRITER for the CreditHero inactive-monitoring workflow, and for
 * observation-only CRC status syncing.
 *
 * WHAT IT CANNOT DO, BY CONSTRUCTION.
 *
 * The update object below is built from a fixed whitelist. current_round,
 * processing_state, process_complete and every lock column are simply not
 * assignable through it — not guarded against, absent. A dispute cycle cannot be
 * advanced, completed, locked or unlocked by anything on the inactive path, and
 * the same is true of the observation-sync path added below: it uses this exact
 * same whitelist and the same absence of those columns.
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
        // Stage 2: durable marker for a blocked classification (e.g.
        // "WAITING_FOR_FREE_REPORT", "CREDENTIALS_OR_AUTH_FAILED"). Nullable text.
        // Deliberately narrow — this writer still cannot touch current_round,
        // processing_state, delivery locks, or any success/dispute timestamp.
        "block_reason",
        // Observation-only: the CRC status text as last positively observed on
        // the live DataGrid scan, or the exact status a routing/M8 path
        // confirmed it wrote. Guarded separately below — see
        // validCrcClientStatus(). Still cannot touch current_round,
        // processing_state, or any lock column.
        "crc_client_status",
    ];

    const update = {};

    for (const key of WRITABLE) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;

        if (key === "crc_client_status") {
            // Reject non-string / empty / whitespace-only values by OMITTING
            // the key from the update, rather than writing null/"" over a
            // known value.
            const valid = validCrcClientStatus(fields[key]);
            if (valid === null) continue;
            update[key] = valid;
            continue;
        }

        // Every other whitelisted field keeps its existing, unguarded
        // behavior — including block_reason's ability to be explicitly
        // cleared by passing null.
        update[key] = fields[key];
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
            "inactive_notice_sent_at, inactive_reminder_sent_at, inactive_notice_last_error, " +
            "crc_client_status"
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


/**
 * ===========================================================================
 * LIFECYCLE WRITERS — current_round, processing_state, process_complete.
 *
 * THESE ARE DELIBERATELY SEPARATE FROM recordCreditHeroState().
 *
 * That writer's whitelist EXCLUDES current_round, processing_state and
 * process_complete, and that exclusion is a safety boundary, not an oversight:
 * it is what makes it impossible for the CreditHero/observation paths to
 * advance a dispute cycle. Widening it to carry lifecycle fields would delete
 * the boundary for every caller at once.
 *
 * So lifecycle transitions get their own writers. Each has a FIXED field set —
 * not a caller-supplied whitelist — and each is a COMPARE-AND-SWAP against the
 * exact state it expects to be transitioning from. A transition that does not
 * match writes nothing and says so.
 *
 * Only fields already confirmed present in client_state are written:
 *   current_round, processing_state, process_complete, next_eligible_date,
 *   last_dispute_date, last_successful_processing_at, negative_items_remaining
 * ===========================================================================
 */

/** The final dispute round. Delivering it completes the client. */
export const FINAL_ROUND = 6;

/**
 * Days from confirmed delivery until the client is next eligible.
 *
 * NOT invented here. orderPageReader.js already records the permanent rule:
 * "the permanent future-cycle rule is 31 days since confirmed delivery AND a
 * free report". This is that rule, applied at the only moment we can know the
 * delivery actually happened.
 */
export const CYCLE_DAYS = 31;

/** ISO calendar date (YYYY-MM-DD) for a date column. */
function isoDate(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

/** ISO date N days from now, for next_eligible_date. */
function isoDatePlusDays(days, from = new Date()) {
    const d = new Date(from.getTime() + days * 86400000);
    return isoDate(d);
}

/**
 * Advance to the next round after a CONFIRMED successful delivery.
 *
 * ---------------------------------------------------------------------------
 * HOW PREMATURE ADVANCEMENT IS MADE IMPOSSIBLE.
 *
 * The .eq() chain requires processing_state === 'waiting'. Only
 * markDeliveryCompleted() sets that, and it only runs after CRC has confirmed
 * the secure message was sent. A client that is 'ready' (never delivered),
 * 'processing' (mid-delivery), 'blocked' or 'complete' cannot match, so no
 * failed, blocked, interrupted or withheld run can advance a round — not
 * because the caller checks, but because the row does not match.
 *
 * HOW DUPLICATE ADVANCEMENT IS MADE IMPOSSIBLE.
 *
 * It also requires current_round === deliveredRound. Once advanced, the round
 * no longer matches, so a second call writes nothing and reports
 * already_advanced. The operation is idempotent under retry.
 *
 * WHAT HAPPENS NEXT. processing_state returns to 'ready' so the NEW round can
 * eventually take its own delivery lock, and next_eligible_date is set 31 days
 * out so the daily preflight short-circuits until then rather than re-disputing
 * off the same report tomorrow.
 * ---------------------------------------------------------------------------
 *
 * @param {string|number} crcClientId
 * @param {number} deliveredRound  the round just confirmed delivered
 */
export async function advanceRoundAfterDelivery(crcClientId, deliveredRound) {
    const id = String(crcClientId);
    const round = Number(deliveredRound);

    if (!/^\d+$/.test(id)) {
        throw new Error(`advanceRoundAfterDelivery: invalid crcClientId "${crcClientId}".`);
    }

    if (!Number.isInteger(round) || round < 1) {
        return { ok: false, reason: "invalid_delivered_round", deliveredRound };
    }

    if (round >= FINAL_ROUND) {
        // Round 6 completes rather than advances. Refuse rather than silently
        // rolling a finished client into a seventh round.
        return { ok: false, reason: "final_round_requires_completion", deliveredRound: round };
    }

    const now = new Date();
    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({
            current_round: round + 1,
            processing_state: "ready",
            last_dispute_date: isoDate(now),
            next_eligible_date: isoDatePlusDays(CYCLE_DAYS, now),
            last_successful_processing_at: now.toISOString(),
        })
        .eq("crc_client_id", id)
        .eq("current_round", round)
        .eq("processing_state", "waiting")
        .select("crc_client_id, current_round, processing_state, next_eligible_date, last_dispute_date")
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to advance round: ${error.message}`);
    }

    if (!data) {
        return { ok: false, reason: "already_advanced_or_not_delivered", deliveredRound: round };
    }

    return { ok: true, previousRound: round, newRound: data.current_round, state: data };
}

/**
 * Mark a client COMPLETE. Terminal.
 *
 * Two approved routes, and the compare-and-swap differs because the states they
 * arrive from differ:
 *
 *   "final_round_delivered"      — from processing_state 'waiting' at round 6,
 *                                  i.e. a confirmed delivery, same guarantee as
 *                                  advanceRoundAfterDelivery().
 *   "no_disputable_items"        — from any NON-complete state; no delivery
 *                                  occurred, so no delivery marker exists to
 *                                  match on.
 *
 * NEITHER touches current_round. The round a client finished on is history and
 * the dashboard reports it as the final round.
 *
 * Idempotent: a row already process_complete does not match and reports
 * already_complete.
 *
 * @param {string|number} crcClientId
 * @param {"final_round_delivered"|"no_disputable_items"} reason
 * @param {object} [opts]
 * @param {number} [opts.expectedRound]         required for final_round_delivered
 * @param {number} [opts.negativeItemsRemaining] persisted when known (0 on the
 *                                               no-disputable-items route)
 */
export async function markProcessComplete(crcClientId, reason, opts = {}) {
    const id = String(crcClientId);

    if (!/^\d+$/.test(id)) {
        throw new Error(`markProcessComplete: invalid crcClientId "${crcClientId}".`);
    }

    if (!["final_round_delivered", "no_disputable_items"].includes(reason)) {
        throw new Error(`markProcessComplete: unrecognized reason "${reason}".`);
    }

    const now = new Date();

    const update = {
        process_complete: true,
        processing_state: "complete",
        last_successful_processing_at: now.toISOString(),
    };

    if (reason === "final_round_delivered") {
        update.last_dispute_date = isoDate(now);
    }

    // Guarded against the confirmed non-negative CHECK on this column. Integer
    // alone was not enough: a negative value would reach Postgres and throw,
    // turning a completion into an exception. Today's only caller passes 0, so
    // this protects a future one rather than a present bug.
    if (Number.isInteger(opts.negativeItemsRemaining) && opts.negativeItemsRemaining >= 0) {
        update.negative_items_remaining = opts.negativeItemsRemaining;
    }

    const supabase = getSupabase();

    let query = supabase
        .from(CLIENT_STATE_TABLE)
        .update(update)
        .eq("crc_client_id", id)
        .eq("process_complete", false);

    if (reason === "final_round_delivered") {
        // Same delivery guarantee as a round advance: only a confirmed delivery
        // leaves the row in 'waiting' at the round we just sent.
        query = query
            .eq("current_round", Number(opts.expectedRound))
            .eq("processing_state", "waiting");
    }

    const { data, error } = await query
        .select("crc_client_id, current_round, processing_state, process_complete")
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to mark client complete: ${error.message}`);
    }

    if (!data) {
        return { ok: false, reason: "already_complete_or_state_mismatch", completionReason: reason };
    }

    return { ok: true, completionReason: reason, finalRound: data.current_round, state: data };
}

/**
 * Persist a verified future eligibility date.
 *
 * WHAT THIS BUYS. The daily preflight reads next_eligible_date BEFORE launching
 * Browserbase. A client waiting on a free report that CreditHero has already
 * told us arrives on a specific date should not cost a browser session every
 * morning until then.
 *
 * NARROW BY CONSTRUCTION: one field. It cannot touch current_round,
 * processing_state, process_complete, or any lock column — they are absent from
 * the update, not guarded against.
 *
 * Rejects anything that is not a real YYYY-MM-DD string, so an unreadable or
 * absent date can never overwrite a known one.
 */
export async function recordNextEligibleDate(crcClientId, isoDateString) {
    const id = String(crcClientId);

    if (!/^\d+$/.test(id)) {
        throw new Error(`recordNextEligibleDate: invalid crcClientId "${crcClientId}".`);
    }

    if (typeof isoDateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDateString)) {
        return { ok: false, reason: "invalid_date_omitted" };
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({ next_eligible_date: isoDateString })
        .eq("crc_client_id", id)
        .select("crc_client_id, next_eligible_date")
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to record next_eligible_date: ${error.message}`);
    }

    if (!data) return { ok: false, reason: "client_state_row_not_found" };

    return { ok: true, nextEligibleDate: data.next_eligible_date };
}

/**
 * PURE. Should this client be opened in a browser today, given stored memory?
 *
 * Answers the daily-preflight question without touching Playwright, CRC or
 * CreditHero — so it is fully unit-testable and cannot itself cause a session.
 *
 * @param {object|null} state  a client_state row, or null when none exists
 * @param {string} todayIso    YYYY-MM-DD
 */
export const PREFLIGHT = Object.freeze({
    PROCEED: "proceed",
    SKIP_COMPLETE: "skip_complete",
    SKIP_NOT_YET_ELIGIBLE: "skip_not_yet_eligible",
});

export function decideDailyPreflight(state, todayIso) {
    if (!state) {
        // No memory yet: a brand-new client. Nothing stored can justify skipping.
        return { action: PREFLIGHT.PROCEED, reason: "No stored client_state; treating as a new client." };
    }

    if (state.process_complete === true || state.processing_state === "complete") {
        return {
            action: PREFLIGHT.SKIP_COMPLETE,
            reason: "Client is Complete. Terminal — excluded from daily processing.",
            finalRound: state.current_round ?? null,
        };
    }

    const next = state.next_eligible_date ?? null;

    // ISO dates compare correctly as strings; no Date parsing needed. An
    // unreadable value is treated as absent rather than as a licence to skip.
    if (typeof next === "string" && /^\d{4}-\d{2}-\d{2}$/.test(next) && next > todayIso) {
        return {
            action: PREFLIGHT.SKIP_NOT_YET_ELIGIBLE,
            reason:
                `A verified eligibility date of ${next} has not arrived (today ${todayIso}). ` +
                `No CreditHero session is opened; the client is re-evaluated on the next daily run.`,
            nextEligibleDate: next,
        };
    }

    return {
        action: PREFLIGHT.PROCEED,
        reason: next
            ? `Stored eligibility date ${next} has arrived. Verifying live state.`
            : "No reliable future eligibility date stored. Verifying live state.",
        nextEligibleDate: next,
    };
}


/**
 * ===========================================================================
 * MANUAL REVIEW WRITERS.
 *
 * A THIRD narrow pair, for the same reason the lifecycle writers are separate:
 * recordCreditHeroState()'s whitelist is a safety boundary and these fields do
 * not belong inside it. Fixed field set, no caller-supplied whitelist.
 *
 * WHY NOT block_reason. That column is already occupied by NON-manual-review
 * markers — processProductionClient writes WAITING_FOR_FREE_REPORT and
 * CREDENTIALS_OR_AUTH_FAILED into it. Reusing it here would make "waiting on a
 * bureau" and "broken, needs a human" indistinguishable in one column, which is
 * precisely the distinction this feature exists to draw.
 * ===========================================================================
 */

/**
 * Sanitize a Postgres/PostgREST error before it travels into a job result.
 *
 * Database errors quote offending VALUES ("duplicate key value violates ...
 * Key (crc_client_id)=(154)"), so they are treated as untrusted text: long
 * digit runs redacted, whitespace collapsed, length capped. The error is
 * SURFACED rather than swallowed — a silent failure to record a manual review
 * is the outcome this whole path exists to prevent — but it is surfaced clean.
 */
function sanitizeDbError(message) {
    if (typeof message !== "string") return null;

    const cleaned = message
        .replace(/\d{9,}/g, "[redacted]")
        .replace(/\s+/g, " ")
        .trim();

    return cleaned ? cleaned.slice(0, 300) : null;
}

/**
 * ===========================================================================
 * CLIENT STATE INITIALIZATION — the single entry point.
 *
 * Called the moment CRC confirms an authoritative crc_client_id, BEFORE any
 * downstream routing, notice, status write or manual-review flag. Every one of
 * those is an UPDATE, and an UPDATE against a row that does not exist matches
 * nothing and reports success-shaped emptiness.
 *
 * WHY IT LIVES HERE RATHER THAN INSIDE EACH WRITER. Only two paths ever created
 * a row — acquireDeliveryLock() and runInactiveWorkflow() — so a client that
 * failed at capture reached neither and had no memory at all. Fixing that inside
 * recordManualReview() would have fixed exactly one symptom and left the
 * inactive path, the Waiting For Bureau path and successful processing each
 * relying on a row nobody had guaranteed. One initialization point, used by all
 * of them, is the difference between a fix and a patch.
 *
 * TWO STATEMENTS, AND THE SPLIT IS THE SAFETY PROPERTY.
 *
 *   CREATE  — upsert with ignoreDuplicates, i.e. ON CONFLICT DO NOTHING. A
 *             plain upsert would overwrite an existing row's current_round,
 *             processing_state, dates and history with Version 1 defaults,
 *             resetting a round 4 client to round 1. DO NOTHING is the
 *             difference between "create if missing" and "reset".
 *
 *   REFRESH — a fixed, tiny field set: the display label, the observed CRC
 *             status, and updated_at. Nothing else is assignable through it.
 *             current_round, processing_state, process_complete, every
 *             lifecycle date, the inactive timestamps and the manual-review
 *             fields are not guarded against — they are ABSENT.
 *
 * KEYED ON crc_client_id ALONE, always. The display name is a label written
 * INTO the row, never any part of how the row is found.
 * ===========================================================================
 *
 * @param {string|number} crcClientId  authoritative, confirmed by CRC
 * @param {object} [options]
 * @param {string} [options.clientDisplayName]
 * @param {string} [options.crcClientStatus]  only when positively observed
 * @returns {Promise<{ok: boolean, created?: boolean, reason?: string, detail?: string}>}
 */
export async function ensureClientStateExists(crcClientId, options = {}) {
    const id = String(crcClientId);

    if (!/^\d+$/.test(id)) {
        throw new Error(`ensureClientStateExists: invalid crcClientId "${crcClientId}".`);
    }

    /*
     * client_display_name is NOT NULL. The caller supplies the name CRC matched;
     * a genuinely blank one falls back to a label derived from the authoritative
     * id, which cannot be mistaken for a real person and keeps the row keyable.
     */
    const displayName =
        typeof options.clientDisplayName === "string" && options.clientDisplayName.trim()
            ? options.clientDisplayName.trim()
            : "CRC Client " + id;

    const observedStatus =
        typeof options.crcClientStatus === "string" && options.crcClientStatus.trim()
            ? options.crcClientStatus.trim()
            : null;

    const supabase = getSupabase();

    // ---- CREATE IF MISSING ------------------------------------------------
    //
    // buildInitialClientState() is reused verbatim: the same governed Version 1
    // defaults loadOrCreateClientMemory() has always used. Every NOT NULL column
    // gets a real value or an honest "we have not checked", and
    // credit_hero_access_state gets "unknown" — a value this exact function has
    // been inserting successfully in production.
    const insert = await supabase
        .from(CLIENT_STATE_TABLE)
        .upsert(buildInitialClientState(id, displayName), {
            onConflict: "crc_client_id",
            ignoreDuplicates: true
        })
        .select("crc_client_id");

    if (insert.error) {
        return {
            ok: false,
            reason: "client_state_create_failed",
            detail: sanitizeDbError(insert.error.message)
        };
    }

    const created = Array.isArray(insert.data) && insert.data.length > 0;

    // ---- REFRESH ONLY THE SAFE IDENTITY FIELDS ---------------------------
    const refresh = { updated_at: new Date().toISOString() };

    refresh.client_display_name = displayName;

    if (observedStatus) {
        refresh.crc_client_status = observedStatus;
    }

    const update = await supabase
        .from(CLIENT_STATE_TABLE)
        .update(refresh)
        .eq("crc_client_id", id)
        .select("crc_client_id, client_display_name, crc_client_status")
        .maybeSingle();

    if (update.error) {
        return {
            ok: false,
            reason: "client_state_refresh_failed",
            detail: sanitizeDbError(update.error.message)
        };
    }

    if (!update.data) {
        return {
            ok: false,
            reason: "client_state_row_missing_after_create",
            detail: "The row was neither created nor found immediately afterwards."
        };
    }

    return { ok: true, created, refreshed: Object.keys(refresh) };
}

/**
 * Flag a client as requiring manual review.
 *
 * DATE FLAGGED IS SET ONCE, ON ENTRY. A client that fails the same way for five
 * consecutive days should show how long it has been stuck, not today's date
 * five times. So the timestamp is written only on the false -> true transition;
 * a client already flagged has its stage and reason refreshed and its
 * flagged_at left alone.
 *
 * @param {string|number} crcClientId
 * @param {object} fields
 * @param {string|null} fields.stage    the blocked/failure stage
 * @param {string|null} fields.reason   ALREADY SANITIZED by the caller
 */
export async function recordManualReview(crcClientId, fields = {}) {
    const id = String(crcClientId);

    if (!/^\d+$/.test(id)) {
        throw new Error(`recordManualReview: invalid crcClientId "${crcClientId}".`);
    }

    const stage = typeof fields.stage === "string" && fields.stage.trim()
        ? fields.stage.trim().slice(0, 120)
        : null;

    const reason = typeof fields.reason === "string" && fields.reason.trim()
        ? fields.reason.trim().slice(0, 500)
        : null;

    // 0. THE ROW MUST EXIST BEFORE AN UPDATE CAN MATCH IT.
    //
    // A newly discovered client that failed before delivery has no client_state
    // row, and both statements below are UPDATEs. Creating it here is what makes
    // the flag possible at all; an existing row is left completely untouched.
    const ensured = await ensureClientStateExists(id, {
        clientDisplayName: fields.clientDisplayName
    });

    if (!ensured.ok) {
        return ensured;
    }

    const supabase = getSupabase();

    // 1. ENTERING manual review: set the flag date. Matches only a row that is
    //    not already flagged, so it cannot overwrite an earlier entry date.
    const entering = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({
            manual_review_active: true,
            manual_review_stage: stage,
            manual_review_reason: reason,
            manual_review_flagged_at: new Date().toISOString(),
        })
        .eq("crc_client_id", id)
        .eq("manual_review_active", false)
        .select("crc_client_id, manual_review_active, manual_review_flagged_at")
        .maybeSingle();

    if (entering.error) {
        return {
            ok: false,
            reason: "manual_review_flag_failed",
            detail: sanitizeDbError(entering.error.message)
        };
    }

    if (entering.data) {
        return { ok: true, transition: "entered", state: entering.data };
    }

    // 2. ALREADY flagged: refresh what is wrong, preserve when it started.
    const refreshing = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({ manual_review_stage: stage, manual_review_reason: reason })
        .eq("crc_client_id", id)
        .eq("manual_review_active", true)
        .select("crc_client_id, manual_review_active, manual_review_flagged_at")
        .maybeSingle();

    if (refreshing.error) {
        return {
            ok: false,
            reason: "manual_review_refresh_failed",
            detail: sanitizeDbError(refreshing.error.message)
        };
    }

    if (!refreshing.data) {
        return { ok: false, reason: "client_state_row_not_found" };
    }

    return { ok: true, transition: "refreshed", state: refreshing.data };
}

/**
 * Clear the manual-review flag after a run that did NOT require a human.
 *
 * Matches only a row that is currently flagged, so a healthy client costs one
 * no-op statement rather than a pointless write on every daily run.
 *
 * All four fields are cleared together. A stale "Failure Reason" sitting beside
 * a client that processed cleanly is worse than no reason at all; the human
 * record of what happened lives in the sheet's Resolution Notes, which this
 * never touches.
 */
export async function clearManualReview(crcClientId) {
    const id = String(crcClientId);

    if (!/^\d+$/.test(id)) {
        throw new Error(`clearManualReview: invalid crcClientId "${crcClientId}".`);
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
        .from(CLIENT_STATE_TABLE)
        .update({
            manual_review_active: false,
            manual_review_stage: null,
            manual_review_reason: null,
            manual_review_flagged_at: null,
        })
        .eq("crc_client_id", id)
        .eq("manual_review_active", true)
        .select("crc_client_id, manual_review_active")
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to clear manual review: ${error.message}`);
    }

    return data
        ? { ok: true, transition: "cleared" }
        : { ok: true, transition: "was_not_flagged" };
}

/**
 * PURE. Does this run's outcome require a human?
 *
 * The classification vocabulary already answers this. manualReview and fatal are
 * the two outcomes that mean "the processor could not finish and nobody has
 * looked yet". Every excluded state — routedWaiting, creditMonitoringInactive,
 * alreadyComplete, duplicatePrevented, noActionableItems, sent — is a
 * DIFFERENT classification, so nothing needs special-casing.
 */
export const MANUAL_REVIEW_CLASSIFICATIONS = Object.freeze(["manualReview", "fatal"]);

export function requiresManualReview(classification) {
    return MANUAL_REVIEW_CLASSIFICATIONS.includes(classification);
}

/**
 * PURE. May this run write manual-review state at all?
 *
 * A controlled test must never create a Manual Review record. A diagnostic run
 * does not deliver; a run with submitApproved false stops before delivery on
 * purpose; a run without operational routing approval writes nothing anywhere.
 * None of those is evidence that a human is needed — they are evidence that we
 * told the processor to stop.
 */
export function manualReviewWritesAllowed(job = {}) {
    return (
        job.diagnosticOnly !== true &&
        job.submitApproved === true &&
        job.operationalRoutingApproved === true
    );
}
