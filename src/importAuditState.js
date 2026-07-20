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
 * Window for the DASHBOARD blocker probe.
 *
 * Deliberately much shorter than STATE_MARKER_TIMEOUT. That timeout is sized for
 * a panel we know is going to render something. The dashboard probe runs on
 * EVERY client, and on an active one there is nothing to find — so a 20s wait
 * would be 20s of nothing, per client, on every run.
 */
const DASHBOARD_BLOCKER_TIMEOUT = 6000;

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
    // Same state, three observed phrasings. The Import/Audit panel says "Invite
    // your lead to..."; the client DASHBOARD says "Client doesn't have a credit
    // monitoring account yet? Send them an invite to...". One marker name, one
    // state — a second key would need a second CRC_STATES entry and would be
    // missed by the blocker-precedence check below.
    //
    // The apostrophe is matched loosely because CRC renders a curly one.
    CHS_NOT_ACTIVATED:
        /invite\s+your\s+lead\s+to\s+credit\s*hero\s*score|send\s+them\s+an\s+invite\s+to\s+credit\s*hero\s*score|doesn.?t\s+have\s+a\s+credit\s+monitoring\s+account/i,

    NEW_CLIENT: /no\s+credit\s+reports\s+have\s+been\s+imported\s+yet/i,

    READY_FOR_REIMPORT: /new\s*report\s*available\s*now/i,

    WAITING_FOR_REPORT: /new\s*report\s*available\s*in\b/i,
};

/**
 * Every frame we should search for state markers: the main page plus any
 * iframes.
 *
 * WHY FRAMES: page.getByText() does NOT pierce iframes. CRC is an older
 * application and may well render the Import/Audit panel inside one. If it
 * does, the panel is plainly visible to a human while every page-level locator
 * returns zero matches — for the full timeout. That produces exactly the
 * symptom we are chasing: an empty marker set after a 20-second wait, which is
 * not "we looked too early" but "we looked in the wrong document."
 *
 * Searching frames is generic. It does not guess a container selector.
 */
function searchableFrames(page) {
    return page.frames();
}

/**
 * Is this message currently VISIBLE anywhere we can see — main page or iframe?
 *
 * Scoped to visibility on purpose: CRC keeps other dashboard tabs in the DOM,
 * so a raw text-content match could read a message from a tab the user isn't
 * looking at. Only what is actually rendered counts as evidence.
 */
async function isMarkerVisible(page, pattern) {
    for (const frame of searchableFrames(page)) {
        let locator;

        try {
            locator = frame.getByText(pattern);
        } catch {
            // A frame can detach mid-render. Skip it rather than fail the run.
            continue;
        }

        let count = 0;

        try {
            count = await locator.count();
        } catch {
            continue;
        }

        for (let i = 0; i < count; i++) {
            try {
                if (await locator.nth(i).isVisible()) {
                    return true;
                }
            } catch {
                // Element went away between count and check. Keep looking.
            }
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
 *
 * THE CLICK IS VERIFIED, NOT ASSUMED.
 *
 * openClient.js already documents this failure mode in CRC: an element can look
 * exactly like a control, match a text locator, and have no click handler at
 * all — so clicking it is a silent no-op. The text-based branch of the union
 * below can match a plain LABEL rather than the real tab, and .first() resolves
 * in DOM order, so the label can win.
 *
 * If that happens we never leave the dashboard, and the marker wait then burns
 * its full timeout looking for a panel that was never opened. So we record the
 * URL either side of the click and say so loudly when nothing moved.
 */
async function openImportAuditTab(page) {
    const urlBeforeClick = page.url();

    console.log("Opening the Import/Audit tab...");
    console.log("URL before Import/Audit click:", urlBeforeClick);

    const tab = page
        .getByRole("tab", { name: /import\s*\/?\s*audit/i })
        .or(page.getByRole("link", { name: /import\s*\/?\s*audit/i }))
        .or(page.getByText("Import/Audit", { exact: true }))
        .first();

    await tab.waitFor({ state: "visible", timeout: TAB_TIMEOUT });
    await tab.click();

    return urlBeforeClick;
}

/**
 * Report what the page ACTUALLY contains when no marker was recognized.
 *
 * This exists because "no markers found" has several very different causes and
 * they are indistinguishable from the outside:
 *
 *   1. The tab click no-opped and we are still on the dashboard.
 *   2. The panel rendered inside an iframe we were not searching.
 *   3. The marker text is genuinely different from what we were told.
 *
 * Guessing between these means changing code without knowing what is broken.
 * One run with this diagnostic decides it.
 */
async function reportRecognitionFailure(page, urlBeforeClick) {
    console.error("--- Import/Audit recognition failed. Diagnostics follow. ---");

    const urlNow = page.url();

    console.error("URL before Import/Audit click:", urlBeforeClick);
    console.error("URL now:                      ", urlNow);

    if (urlNow === urlBeforeClick) {
        console.error(
            "URL DID NOT CHANGE. The Import/Audit tab click may have hit a " +
            "non-interactive element and silently done nothing — the same " +
            "no-op click failure already documented in openClient.js."
        );
    }

    const frames = page.frames();
    console.error(`Frames on page: ${frames.length}`);
    frames.forEach((frame, i) => {
        console.error(`  [${i}] ${frame.url()}`);
    });

    // Dump the visible text so we can read the panel's ACTUAL wording and
    // compare it against MARKERS, rather than theorizing about it.
    for (const [i, frame] of frames.entries()) {
        try {
            const text = await frame.locator("body").innerText({ timeout: 5000 });
            console.error(`--- Visible text, frame [${i}] ---`);
            console.error(text.slice(0, 2000));
        } catch {
            console.error(`--- Visible text, frame [${i}] --- (unreadable)`);
        }
    }

    console.error("--- End diagnostics ---");
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
    // 1. Wait for the panel to produce at least one recognizable marker.
    //
    //    This polls readVisibleMarkers() rather than waiting on a page-level
    //    locator union. A .or() union is bound to ONE document, so it cannot see
    //    into an iframe; readVisibleMarkers() searches every frame. Since the
    //    markers are our only verified mount signal, this poll IS the gate — we
    //    do not begin stabilization until the panel has actually produced one.
    const appearanceDeadline = Date.now() + STATE_MARKER_TIMEOUT;

    let previous = [];

    while (Date.now() < appearanceDeadline) {
        previous = await readVisibleMarkers(page);

        if (previous.length > 0) {
            break;
        }

        await page.waitForTimeout(CONFIRM_INTERVAL_MS);
    }

    if (previous.length === 0) {
        console.warn("No recognized Import/Audit state message appeared.");
        return [];
    }

    // 2. Then wait for the marker set to hold still.
    const deadline = Date.now() + STATE_MARKER_TIMEOUT;

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
/**
 * Is the CreditHero hard blocker visible on the CLIENT DASHBOARD?
 *
 * WHY THIS EXISTS SEPARATELY FROM recognizeImportAuditState().
 *
 * That function begins by CLICKING the Import/Audit tab. Calling it before
 * openCreditHero() would navigate every client away from the dashboard, and the
 * CreditHero link only exists there — so every ACTIVE client would break. This
 * probe reads the page it is given and navigates nothing.
 *
 * SCOPE. It answers one question: is the not-activated banner present? It does
 * not classify the other Import/Audit states, which belong to a different page
 * and a different decision. CHS_NOT_ACTIVATED is the highest-precedence marker
 * in this module, so a positive match cannot be overridden by anything else and
 * checking it alone preserves that precedence exactly.
 *
 * NOT HALF-RENDERED. A single visible read is not enough — a banner mid-paint is
 * a banner we may be reading too early. The marker must be present on
 * STABLE_INTERVALS_REQUIRED consecutive reads before it counts.
 *
 * FAILS OPEN, ON PURPOSE. No banner within the window means "not proven
 * blocked", and the caller proceeds down the ordinary path. A missed banner
 * costs a normal CreditHero attempt that then fails to CREDIT_HERO_UNAVAILABLE
 * and manual review. The opposite error — declaring a paying client inactive and
 * messaging them about payment — is the one worth engineering against.
 *
 * @returns {Promise<{blocked: boolean, state: string, observed: string[]}>}
 */
export async function recognizeDashboardBlocker(page, timeoutMs = DASHBOARD_BLOCKER_TIMEOUT) {
    const pattern = MARKERS.CHS_NOT_ACTIVATED;
    const deadline = Date.now() + timeoutMs;

    let consecutive = 0;

    while (Date.now() < deadline) {
        const visible = await isMarkerVisible(page, pattern).catch(() => false);

        if (visible) {
            consecutive += 1;

            if (consecutive >= STABLE_INTERVALS_REQUIRED) {
                console.log("Dashboard blocker confirmed: Credit Hero Score not activated.");
                return {
                    blocked: true,
                    state: CRC_STATES.CHS_NOT_ACTIVATED,
                    observed: ["CHS_NOT_ACTIVATED"],
                };
            }
        } else if (consecutive > 0) {
            // It flickered. A set that will not hold still has not settled.
            consecutive = 0;
        }

        await page.waitForTimeout(CONFIRM_INTERVAL_MS);
    }

    return { blocked: false, state: CRC_STATES.UNKNOWN, observed: [] };
}

export async function recognizeImportAuditState(page) {
    const urlBeforeClick = await openImportAuditTab(page);

    // Classification reads from a SETTLED snapshot, never from live per-marker
    // queries issued while the panel may still be painting.
    const markers = await waitForStableMarkers(page);

    if (markers.length === 0) {
        // Either nothing ever rendered, or it never held still. Both fail
        // closed to manual review — but they have different causes, so dump
        // enough context to tell them apart on the next run.
        await reportRecognitionFailure(page, urlBeforeClick);

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
