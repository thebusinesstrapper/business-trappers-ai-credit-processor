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
 * Gap between successive observations of the marker set.
 *
 * This is not a fixed sleep before a blind read. It is the interval between two
 * comparable observations, inside a loop that exits as soon as the set has held
 * still, and is bounded by STATE_MARKER_TIMEOUT.
 */
const CONFIRM_INTERVAL_MS = 250;

/**
 * How many CONSECUTIVE confirmation intervals the complete visible marker set
 * must remain identical before we trust it.
 *
 * Two, not one. A single agreement can be produced by two reads that happen to
 * fall inside the same render pause. Requiring the set to survive two
 * consecutive intervals means a panel that is still painting has to hold a
 * false state twice in a row to fool us.
 */
const STABLE_INTERVALS_REQUIRED = 2;

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
 * Read which markers are CURRENTLY visible on the page.
 *
 * A snapshot, not a wait. Used to detect when rendering has settled.
 */
async function readVisibleMarkers(page) {
    const visible = [];

    for (const [name, pattern] of Object.entries(MARKERS)) {
        if (await isMarkerVisible(page, pattern)) {
            visible.push(name);
        }
    }

    return visible;
}

function sameMarkerSet(a, b) {
    return a.length === b.length && a.every((marker) => b.includes(marker));
}

/** Render a marker set for logs, so an empty set is visible rather than blank. */
function formatMarkers(markers) {
    return markers.length ? markers.join(", ") : "none";
}

/**
 * Wait until the set of visible state markers has STOPPED CHANGING.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST "WAIT FOR THE FIRST MARKER"
 *
 * An earlier implementation waited on a UNION and released the moment ANY one
 * marker appeared — then classification read all four. That leaves a window
 * where the first marker has painted and the others have not.
 *
 * That window is dangerous in one specific, asymmetric way. A lead who never
 * enrolled in Credit Hero Score has also, by definition, never had a report
 * imported — so CHS_NOT_ACTIVATED and NEW_CLIENT can render on the same page.
 * That co-occurrence is exactly why the CHS blocker has precedence. But
 * precedence only protects us if BOTH markers are visible when we read. If
 * NEW_CLIENT paints first, the union wait releases, we read before the blocker
 * has rendered, and an un-enrollable lead is classified ELIGIBLE.
 *
 * The blocker rule would be silently bypassed by a race, not by a logic error.
 * So we wait for the marker SET to settle, not for its first member.
 *
 * Note what we deliberately do NOT wait on: networkidle. As documented in
 * openClient.js, CRC keeps background requests alive indefinitely, so it never
 * fires. And we cannot "wait for the right element" — identifying which element
 * is right is the entire job of this module.
 * ---------------------------------------------------------------------------
 *
 * STABILITY RULE
 *
 * The complete visible marker set must be IDENTICAL across
 * STABLE_INTERVALS_REQUIRED consecutive confirmation intervals before we will
 * classify on it. Any change resets the counter — a set that flickers has not
 * settled, and we do not get to pick whichever snapshot we liked.
 *
 * FAILS CLOSED. If the set never stabilizes within STATE_MARKER_TIMEOUT, we
 * return an EMPTY set rather than classifying on the last thing we happened to
 * see. An empty set routes to UNKNOWN -> manual_review. We would rather send a
 * client to a human than classify one against a page that was still moving.
 *
 * @returns {Promise<string[]>} the settled marker set, or [] if it never settled
 */
async function waitForStableMarkers(page) {
    const anyMarker = page
        .getByText(MARKERS.CHS_NOT_ACTIVATED)
        .or(page.getByText(MARKERS.NEW_CLIENT))
        .or(page.getByText(MARKERS.READY_FOR_REIMPORT))
        .or(page.getByText(MARKERS.WAITING_FOR_REPORT))
        .first();

    // 1. Wait for the panel to produce at least one recognizable marker.
    try {
        await anyMarker.waitFor({ state: "visible", timeout: STATE_MARKER_TIMEOUT });
    } catch {
        console.warn("No recognized Import/Audit state message appeared.");
        return [];
    }

    // 2. Then wait for the marker set to hold still.
    const deadline = Date.now() + STATE_MARKER_TIMEOUT;

    let previous = await readVisibleMarkers(page);
    let stableIntervals = 0;

    console.log(`Import/Audit markers observed: [${formatMarkers(previous)}]`);

    while (Date.now() < deadline) {
        await page.waitForTimeout(CONFIRM_INTERVAL_MS);

        const current = await readVisibleMarkers(page);

        if (sameMarkerSet(previous, current)) {
            stableIntervals += 1;

            console.log(
                `Import/Audit markers observed: [${formatMarkers(current)}] ` +
                `— stable for ${stableIntervals}/${STABLE_INTERVALS_REQUIRED} interval(s).`
            );

            if (stableIntervals >= STABLE_INTERVALS_REQUIRED) {
                return current;
            }
        } else {
            // The page is still rendering. Any change invalidates every prior
            // confirmation — we start counting again from zero.
            stableIntervals = 0;

            console.log(
                `Import/Audit markers observed: [${formatMarkers(current)}] ` +
                `— changed from [${formatMarkers(previous)}], resetting stability count.`
            );
        }

        previous = current;
    }

    // FAIL CLOSED. The page never held still, so we have no trustworthy
    // snapshot. Do not classify on the last thing we saw.
    console.error(
        "Import/Audit markers never stabilized within the timeout. " +
        "Failing closed — this client will route to manual review."
    );

    return [];
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

    // Classification reads from a SETTLED snapshot, never from live per-marker
    // queries issued while the panel may still be painting.
    const markers = await waitForStableMarkers(page);

    if (markers.length === 0) {
        return { state: CRC_STATES.UNKNOWN, observed: [] };
    }

    // --- Hard blocker, highest precedence. Stop evaluating immediately. ---
    if (markers.includes("CHS_NOT_ACTIVATED")) {
        console.log("Recognized: Credit Hero Score never activated (hard blocker).");
        return {
            state: CRC_STATES.CHS_NOT_ACTIVATED,
            observed: markers,
        };
    }

    // --- Remaining states. Every match is already captured in the settled
    //     snapshot, so ambiguity (two markers, or none) is detectable rather
    //     than raced past. ---
    const observed = markers;

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
