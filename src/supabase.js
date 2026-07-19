/**
 * supabase.js
 *
 * Owns the connection to the production AI Memory database. Nothing else.
 */

import { PostgrestClient } from "@supabase/postgrest-js";

let client = null;

function cleanEnvValue(value) {
    if (value === null || value === undefined) return "";

    let cleaned = String(value).trim();

    // Railway values are sometimes pasted with wrapping quotes. Those quotes
    // become part of the hostname/key unless removed.
    if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
        cleaned = cleaned.slice(1, -1).trim();
    }

    return cleaned;
}

function describeFetchFailure(error) {
    const cause = error?.cause;

    return [
        error?.message,
        cause?.code,
        cause?.errno,
        cause?.syscall,
        cause?.hostname,
        cause?.message,
    ].filter(Boolean).join(" | ");
}

async function railwaySafeFetch(input, init = {}) {
    const attempts = 3;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fetch(input, {
                ...init,
                signal: AbortSignal.timeout(15000),
            });
        } catch (error) {
            lastError = error;

            console.error(
                `Supabase fetch attempt ${attempt}/${attempts} failed: ` +
                describeFetchFailure(error)
            );

            if (attempt < attempts) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
            }
        }
    }

    throw new Error(
        `Supabase network request failed after ${attempts} attempts: ` +
        describeFetchFailure(lastError)
    );
}

/**
 * Lazily create the database client.
 */
export function getSupabase() {
    if (client) return client;

    const url = cleanEnvValue(process.env.SUPABASE_URL);
    const serviceRoleKey = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!url || !serviceRoleKey) {
        throw new Error(
            "Missing Supabase configuration. SUPABASE_URL and " +
            "SUPABASE_SERVICE_ROLE_KEY must be set."
        );
    }

    let parsed;

    try {
        parsed = new URL(url);
    } catch {
        throw new Error(
            "SUPABASE_URL is not a valid URL. It should look like " +
            "https://your-project-ref.supabase.co with no wrapping quotes."
        );
    }

    if (parsed.protocol !== "https:") {
        throw new Error("SUPABASE_URL must use https://");
    }

    const restUrl = `${url.replace(/\/+$/, "")}/rest/v1`;

    console.log(`Supabase REST host: ${parsed.hostname}`);

    client = new PostgrestClient(restUrl, {
        headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
        },
        fetch: railwaySafeFetch,
    });

    return client;
}
