/**
 * importAuditState.js
 *
 * Responsible ONLY for:
 *   1. Opening the "Import/Audit" tab on an already-open client dashboard.
 *   2. Reading the page and recognizing WHICH CRC state it is showing.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE CONTAINS NO BUSINESS LOGIC.
 *
 * It answers exactly one question: "what is CRC currently displaying?"
 * It does NOT decide whether the client is eligible. That mapping lives in
 * eligibility.js.
 *
 * The split is deliberate. CRC's wording will change over time; Business
 * Trappers eligibility rules will not. When CRC rewords a message, ONLY the
 * patterns in this file change. The decision engine stays frozen.
 * ---------------------------------------------------------------------------
 *
 * SAFETY INVARIANT — DO NOT VIOLATE
 *
 * This module clicks EXACTLY ONE element: the "Import/Audit" tab.
 * It never clicks "Import Credit Report Now" or "Reimport Credit Report".
 * Those actions retrieve a report and are the responsibility of Milestone 5,
 * which runs only AFTER this module has returned a state that the eligibility
 * engine classifies as eligible.
 *
 * Recognition is read-only. Always.
 */

const TAB_TIMEOUT = 20000;
const STATE_MARKER_TIMEOUT = 20000;

/**
 * The recognized CRC page states. These are UI facts, not business decisions.
 */
export const CRC_STATES = {
    NEW_CLIENT: "CRC_STATE_NEW_CLIENT",
    READY_FOR_REIMPORT: "CRC_STATE_READY_FOR_REIMPORT",
    WAITING_FOR_REPORT: "CRC_STATE_WAITING_FOR_REPORT",
    CHS_NOT_ACTIVATED: "CRC_STATE_CHS_NOT_ACTIVATED",
    UNKNOWN: "CRC_STATE_UNKNOWN",
};

/**
 * Observed page messages, one per recognized state.
 *
 * CRITICAL — READY_FOR_REIMPORT vs WAITING_FOR_REPORT:
 *
 *   State 2 (eligible):     "New Report available now"
 *   State 3 (not eligible): "New Report available in 30 days"
 *
 * These share the prefix "New Report available". A loose substring match on
 * that prefix would match BOTH, and a client who must wait 30 days would be
 * classified eligible and handed to Milestone 5, which would attempt a
 * Reimport. That is the single most dangerous bug available in this milestone.
 *
 * The patterns below are therefore anchored on the DISTINGUISHING words —
 * "now" vs "in" — and are mutually exclusive by construction. If both somehow
 * match, recognition returns UNKNOWN rather than picking one.
 *
 * NOTE: the Reimport BUTTON is deliberately not consulted anywhere in this
 * file. It is present in BOTH state 2 and state 3, so it carries zero
 * eligibility signal. The page MESSAGE is authoritative.
 */
const MARKERS = {
    // Hard blocker. Highest precedence — see recognizeImportAuditState().
    CHS_NOT_ACTIVATED: /invite\s+your\s+lead\s+to\s+credit\s*hero\s*score/i,

    NEW_CLIENT: /no\s+credit\s+reports\s+have\s+been\s+imported\s+yet/i,

    READY_FOR_REIMPORT: /new\s*report\s*available\s*now/i,

    WAITING_FOR_REPORT: /new\s*report\s*available\s*in\b/i,
};

/**
 * Is this message currently VISIBLE on the page?
 *
 * Scoped to visibility on purpose: CRC keeps other dashboard tabs in the DOM,
 * so a raw text-content match could read a message from a tab the user isn't
 * looking at. Only what is actually rendered counts as evidence.
 */
async function isMarkerVisible(page, pattern) {
    const locator = page.getByText(pattern);
    const count = await locator.count();

    for (let i = 0; i < count; i++) {
        if (await locator.nth(i).isVisible()) {
            return true;
        }
    }

    return false;
}

/**
 * Open the "Import/Audit" tab within the client dashboard.
 *
 * Same role -> tag -> text union used elsewhere in this codebase, for the same
 * reason: CRC renders href-less anchors, which carry no ARIA "link" role, so a
 * role-based query alone can silently match nothing.
 */
async function openImportAuditTab(page) {
    console.log("Opening the Import/Audit tab...");

    const tab = page
        .getByRole("tab", { name: /import\s*\/?\s*audit/i })
        .or(page.getByRole("link", { name: /import\s*\/?\s*audit/i }))
        .or(page.getByText("Import/Audit", { exact: true }))
        .first();

    await tab.waitFor({ state: "visible", timeout: TAB_TIMEOUT });
    await tab.click();
}

/**
 * Wait for the Import/Audit tab to finish rendering.
 *
 * No arbitrary timeout is needed here: the four state messages ARE the
 * readiness signal. Whichever one appears tells us both that the page has
 * rendered and what it is showing. We wait for the union and let Playwright
 * settle on whichever branch the real page uses.
 *
 * If none of them appears, the page is in a state we do not recognize. That is
 * not an error — it is a legitimate UNKNOWN, which the eligibility engine
 * routes to manual review.
 *
 * @returns {Promise<boolean>} true if a known marker rendered
 */
async function waitForAnyStateMarker(page) {
    const anyMarker = page
        .getByText(MARKERS.CHS_NOT_ACTIVATED)
        .or(page.getByText(MARKERS.NEW_CLIENT))
        .or(page.getByText(MARKERS.READY_FOR_REIMPORT))
        .or(page.getByText(MARKERS.WAITING_FOR_REPORT))
        .first();

    try {
        await anyMarker.waitFor({ state: "visible", timeout: STATE_MARKER_TIMEOUT });
        return true;
    } catch {
        console.warn("No recognized Import/Audit state message appeared.");
        return false;
    }
}

/**
 * Open the Import/Audit tab and recognize the CRC page state.
 *
 * Precedence is a BUSINESS RULE, not an implementation detail:
 *
 *   "Invite your lead to Credit Hero Score" is a HARD BLOCKER and is evaluated
 *   FIRST, before anything else. A client who never completed Credit Hero
 *   enrollment cannot be processed, no matter what else the page says. Such a
 *   lead has also, by definition, never had a report imported — so the
 *   NEW_CLIENT message may well appear alongside it. Checking NEW_CLIENT first
 *   would classify an un-enrollable lead as eligible. It does not get checked
 *   first.
 *
 * After the blocker, the remaining three states must be UNAMBIGUOUS. If more
 * than one matches, we do not guess — we return UNKNOWN and let a human look.
 *
 * @returns {Promise<{ state: string, observed: string[] }>}
 */
export async function recognizeImportAuditState(page) {
    await openImportAuditTab(page);

    const markerRendered = await waitForAnyStateMarker(page);

    if (!markerRendered) {
        return { state: CRC_STATES.UNKNOWN, observed: [] };
    }

    // --- Hard blocker, highest precedence. Stop evaluating immediately. ---
    if (await isMarkerVisible(page, MARKERS.CHS_NOT_ACTIVATED)) {
        console.log("Recognized: Credit Hero Score never activated (hard blocker).");
        return {
            state: CRC_STATES.CHS_NOT_ACTIVATED,
            observed: ["CHS_NOT_ACTIVATED"],
        };
    }

    // --- Remaining states. Collect ALL matches so we can detect ambiguity. ---
    const observed = [];

    if (await isMarkerVisible(page, MARKERS.NEW_CLIENT)) {
        observed.push("NEW_CLIENT");
    }

    if (await isMarkerVisible(page, MARKERS.READY_FOR_REIMPORT)) {
        observed.push("READY_FOR_REIMPORT");
    }

    if (await isMarkerVisible(page, MARKERS.WAITING_FOR_REPORT)) {
        observed.push("WAITING_FOR_REPORT");
    }

    // Exactly one match is the only confident outcome.
    if (observed.length !== 1) {
        console.warn(
            `Import/Audit page state is ambiguous. Matched: [${observed.join(", ") || "none"}]`
        );
        return { state: CRC_STATES.UNKNOWN, observed };
    }

    const state = CRC_STATES[observed[0]];

    console.log(`Recognized Import/Audit state: ${state}`);

    return { state, observed };
}
