// inactiveRecheckSweep.js
//
// Daily READ-ONLY recheck of every client stored (or shown) Credit Monitoring
// Inactive, so a reactivation cannot be missed. Runs as a separate branch of the
// same daily processClientQueue run — the normal dispute queue still denylists
// inactive clients; this sweep is how they are still looked at every day.
//
// SAFETY
//   - The recheck opens the EXISTING CreditHero account read-only (via the
//     injected recheckClient, which uses M6). It never orders a report,
//     reactivates monitoring, or incurs a charge.
//   - The active transition requires a POSITIVELY confirmed healthy dashboard.
//   - A reactivated client inside the waiting period is routed to Waiting For
//     Bureau with a stored next_eligible_date; NO disputes are generated.
//   - Only a genuinely eligible reactivated client is handed to normal
//     processing, under every existing safeguard.
//
// TESTABILITY
//   All I/O and browser work is injected via `deps`, so the enumeration,
//   dedupe, decision, and reconciliation logic is unit-testable without a
//   browser or a live database.

import { decideInactiveRecheck, RECHECK_ACTION } from "./inactiveRecheckDecision.js";

const INACTIVE_CRC_STATUS = "Credit Monitoring Inactive";

/** Lowercased, trimmed key for status/id comparison. */
function key(v) {
    return String(v ?? "").trim().toLocaleLowerCase("en-US");
}

/**
 * Build the deduplicated inactive-client set from BOTH sources:
 *   - Supabase rows where credit_hero_access_state = inactive (primary), and
 *   - CRC-grid observations whose visible status is Credit Monitoring Inactive.
 * Deduplicated by crc_client_id. If EITHER source marks a client inactive, it is
 * included. Completed clients (Supabase process_complete = true) are excluded.
 *
 * @param {Array<object>} supabaseInactive  rows from listInactiveClients()
 * @param {Array<object>} crcObservations   [{crcClientId, clientName, crcClientStatus}]
 * @returns {Array<{crcClientId:string, clientName:string|null, storedState:object|null, sources:string[]}>}
 */
export function buildInactiveSet(supabaseInactive = [], crcObservations = []) {
    const byId = new Map();

    for (const row of supabaseInactive) {
        const id = row?.crc_client_id != null ? String(row.crc_client_id) : null;
        if (!id) continue;
        if (row.process_complete === true) continue; // terminal, never rechecked
        byId.set(id, {
            crcClientId: id,
            clientName: row.client_display_name ?? null,
            storedState: row,
            sources: ["supabase"],
        });
    }

    for (const obs of crcObservations) {
        if (key(obs?.crcClientStatus) !== key(INACTIVE_CRC_STATUS)) continue;
        const id = obs?.crcClientId != null ? String(obs.crcClientId) : null;
        if (!id) continue;

        const existing = byId.get(id);
        if (existing) {
            if (!existing.sources.includes("crc")) existing.sources.push("crc");
            if (!existing.clientName) existing.clientName = obs.clientName ?? null;
        } else {
            byId.set(id, {
                crcClientId: id,
                clientName: obs.clientName ?? null,
                storedState: null, // no Supabase memory; the recheck still runs
                sources: ["crc"],
            });
        }
    }

    return [...byId.values()];
}

/**
 * Run the inactive recheck sweep.
 *
 * @param {object} deps
 * @param {() => Promise<Array<object>>} deps.listInactiveClients   Supabase enumerate
 * @param {Array<object>} deps.crcObservations                      CRC-grid observations
 * @param {(client) => Promise<{landing:object, reportDate?:string|null, crcStatus?:string|null}>} deps.recheckClient
 *        READ-ONLY live recheck (opens CreditHero via M6, returns landing state
 *        and, when healthy, the newest report date).
 * @param {object} deps.writers
 * @param {(id, nowIso) => Promise<object>} deps.writers.recordMonitoringReactivated
 * @param {(id, fields) => Promise<object>} deps.writers.recordCreditHeroState
 * @param {(id, isoDate) => Promise<object>} deps.writers.recordNextEligibleDate
 * @param {(id, isoDate) => Promise<object>} [deps.writers.recordLastReportDate]
 * @param {(client, targetStatus) => Promise<object>} deps.setCrcStatus  CRC status writer
 * @param {(client) => Promise<object>} [deps.processEligible]  normal processing hand-off
 * @param {string} [deps.todayIso]
 * @param {string} [deps.nowIso]
 * @returns {Promise<object>} summary
 */
export async function runInactiveRecheckSweep(deps) {
    const {
        listInactiveClients,
        crcObservations = [],
        recheckClient,
        writers,
        setCrcStatus,
        processEligible = null,
        todayIso = new Date().toISOString().slice(0, 10),
        nowIso = new Date().toISOString(),
    } = deps;

    const summary = {
        enumerated: 0,
        rechecked: 0,
        stillInactive: 0,
        reactivatedWaiting: 0,
        reactivatedEligible: 0,
        errors: 0,
        results: [],
    };

    let supabaseInactive = [];
    try {
        supabaseInactive = (await listInactiveClients()) ?? [];
    } catch (error) {
        summary.enumerationError = error.message;
    }

    const clients = buildInactiveSet(supabaseInactive, crcObservations);
    summary.enumerated = clients.length;

    for (const client of clients) {
        const entry = { crcClientId: client.crcClientId, clientName: client.clientName, sources: client.sources };
        try {
            // ---- READ-ONLY live recheck ------------------------------------
            const live = await recheckClient(client);
            summary.rechecked += 1;

            const decision = decideInactiveRecheck({
                storedState: client.storedState,
                observedCrcStatus: INACTIVE_CRC_STATUS,
                landing: live?.landing ?? null,
                todayIso,
            });
            entry.action = decision.action;
            entry.reason = decision.reason;

            if (decision.action === RECHECK_ACTION.STILL_INACTIVE) {
                // Keep inactive; preserve notice/reminder flow (untouched here);
                // only stamp the check time and re-assert inactive access.
                await writers.recordCreditHeroState(client.crcClientId, {
                    credit_hero_access_state: "inactive",
                    last_credit_hero_check_at: nowIso,
                }).catch(() => {});
                summary.stillInactive += 1;
                summary.results.push(entry);
                continue;
            }

            // ---- POSITIVELY ACTIVE: reconcile Supabase (idempotent) --------
            const react = await writers.recordMonitoringReactivated(client.crcClientId, nowIso);
            entry.firstReactivation = react?.firstReactivation === true;
            entry.reactivatedDate = react?.reactivatedDate ?? null;

            // Record the newest available report date if the recheck saw one.
            // Recording it does NOT trigger disputes; it is memory only.
            if (live?.reportDate && writers.recordLastReportDate) {
                await writers.recordLastReportDate(client.crcClientId, live.reportDate).catch(() => {});
                entry.reportDate = live.reportDate;
            }

            if (decision.action === RECHECK_ACTION.REACTIVATED_WAITING) {
                // Store the derived eligibility date so tomorrow's preflight
                // short-circuits, then set CRC to Waiting For Bureau. No disputes.
                if (decision.nextEligibleDate) {
                    await writers.recordNextEligibleDate(client.crcClientId, decision.nextEligibleDate).catch(() => {});
                }
                const statusResult = await setCrcStatus(client, decision.targetCrcStatus ?? "Waiting For Bureau");
                entry.crcStatusWritten = statusResult?.statusWritten ?? null;
                // Persist the block reason + confirmed CRC status (mirrors the
                // existing routeToWaitingForBureau bookkeeping).
                if (statusResult?.statusUpdated === true && statusResult?.statusWritten) {
                    await writers.recordCreditHeroState(client.crcClientId, {
                        crc_client_status: statusResult.statusWritten,
                        block_reason: "WAITING_FOR_FREE_REPORT",
                    }).catch(() => {});
                }
                summary.reactivatedWaiting += 1;
                summary.results.push(entry);
                continue;
            }

            // ---- REACTIVATED_ELIGIBLE: hand to normal processing this run ---
            if (decision.action === RECHECK_ACTION.REACTIVATED_ELIGIBLE) {
                if (processEligible) {
                    const processed = await processEligible(client);
                    entry.processed = processed?.stage ?? processed?.outcome ?? true;
                }
                summary.reactivatedEligible += 1;
                summary.results.push(entry);
                continue;
            }

            summary.results.push(entry);
        } catch (error) {
            entry.error = error.message;
            summary.errors += 1;
            summary.results.push(entry);
        }
    }

    return summary;
}

export { INACTIVE_CRC_STATUS };
