// inactiveRecheckDecision.js
//
// PURE DECISION LAYER for the daily inactive-client recheck sweep.
//
// Permanent rule: when a Credit Monitoring Inactive client becomes positively
// active again, that client moves to Waiting For Bureau and waits for a STRICTLY
// newer free Credit Hero report before another dispute round can be generated.
// Reactivation itself never authorizes disputes and no 31-day dispute timer is
// used as the reactivation gate.

import { CH_LANDING_STATE } from "./creditHeroLandingState.js";

// Retained for compatibility with older callers/tests. Reactivation eligibility
// no longer depends on this value.
export const DEFAULT_CYCLE_DAYS = 31;

export const RECHECK_ACTION = Object.freeze({
    STILL_INACTIVE: "STILL_INACTIVE",
    REACTIVATED_WAITING: "REACTIVATED_WAITING",
    // Retained for compatibility; the reactivation decision no longer emits it.
    REACTIVATED_ELIGIBLE: "REACTIVATED_ELIGIBLE",
    // Retained for compatibility; reactivation no longer requires a historical
    // dispute-date backfill in order to leave the inactive state safely.
    HISTORICAL_DISPUTE_DATE_UNKNOWN: "HISTORICAL_DISPUTE_DATE_UNKNOWN",
});

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
 */
export function classifyRecheckLandingFromM6(m6) {
    const result = m6?.result ?? null;

    if (m6?.creditHeroAccessVerified === true) return CH_LANDING_STATE.HEALTHY_MEMBER_DASHBOARD;
    if (result === "PAYMENT_REQUIRED" || result === "CREDENTIALS_OR_AUTH_FAILED") return result;
    if (result === "CAPTURED" || result === "WAITING_FOR_FREE_REPORT") {
        return CH_LANDING_STATE.HEALTHY_MEMBER_DASHBOARD;
    }
    return CH_LANDING_STATE.UNKNOWN;
}

/**
 * Decide what the recheck sweep should do for one inactive client.
 *
 * A positively active reactivation ALWAYS enters Waiting For Bureau first.
 * Reactivation does not overwrite last_report_date_used. That baseline remains
 * the report used by the prior successfully delivered dispute cycle. The normal
 * freshness engine then requires a report STRICTLY NEWER than that baseline.
 */
export function decideInactiveRecheck({
    storedState = null,
    observedCrcStatus = null,
    landing = null,
    liveReportDate = null,
    todayIso,
    cycleDays = DEFAULT_CYCLE_DAYS,
} = {}) {
    // Keep legacy parameters in the signature for compatibility/diagnostics.
    void observedCrcStatus;
    void todayIso;
    void cycleDays;

    if (!isLandingPositivelyActive(landing)) {
        return {
            action: RECHECK_ACTION.STILL_INACTIVE,
            reason:
                `Live CreditHero result "${landing?.state ?? "none"}" is not a positive active ` +
                `confirmation. Client remains Credit Monitoring Inactive.`,
            keepInactive: true,
        };
    }

    const baseline = storedState?.last_report_date_used ?? null;
    const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

    if (validDate(baseline) && validDate(liveReportDate) && liveReportDate > baseline) {
        return {
            action: RECHECK_ACTION.REACTIVATED_ELIGIBLE,
            reason:
                `Monitoring is active and Credit Hero already has a strictly newer report (${liveReportDate}) ` +
                `than the prior successful-cycle report (${baseline}). Process this client this run.`,
            waitForFreshReport: false,
        };
    }

    return {
        action: RECHECK_ACTION.REACTIVATED_WAITING,
        reason:
            validDate(baseline)
                ? "Monitoring is positively active again, but no report strictly newer than the prior successful-cycle report is available yet. Route the client to Waiting For Bureau."
                : "Monitoring is positively active again, but this legacy row has no authoritative prior report baseline. Route the client to Waiting For Bureau and do not process from an unproven report.",
        nextEligibleDate: null,
        targetCrcStatus: "Waiting For Bureau",
        waitForFreshReport: true,
    };
}
