// inactiveRecheckDecision.js
//
// PURE DECISION LAYER for the daily inactive-client recheck sweep.
//
// WHY THIS EXISTS
//   "Credit Monitoring Inactive" clients are denylisted from the normal dispute
//   queue (correctly — we must never dispute while access is inactive). But they
//   must still be looked at every production day so a reactivation cannot be
//   missed. processClientQueue runs a separate READ-ONLY recheck sweep; this
//   module decides, from stored state + observed CRC status + the LIVE CreditHero
//   landing result, exactly what that sweep should do. It performs no I/O and
//   opens no browser, so every branch is unit-testable.
//
// SAFETY INVARIANTS (enforced by the shape of the returned action)
//   - This module never returns an action that orders a report, reactivates
//     monitoring, or incurs a charge. The only "active" transition it can emit
//     requires a POSITIVELY confirmed live-active landing result.
//   - A reactivated client is NEVER moved straight into dispute generation on the
//     strength of a new report. Round timing is derived from last_dispute_date +
//     CYCLE_DAYS; within the waiting period the action routes to Waiting For
//     Bureau with a stored next_eligible_date and generates nothing.
//   - "Unknown"/unreadable live results fail closed: the client stays inactive.

import { CH_LANDING_STATE } from "./creditHeroLandingState.js";

// The dispute waiting-period length in days. Mirrors clientMemory.CYCLE_DAYS
// (31). Kept as a local default so this pure module has NO dependency on the
// database layer; callers may override to stay in lockstep with clientMemory.
export const DEFAULT_CYCLE_DAYS = 31;

export const RECHECK_ACTION = Object.freeze({
    // Access is still inactive (or not positively active). Keep everything
    // inactive, preserve the notice/reminder flow, stamp last_credit_hero_check_at.
    STILL_INACTIVE: "STILL_INACTIVE",
    // Access is positively active AND the client is still inside the dispute
    // waiting period. Reconcile to active, set reactivation date, clear the stale
    // block, set CRC "Waiting For Bureau", store the derived next_eligible_date.
    // NO disputes are generated.
    REACTIVATED_WAITING: "REACTIVATED_WAITING",
    // Access is positively active AND the waiting period has elapsed. Reconcile to
    // active, then hand the client to normal processing THIS run (subject to every
    // existing safeguard — the normal pipeline still decides what, if anything, to
    // dispute).
    REACTIVATED_ELIGIBLE: "REACTIVATED_ELIGIBLE",
    // Access is positively active, but the client has NO stored last_dispute_date
    // and we have no authoritative source to recover it. We CANNOT compute the
    // dispute waiting clock, and must NOT fabricate one from today (that would
    // silently impose a fresh 31-day wait from reactivation). Fail closed to
    // Manual Review; write no next_eligible_date; generate nothing.
    HISTORICAL_DISPUTE_DATE_UNKNOWN: "HISTORICAL_DISPUTE_DATE_UNKNOWN",
});

/** ISO date (YYYY-MM-DD) N days after an ISO date string. */
function isoDatePlusDays(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/**
 * Is the live landing result a POSITIVE confirmation of active monitoring?
 * Only the healthy member dashboard counts. Every inactive marker
 * (PAYMENT_REQUIRED, CREDENTIALS_OR_AUTH_FAILED) and UNKNOWN is NOT active.
 */
export function isLandingPositivelyActive(landing) {
    return !!landing && landing.state === CH_LANDING_STATE.HEALTHY_MEMBER_DASHBOARD;
}

/**
 * PURE. Map an M6 result object to the landing state the recheck understands.
 * Lives here (browser-free) so the exact classification is unit-testable, and is
 * imported by processClientQueue.recheckInactiveClient().
 *
 * AUTHORITY ORDER:
 *   1. creditHeroAccessVerified === true  -> positively active. M6 sets this the
 *      moment verifyActiveReport() confirms the live report, and preserves it on
 *      later fail-closed responses, so a post-verification extraction failure can
 *      no longer be misread as UNKNOWN (the Anthony Pee defect).
 *   2. PAYMENT_REQUIRED / CREDENTIALS_OR_AUTH_FAILED -> still inactive.
 *   3. CAPTURED / WAITING_FOR_FREE_REPORT -> positively active.
 *   4. anything else -> UNKNOWN (fail closed).
 */
export function classifyRecheckLandingFromM6(m6) {
    const result = m6?.result ?? null;

    if (m6?.creditHeroAccessVerified === true) return CH_LANDING_STATE.HEALTHY_MEMBER_DASHBOARD;
    if (result === "PAYMENT_REQUIRED" || result === "CREDENTIALS_OR_AUTH_FAILED") return result;
    if (result === "CAPTURED" || result === "WAITING_FOR_FREE_REPORT") return CH_LANDING_STATE.HEALTHY_MEMBER_DASHBOARD;
    return CH_LANDING_STATE.UNKNOWN;
}

/**
 * Decide what the recheck sweep should do for one inactive client.
 *
 * @param {object} params
 * @param {object|null} params.storedState  client_state row (may be null).
 * @param {string|null} params.observedCrcStatus  CRC status seen on the grid.
 * @param {object|null} params.landing  live recognizeCreditHeroLanding() result.
 * @param {string} params.todayIso  YYYY-MM-DD (production day).
 * @returns {{action:string, reason:string, ...}}
 */
export function decideInactiveRecheck({ storedState = null, observedCrcStatus = null, landing = null, todayIso, cycleDays = DEFAULT_CYCLE_DAYS }) {
    const today = String(todayIso).slice(0, 10);

    // ---- STILL INACTIVE (fail closed) -------------------------------------
    // Anything short of a positively confirmed healthy dashboard keeps the client
    // inactive. We do not guess "active" from a click that did not resolve.
    if (!isLandingPositivelyActive(landing)) {
        return {
            action: RECHECK_ACTION.STILL_INACTIVE,
            reason:
                `Live CreditHero result "${landing?.state ?? "none"}" is not a positive active ` +
                `confirmation. Client remains Credit Monitoring Inactive.`,
            // Persist only the check timestamp + (re-)assert inactive access.
            keepInactive: true,
        };
    }

    // ---- POSITIVELY ACTIVE -> reconcile, then decide round timing ----------
    // The waiting period is derived from the LAST dispute date, not from any
    // stored next_eligible_date (which may be blank on a client that was trapped
    // inactive before one was ever set).
    //
    // If there is NO readable last_dispute_date we must NOT invent one. A
    // historical client (ai_initialized=false) may have had disputes delivered
    // by the prior process months ago; deriving today + cycle would silently
    // impose a brand-new 31-day wait from reactivation and reset the real clock.
    // We cannot recover the true date here (no authoritative source), so we fail
    // closed to Manual Review with HISTORICAL_DISPUTE_DATE_UNKNOWN and write no
    // next_eligible_date. CreditHero access stays active; no round advances; no
    // disputes are generated. Once the real last_dispute_date is supplied (a
    // backfill), the client flows through the normal REACTIVATED_* branches below.
    const lastDispute = validIsoDate(storedState?.last_dispute_date) ? storedState.last_dispute_date : null;

    if (!lastDispute) {
        return {
            action: RECHECK_ACTION.HISTORICAL_DISPUTE_DATE_UNKNOWN,
            reason:
                `Monitoring is active again, but no prior dispute delivery date is stored ` +
                `(last_dispute_date is missing) and it cannot be established from an authoritative ` +
                `source. Eligibility cannot be calculated safely without inventing a waiting period, ` +
                `so the client is routed to Manual Review. CreditHero access remains active; no ` +
                `next_eligible_date is written, no round advances, and no disputes are generated.`,
            requiresManualReview: true,
            manualReviewReason: "HISTORICAL_DISPUTE_DATE_UNKNOWN",
            // No nextEligibleDate: we deliberately do not fabricate today + cycle.
        };
    }

    const derivedEligible = isoDatePlusDays(lastDispute, cycleDays);

    const withinWaitingPeriod =
        typeof derivedEligible === "string" && derivedEligible > today;

    if (withinWaitingPeriod) {
        return {
            action: RECHECK_ACTION.REACTIVATED_WAITING,
            reason:
                `Monitoring is active again, but the last dispute (${lastDispute}) + ${cycleDays} days ` +
                `= ${derivedEligible}, which is after today (${today}). Route to Waiting For Bureau; ` +
                `generate no disputes.`,
            nextEligibleDate: derivedEligible,
            targetCrcStatus: "Waiting For Bureau",
        };
    }

    return {
        action: RECHECK_ACTION.REACTIVATED_ELIGIBLE,
        reason:
            `Monitoring is active again and the waiting period has elapsed ` +
            `(last dispute ${lastDispute} + ${cycleDays} days = ${derivedEligible} <= today ${today}). ` +
            `Hand to normal processing this run, under all existing safeguards.`,
        nextEligibleDate: derivedEligible,
    };
}

function validIsoDate(v) {
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
