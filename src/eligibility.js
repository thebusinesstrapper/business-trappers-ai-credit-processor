/**
 * eligibility.js
 *
 * The Business Trappers Eligibility Decision Engine.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE CONTAINS NO UI CODE.
 *
 * It never touches a Playwright page, a selector, or a DOM node. It takes a
 * recognized CRC page state (from importAuditState.js) and maps it to a
 * business decision. Nothing else.
 *
 * That means it is a pure function, unit-testable with no browser, and it does
 * not change when CRC rewords a button or moves a message. This is the whole
 * point of the split: UI recognition churns, business rules do not.
 * ---------------------------------------------------------------------------
 */

import { CRC_STATES } from "./importAuditState.js";

/**
 * The Business Trappers decision table.
 *
 * Every recognized CRC state maps to exactly one business decision.
 *
 * Governing sources:
 *   - AI Processing Decision Engine v1.0 (eligibility rules)
 *   - Business Trappers policy: credit monitoring inactive -> manual review.
 *     The AI NEVER attempts to reactivate monitoring or enroll a lead.
 */
const DECISION_TABLE = {
    // New client, no report ever imported. Import is available.
    [CRC_STATES.NEW_CLIENT]: {
        eligibility: "eligible",
        client_type: "new",
        reason: "Import available",
    },

    // Existing client, a new report is available RIGHT NOW.
    [CRC_STATES.READY_FOR_REIMPORT]: {
        eligibility: "eligible",
        client_type: "existing",
        reason: "Reimport available",
    },

    // Existing client, but the next report is still days away.
    //
    // The Reimport button IS present in this state. It is not a signal.
    // Per the Decision Engine: "If no new report is available, stop
    // processing." We stop.
    [CRC_STATES.WAITING_FOR_REPORT]: {
        eligibility: "not_eligible",
        client_type: "existing",
        reason: "No new report available yet",
    },

    // Lead never completed Credit Hero Score enrollment. Hard blocker.
    // No report can be retrieved. The AI does not invite, enroll, or
    // reactivate — it hands the client to a human and stops.
    [CRC_STATES.CHS_NOT_ACTIVATED]: {
        eligibility: "manual_review",
        client_type: "unknown",
        reason: "credit_hero_not_activated",
    },

    // We could not recognize the page with confidence.
    //
    // This deliberately routes to manual_review, NOT not_eligible.
    // not_eligible is a POSITIVE finding ("monitoring is fine, there is simply
    // no new report yet") and is only ever returned when we can affirmatively
    // establish it. Ambiguity is never allowed to resolve toward proceeding.
    //
    // This is also where the not-yet-observed "monitoring was active but later
    // lapsed" state safely lands until we capture its markup.
    [CRC_STATES.UNKNOWN]: {
        eligibility: "manual_review",
        client_type: "unknown",
        reason: "unrecognized_page_state",
    },
};

/**
 * Map a recognized CRC page state to a Business Trappers eligibility decision.
 *
 * @param {string} crcState - a value from CRC_STATES
 * @returns {{ eligibility: string, client_type: string, reason: string }}
 */
export function classifyEligibility(crcState) {
    const decision = DECISION_TABLE[crcState];

    // Fail closed. An unmapped state is a bug, and a bug must never produce a
    // decision that lets processing continue.
    if (!decision) {
        console.warn(`No decision mapped for state "${crcState}". Routing to manual review.`);

        return {
            eligibility: "manual_review",
            client_type: "unknown",
            reason: "unmapped_page_state",
        };
    }

    return decision;
}
