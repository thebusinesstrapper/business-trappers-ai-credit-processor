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
 * included. Completed clients (Supabase process_complete = true) and clients whose
 * stored CRC status is Suspended are excluded from the automated recheck.
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
        // Suspended is an explicit manual pause and is excluded from ALL automated
        // processing. Do not let an old inactive-memory flag pull a suspended
        // client back into the daily CreditHero recheck sweep.
        if (key(row.crc_client_status) === "suspended") continue;
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
 * @param {(id, fields) => Promise<object>} [deps.writers.recordManualReview]
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
        // Existing inactive notice/reminder workflow, injected so the sweep can
        // (re)attempt an owed initial notice for a STILL_INACTIVE client without
        // duplicating any notice-decision logic. runInactiveWorkflow stays
        // authoritative for SEND_INITIAL_NOTICE / SEND_REMINDER / NO_MESSAGE_DUE,
        // the timestamps, and the errors. Optional: when absent (or not approved),
        // the notice step is simply skipped and the sweep behaves as before.
        runInactiveWorkflow = null,
        inactiveWorkflowApproved = false,
        todayIso = new Date().toISOString().slice(0, 10),
        nowIso = new Date().toISOString(),
    } = deps;

    const summary = {
        enumerated: 0,
        rechecked: 0,
        stillInactive: 0,
        reactivatedWaiting: 0,
        reactivatedEligible: 0,
        historicalDateUnknown: 0,
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
                liveReportDate: live?.reportDate ?? null,
                todayIso,
            });
            entry.action = decision.action;
            entry.reason = decision.reason;

            if (decision.action === RECHECK_ACTION.STILL_INACTIVE) {
                // Keep inactive; stamp the check time and re-assert inactive access.
                await writers.recordCreditHeroState(client.crcClientId, {
                    credit_hero_access_state: "inactive",
                    last_credit_hero_check_at: nowIso,
                }).catch(() => {});

                // Then run the EXISTING inactive notice/reminder workflow so an
                // owed initial notice is attempted (Marcelo/Unique: never sent) or
                // retried (Patience: prior composer failure). The sweep does NOT
                // decide whether a notice is due — runInactiveWorkflow ->
                // decideNoticeAction is authoritative: it sends the initial notice
                // only when inactive_notice_sent_at is null (so a successful notice
                // is never duplicated), records inactive_notice_last_error on
                // failure while leaving the timestamp null (so it retries next run),
                // and only considers a reminder after a successful initial notice.
                //
                // Gated exactly like the write-capable inactive path: it runs only
                // when a real runInactiveWorkflow is injected AND the run is
                // approved. A missing dependency or an unapproved/diagnostic run
                // skips it and the sweep behaves exactly as before.
                if (typeof runInactiveWorkflow === "function" && inactiveWorkflowApproved === true) {
                    try {
                        const notice = await runInactiveWorkflow({
                            clientName: client.clientName,
                            crcClientId: client.crcClientId,
                            inactiveWorkflowApproved: true,
                        });
                        entry.notice = {
                            plannedAction: notice?.plannedAction ?? null,
                            noticeSent: notice?.noticeSent === true,
                            reminderSent: notice?.reminderSent === true,
                            error_code: notice?.error_code ?? null,
                        };
                    } catch (error) {
                        // A notice-workflow failure never fails the sweep for this
                        // client — inactive state was already recorded above.
                        entry.notice = { error: error.message };
                    }
                }

                summary.stillInactive += 1;
                summary.results.push(entry);
                continue;
            }

            // ---- POSITIVELY ACTIVE: reconcile Supabase (idempotent) --------
            const react = await writers.recordMonitoringReactivated(client.crcClientId, nowIso);
            entry.firstReactivation = react?.firstReactivation === true;
            entry.reactivatedDate = react?.reactivatedDate ?? null;

            // Surface live report date diagnostically only. The freshness baseline
            // remains the report used by the prior successful dispute cycle.
            if (live?.reportDate) entry.reportDate = live.reportDate;

            // ---- HISTORICAL_DISPUTE_DATE_UNKNOWN: fail closed to Manual Review
            // Monitoring is active again (recordMonitoringReactivated above already
            // reconciled the client to active), but we cannot establish the prior
            // dispute delivery date, so eligibility cannot be computed. Route to
            // Manual Review. Deliberately write NO next_eligible_date (never
            // fabricate today + cycle) and advance no round / generate nothing.
            if (decision.action === RECHECK_ACTION.HISTORICAL_DISPUTE_DATE_UNKNOWN) {
                if (typeof writers.recordManualReview === "function") {
                    await writers.recordManualReview(client.crcClientId, {
                        stage: "reactivation_eligibility",
                        reason: decision.manualReviewReason ?? "HISTORICAL_DISPUTE_DATE_UNKNOWN",
                    }).catch(() => {});
                }
                entry.manualReview = decision.manualReviewReason ?? "HISTORICAL_DISPUTE_DATE_UNKNOWN";
                summary.historicalDateUnknown += 1;
                summary.results.push(entry);
                continue;
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
