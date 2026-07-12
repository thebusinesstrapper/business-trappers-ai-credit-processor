/**
 * supabase.js
 *
 * Owns the connection to the production AI Memory database. Nothing else.
 *
 * Per the AI Memory Standard, Supabase is the authoritative persistent store
 * for AI client state, processing history, and item-level history. CRC remains
 * authoritative for client identity; CreditHeroScore for report data.
 *
 * This module is the ONLY place that knows Supabase exists, in the same way
 * browserbase.js is the only place that knows Browserbase exists.
 *
 * ---------------------------------------------------------------------------
 * WHY PostgrestClient AND NOT createClient()
 *
 * createClient() from @supabase/supabase-js builds the FULL Supabase client:
 * PostgREST + Auth + Storage + Functions + Realtime. The RealtimeClient is
 * constructed eagerly in the SupabaseClient constructor — it does not wait for
 * a .channel() or .subscribe() call — and it needs a WebSocket transport.
 *
 * Node 20 has no global WebSocket (that only became default in Node 22), so
 * the Realtime constructor fails on Railway even though this processor never
 * opens a socket.
 *
 * There is no { realtime: false } option to turn it off. So the correct fix is
 * not to construct it at all.
 *
 * PostgrestClient IS the database layer that supabase-js wraps. It speaks the
 * exact same query API that clientMemory.js already uses:
 *
 *     .from(table).select().eq().maybeSingle()
 *     .from(table).insert().select().single()
 *
 * so clientMemory.js is unchanged. We simply stop loading four subsystems we
 * have never used.
 *
 * If a future milestone genuinely needs Realtime, Auth, or Storage, that is a
 * deliberate decision to revisit here — not something to inherit by accident.
 * ---------------------------------------------------------------------------
 */

import { PostgrestClient } from "@supabase/postgrest-js";

let client = null;

/**
 * Lazily create the database client.
 *
 * Lazy rather than at import time so that milestones which do not touch memory
 * (1 through 4) keep running unchanged even if Supabase env vars are absent.
 */
export function getSupabase() {
    if (client) return client;

    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
        throw new Error(
            "Missing Supabase configuration. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
        );
    }

    // Supabase exposes PostgREST at /rest/v1. Trailing slashes on SUPABASE_URL
    // would produce "//rest/v1", so strip them.
    const restUrl = `${url.replace(/\/+$/, "")}/rest/v1`;

    // The service role key is sent both as the apikey (how Supabase routes the
    // request to the right project) and as the bearer token (how PostgREST
    // authorizes it). createClient() normally does this for us; doing it here
    // is the only thing we take on by dropping it.
    client = new PostgrestClient(restUrl, {
        headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
        },
    });

    return client;
}
