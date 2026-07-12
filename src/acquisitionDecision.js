/**
 * acquisitionDecision.js
 *
 * The Report Acquisition Decision Engine.
 *
 * ---------------------------------------------------------------------------
 * A PURE FUNCTION. NO BROWSER. NO SIDE EFFECTS. NO NETWORK.
 *
 * It imports no Playwright, touches no page, and writes nothing. It takes an
 * OrderPageState (from orderPageReader.js) plus a MemoryState, and returns a
 * recommendation.
 *
 * This is deliberate and it is the safety mechanism. Per Report Acquisition
 * Authority™ §7: the decision to spend a client's entitlement is fully
 * unit-testable without a browser, and can be REVIEWED AS A DECISION TABLE
 * rather than inferred from scraping code.
 *
 * THIS ENGINE NEVER ACTS. It returns a recommendation. Something else must
 * decide to honour it.
 * ---------------------------------------------------------------------------
 */

import { FREE_OPTION_ID, PAID_OPTION_ID } from "./orderPageReader.js";

export const DECISIONS = {
    SUBMIT_FREE_REPORT: "submit_free_report",
    NO_ACTION_REQUIRED: "no_action_required",
    MANUAL_REVIEW: "manual_review",
};

function manualReview(reason) {
    return {
        decision: DECISIONS.MANUAL_REVIEW,
        free_available: false,
        paid_available: null,
        selected_option: null,
        reason,
        submitted: false,
    };
}

/**
 * Decide whether to acquire a new report.
 *
 * @param {object} orderPageState - from readOrderPage()
 * @param {object} memoryState
 * @param {boolean} memoryState.newer_report_required
 * @param {object|null} memoryState.open_acquisition_intent - unresolved intent record, if any
 *
 * @returns {{
 *   decision: string,
 *   free_available: boolean,
 *   paid_available: boolean|null,
 *   selected_option: object|null,
 *   reason: string,
 *   submitted: false
 * }}
 */
export function decideAcquisition(orderPageState, memoryState = {}) {
    const { newer_report_required, open_acquisition_intent } = memoryState;

    // --- Precondition 7: idempotency. Checked FIRST. -----------------------
    //
    // An unresolved intent record means a PREVIOUS run may or may not have
    // already ordered — we cannot tell. Retrying could consume a second
    // entitlement for one cycle.
    //
    // We do not retry. We do not assume it failed. We do not assume it
    // succeeded. A human determines what actually happened.
    //
    // "We would rather stall a client than order twice." (§5)
    if (open_acquisition_intent) {
        return manualReview(
            "unresolved_acquisition_intent: a previous run may have already submitted an " +
            "order. Outcome unknown. A human must confirm before any further submission."
        );
    }

    // --- Precondition 6: acquisition is driven by NEED, not availability. --
    //
    // The mere existence of a free report is not a reason to consume it.
    if (!newer_report_required) {
        return {
            decision: DECISIONS.NO_ACTION_REQUIRED,
            free_available: false,
            paid_available: null,
            selected_option: null,
            reason: "AI Memory does not require a newer report. The current report is sufficient.",
            submitted: false,
        };
    }

    // --- The page must have been read at all. ------------------------------
    if (!orderPageState || !orderPageState.page_read) {
        return manualReview("order_page_not_read: could not read the Order New Report page.");
    }

    const options = orderPageState.options || [];

    if (options.length === 0) {
        return manualReview("no_options_found: no purchase options were found on the order page.");
    }

    // --- §3.1: a page we cannot fully account for is a page we do not act on.
    //
    // An unrecognized purchase option might be free, might be $39.99, might be
    // the one that is actually preselected. We do not find out by submitting.
    if ((orderPageState.unaccounted_option_ids || []).length > 0) {
        return manualReview(
            `unaccounted_options: the order page contains purchase option(s) we do not ` +
            `recognize [${orderPageState.unaccounted_option_ids.join(", ")}]. ` +
            `We do not act on a page we cannot fully account for.`
        );
    }

    // --- Every option must be priced. --------------------------------------
    //
    // If ANY selectable option's cost is unreadable, we do not know what page
    // we are looking at. Absence of evidence of cost is not evidence of no cost.
    const unpriced = options.filter((o) => o.cost === null);

    if (unpriced.length > 0) {
        return manualReview(
            `unpriced_options: cost could not be affirmatively determined for ` +
            `[${unpriced.map((o) => o.id).join(", ")}]. Ambiguity never resolves toward spending.`
        );
    }

    // --- Precondition 1 & 2: positively identify the FREE membership option.
    const freeOption = options.find((o) => o.id === FREE_OPTION_ID);

    if (!freeOption) {
        return manualReview(
            `free_option_absent: the no-cost membership option (${FREE_OPTION_ID}) ` +
            `was not present on the page.`
        );
    }

    // The option we intend to submit must ITSELF be verified as zero-cost.
    // Not "a free option exists somewhere" — THIS one, the one we would submit.
    if (freeOption.cost !== 0) {
        return manualReview(
            `free_option_not_zero_cost: ${FREE_OPTION_ID} priced at ${freeOption.cost} ` +
            `(evidence: ${freeOption.cost_evidence ?? "none"}). It is not free. Not submitting.`
        );
    }

    // --- Precondition 5: the option must actually be usable now. -----------
    if (freeOption.disabled) {
        return manualReview(
            `free_option_disabled: ${FREE_OPTION_ID} is present but disabled. ` +
            `Not currently available.`
        );
    }

    if (!freeOption.visible) {
        return manualReview(
            `free_option_not_visible: ${FREE_OPTION_ID} is present in the DOM but not ` +
            `visible. We do not interact with controls a user could not see.`
        );
    }

    // --- Precondition 4: positively EXCLUDE the paid option. ---------------
    //
    // Identifying the free option is not sufficient. We must know where the
    // paid option is, and know that it is not the one we are selecting.
    const paidOption = options.find((o) => o.id === PAID_OPTION_ID);

    if (!paidOption) {
        // The paid option is expected on this page. Its absence means the page
        // is not the one we characterised — so we do not recognise this page.
        return manualReview(
            `paid_option_absent: the expected paid option (${PAID_OPTION_ID}) was not ` +
            `found. The page does not match the characterised structure. ` +
            `An unrecognised page is not one we act on.`
        );
    }

    if (paidOption.cost === 0) {
        // The option we believed was paid is priced at zero. Either the page
        // changed, or our identification is wrong. Either way we are confused
        // about which control costs money, and that is the worst possible state
        // in which to submit.
        return manualReview(
            `paid_option_priced_zero: ${PAID_OPTION_ID} is priced at 0, which contradicts ` +
            `its expected role. We cannot confidently distinguish the free option from the ` +
            `paid one. Not submitting.`
        );
    }

    if (freeOption.id === paidOption.id) {
        return manualReview("option_identity_collision: free and paid options resolved to the same control.");
    }

    // --- All preconditions met. -------------------------------------------
    return {
        decision: DECISIONS.SUBMIT_FREE_REPORT,
        free_available: true,
        paid_available: true,
        selected_option: {
            id: freeOption.id,
            cost: freeOption.cost,
            cost_evidence: freeOption.cost_evidence,
        },
        excluded_paid_option: {
            id: paidOption.id,
            cost: paidOption.cost,
            cost_evidence: paidOption.cost_evidence,
        },
        reason:
            `Free membership report (${FREE_OPTION_ID}) positively identified at cost 0 ` +
            `(evidence: ${freeOption.cost_evidence}); paid option (${PAID_OPTION_ID}) ` +
            `positively excluded at cost ${paidOption.cost}; option enabled and visible; ` +
            `AI Memory requires a newer report.`,

        // INVARIANT. This engine never submits. Whether anything acts on this
        // recommendation is not its business.
        submitted: false,
    };
}
