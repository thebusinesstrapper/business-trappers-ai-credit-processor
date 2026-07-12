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
 */

import { createClient } from "@supabase/supabase-js";

let client = null;

/**
 * Lazily create the Supabase client.
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

    client = createClient(url, serviceRoleKey, {
        auth: {
            // Server-side service role: no session to persist or refresh.
            persistSession: false,
            autoRefreshToken: false,
        },
    });

    return client;
}
