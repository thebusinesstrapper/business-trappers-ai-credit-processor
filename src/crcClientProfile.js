/**
 * crcClientProfile.js
 *
 * CRC CLIENT PROFILE READER — READ MODE ONLY.
 *
 * ===========================================================================
 * THIS MODULE HAS NO WRITE PATH. NOT A DISABLED ONE — NONE.
 *
 * It contains no .fill(), no .selectOption(), no .check(), and no click on any
 * control except the "View/Edit Profile" link that opens the modal and the "X"
 * that closes it. Status changes live in crcClientStatus.js, a separate module.
 *
 * The separation is the safety mechanism, not a stylistic choice. This is the
 * same posture as the Order Page Reader and the Order Submitter: the module that
 * READS cannot ACT, so a bug in reading can never become a write to a client's
 * record. A reader that merely *chooses* not to write is one refactor away from
 * writing.
 *
 * ===========================================================================
 * FROZEN NAVIGATION (Business Trappers ruling)
 *
 *   1. Open the client dashboard.        (already done by openClient.js)
 *   2. Click the blue "View/Edit Profile" link.
 *   3. Wait for the Edit Profile modal to become visible.
 *   4. Read the identity fields.
 *   5. Click CANCEL.
 *   6. Verify the modal is no longer visible.
 *   7. Verify the "View/Edit Profile" link is visible on the dashboard.
 *
 * The upper-right X is NO LONGER USED. Cancel is the approved exit.
 *
 * The profile is a MODAL, not a page. This reader never navigates away from the
 * dashboard, never constructs a profile URL, and never guesses a route.
 *
 * ===========================================================================
 * IDENTITY IS WHAT THIS PRODUCES, AND IDENTITY GOES ON A LEGAL DOCUMENT.
 *
 * These values are printed verbatim on correspondence to a credit bureau, over
 * the consumer's signature. There is no acceptable "close enough". Every field
 * is read from a labelled control or it is null — and a null required field
 * stops letter generation entirely.
 * ===========================================================================
 */

import { IDENTITY_SOURCE, normalizeIdentity } from "./clientIdentity.js";

const PROFILE_LINK_TEXT = "View/Edit Profile";
const MODAL_TIMEOUT = 20000;
const FIELD_TIMEOUT = 10000;

/**
 * FIELD LABELS — the anchor for every selector.
 *
 * We anchor on the visible LABEL, not on a generated id like `#input_4821`.
 * CRC's ids are framework-generated: they change when the form is reordered, a
 * field is added, or the vendor upgrades their component library. The label
 * "Mailing Address" changes when a human decides to rename it — which is a
 * decision, visible in a diff, and rare.
 *
 * A brittle selector does not fail loudly. It matches the WRONG field, reads a
 * plausible value, and prints somebody's phone number where the ZIP should be.
 */
const FIELD_LABELS = Object.freeze({
    firstName: "First Name",
    middleName: "Middle Name",
    lastName: "Last Name",
    address: "Mailing Address",
    city: "City",
    state: "State",
    zip: "Zip Code",
    email: "Email Address",
    phone: "Phone (Mobile)",
});

// Required for a letter. A missing one is a HARD STOP, not a warning.
const REQUIRED_FIELDS = ["firstName", "lastName", "address", "city", "state", "zip"];

/**
 * Read one labelled field from the modal.
 *
 * Tries label-anchored strategies in order, and returns null rather than
 * reaching for "whatever input is nearby". A null is recoverable — we stop and
 * say so. A wrong value is not: it goes on the letter.
 */
async function readLabelledField(scope, label) {
    const strategies = [
        // 1. Playwright's accessible-label resolution: <label for>, aria-label,
        //    aria-labelledby. The most robust when the markup is correct.
        () => scope.getByLabel(label, { exact: false }).first(),

        // 2. Placeholder text.
        () => scope.getByPlaceholder(label, { exact: false }).first(),

        // 3. Explicit <label for="..."> -> the control it names.
        //    Resolved via the DOM rather than by guessing the control's id.
        () => scope.locator(`label:has-text("${label}") + input`).first(),
        () => scope.locator(`label:has-text("${label}") + select`).first(),

        // 4. A labelled wrapper containing the control.
        () => scope.locator(`:has(> label:has-text("${label}")) input`).first(),
    ];

    for (const strategy of strategies) {
        try {
            const locator = strategy();

            if (await locator.count()) {
                const value = await locator.inputValue({ timeout: FIELD_TIMEOUT });
                return typeof value === "string" ? value.trim() : null;
            }
        } catch {
            // Try the next strategy. We never fall back to an unlabelled control.
        }
    }

    return null;
}

const MODAL_POPULATE_TIMEOUT = 15000;

/**
 * Wait until the REQUIRED identity fields actually carry values.
 *
 * Polls the real DOM state rather than sleeping. Optional fields (middle name,
 * email, phone) are legitimately blank on some clients and are never waited on —
 * waiting for a value that will never arrive would turn a complete profile into a
 * 15-second timeout.
 */
async function waitForPopulatedModal(page, modal) {
    const requiredLabels = REQUIRED_FIELDS.map((f) => FIELD_LABELS[f]);

    const deadline = Date.now() + MODAL_POPULATE_TIMEOUT;
    let lastRead = {};

    while (Date.now() < deadline) {
        lastRead = {};
        const stillEmpty = [];

        for (const label of requiredLabels) {
            const value = await readLabelledField(modal, label);

            lastRead[label] = value;

            if (!value) stillEmpty.push(label);
        }

        if (stillEmpty.length === 0) {
            return { ok: true, lastRead };
        }

        await page.waitForTimeout(300);
    }

    // Re-read once more so the reported state is the final state, not a stale one.
    const stillEmpty = requiredLabels.filter((label) => !lastRead[label]);

    return { ok: false, stillEmpty, lastRead };
}

/** Find the modal, in whichever frame it renders. */
async function findModal(page) {
    for (const frame of page.frames()) {
        for (const label of ["First Name", "Mailing Address"]) {
            try {
                const field = frame.getByLabel(label, { exact: false }).first();

                if (await field.count()) {
                    return frame;
                }
            } catch {
                // detached / cross-origin frame
            }
        }
    }

    return null;
}

/**
 * Open the Edit Profile modal, read identity, close it.
 *
 * @param {import('playwright').Page} page  a page on the CLIENT DASHBOARD
 * @param {string|number} crcClientId
 */
export async function readClientProfile(page, crcClientId) {
    const dashboardUrl = page.url();

    console.log("CRC PROFILE READER — READ MODE. No field is modified.");

    // ---- Open the modal ----------------------------------------------------
    const profileLink = page.getByText(PROFILE_LINK_TEXT, { exact: false }).first();

    if (!(await profileLink.count())) {
        return {
            ok: false,
            error_code: "PROFILE_LINK_NOT_FOUND",
            error:
                `Could not find the "${PROFILE_LINK_TEXT}" link on the client dashboard. The profile ` +
                `is a modal opened from this link — the reader does not navigate to a URL, and it will ` +
                `not guess one.`,
            identity: null,
        };
    }

    console.log(`Clicking "${PROFILE_LINK_TEXT}"...`);
    await profileLink.click({ timeout: FIELD_TIMEOUT });

    // ---- Wait for the modal ------------------------------------------------
    let modal = null;
    const deadline = Date.now() + MODAL_TIMEOUT;

    while (Date.now() < deadline) {
        modal = await findModal(page);
        if (modal) break;

        await page.waitForTimeout(300);
    }

    if (!modal) {
        return {
            ok: false,
            error_code: "MODAL_NOT_VISIBLE",
            error:
                `The Edit Profile modal did not become visible within ${MODAL_TIMEOUT / 1000}s. No ` +
                `identity was read, and no letter can be generated without it.`,
            identity: null,
        };
    }

    console.log("Edit Profile modal is visible. Waiting for it to be POPULATED...");

    // ---- THE MODAL EXISTING IS NOT THE MODAL BEING LOADED -------------------
    //
    // findModal() returns as soon as the First Name INPUT EXISTS. CRC renders the
    // modal shell first and populates it from the client record a moment later, so
    // reading immediately gets EMPTY inputs — every field comes back "", every
    // field becomes null, and the run reports REQUIRED_IDENTITY_FIELDS_MISSING on
    // a profile that is perfectly complete.
    //
    // That is a RACE. It passes when we win it and fails when we lose it, which is
    // why the standalone route succeeded and this one did not. Nothing about the
    // profile was wrong; we simply looked too early.
    //
    // We wait for the actual state change — required fields carrying VALUES — not
    // for a duration. A field that is genuinely empty still fails, but only after
    // we have given it a real chance to arrive.
    const populated = await waitForPopulatedModal(page, modal);

    if (!populated.ok) {
        return {
            ok: false,
            error_code: "REQUIRED_IDENTITY_FIELDS_MISSING",
            error:
                `The Edit Profile modal opened, but required identity fields were still empty after ` +
                `${MODAL_POPULATE_TIMEOUT / 1000}s: ${populated.stillEmpty.join(", ")}. Either CRC did ` +
                `not populate them, or the field is genuinely blank on this client's record. Letter ` +
                `generation STOPS — the processor does not substitute a value from the credit report, ` +
                `a previous run, or anywhere else.`,
            missing: populated.stillEmpty.map((label) => ({ label })),
            partial: populated.lastRead,
            identity: null,
            dashboardUrl,
        };
    }

    console.log("Modal populated. Reading identity fields...");

    // ---- Read every field --------------------------------------------------
    const raw = {};
    const missing = [];

    for (const [field, label] of Object.entries(FIELD_LABELS)) {
        const value = await readLabelledField(modal, label);

        raw[field] = value || null;

        if (!value) {
            missing.push({ field, label });
        }
    }

    // ---- Close the modal ---------------------------------------------------
    //
    // Always attempted, even if a read failed. Leaving a modal open would trap
    // the browser session for whatever runs next.
    // ---- Exit via CANCEL (frozen navigation) -------------------------------
    //
    // Always attempted, even if a field read failed. Leaving the modal open would
    // wedge the browser session for whatever runs next.
    const closed = await cancelModal(page, modal);

    // ---- Required fields are a HARD STOP -----------------------------------
    const missingRequired = missing.filter((m) => REQUIRED_FIELDS.includes(m.field));

    if (missingRequired.length) {
        return {
            ok: false,
            error_code: "REQUIRED_IDENTITY_FIELDS_MISSING",
            error:
                `Required identity fields could not be read from the CRC profile: ` +
                `${missingRequired.map((m) => m.label).join(", ")}. Letter generation STOPS. The ` +
                `processor does not substitute a value from the credit report, from a previous run, or ` +
                `from anywhere else — identity comes from CRC or the letter is not written.`,
            missing: missingRequired,
            partial: raw,
            identity: null,
            modalClosed: closed.ok,
            dashboardUrl,
        };
    }

    // ---- Build and NORMALIZE the authoritative identity ---------------------
    //
    // Normalization happens HERE, at the point of capture. Nothing downstream ever
    // sees the raw DOM strings — they are retained under identity.raw for audit
    // and are read by nobody.
    const identity = normalizeIdentity({
        source: IDENTITY_SOURCE.CRC_CLIENT_PROFILE,
        crcClientId: String(crcClientId),
        retrievedAt: new Date().toISOString(),
        sourceUrl: dashboardUrl,

        firstName: raw.firstName,
        middleName: raw.middleName,
        lastName: raw.lastName,

        name: [raw.firstName, raw.middleName, raw.lastName].filter(Boolean).join(" "),
        address_line_1: raw.address,
        city: raw.city,
        state: raw.state,
        postal_code: raw.zip,

        email: raw.email,
        phone: raw.phone,
    });

    // The state must canonicalize. CRC may hold "Florida"; the letter needs "FL".
    // A state we cannot recognise is a letter that does not arrive — we do not guess.
    if (!identity.state) {
        return {
            ok: false,
            error_code: "STATE_NOT_CANONICAL",
            error:
                `The State field reads ${JSON.stringify(raw.state)}, which does not resolve to a ` +
                `canonical two-letter code. A bureau letter addressed to an unrecognised state does ` +
                `not arrive. Letter generation STOPS.`,
            identity: null,
            modalClosed: closed.ok,
            dashboardUrl,
        };
    }

    console.log(`Identity read from CRC: ${identity.name}, ${identity.city}, ${identity.state}`);

    // ---- THE MODAL MUST BE CLOSED — A FAILED CLOSE IS A FAILED NAVIGATION ---
    //
    // The frozen sequence ends on the DASHBOARD, not on an open modal. Two
    // reasons, and the second is the one that matters:
    //
    //   1. The browser session is unusable. An open modal overlays the dashboard,
    //      so every subsequent click lands on a backdrop or is swallowed. The next
    //      milestone would fail somewhere far from here, with an error that says
    //      nothing about a modal.
    //
    //   2. WE ARE IN READ MODE. WE CHANGED NOTHING. There is no legitimate reason
    //      for this modal to resist closing. If an "unsaved changes" prompt is
    //      holding it open, then a field WAS modified — and that is a processor
    //      failure of the most serious kind, on the one form holding the
    //      consumer's legal identity.
    //
    // The identity we read is returned for DIAGNOSIS. A failed run supplies no
    // identity downstream.
    if (!closed.ok) {
        return {
            ok: false,

            // cancelModal names the SPECIFIC failure. These need different
            // responses, and collapsing them into one code is what sent us hunting
            // for an execution-path bug that did not exist:
            //
            //   CANCEL_CONTROL_NOT_FOUND  -> selector miss. Nothing was clicked.
            //   UNSAVED_CHANGES_PROMPT    -> A FIELD WAS MODIFIED. Processor failure.
            //   MODAL_STILL_VISIBLE       -> clicked, but the modal did not dismiss.
            //   DASHBOARD_NOT_RESTORED    -> modal gone, dashboard not confirmed.
            error_code: closed.error_code,
            error:
                `${closed.error} This is a FAILED NAVIGATION — the processor does not continue with ` +
                `the modal open, because every later click in this session would land on the backdrop ` +
                `and fail far from the real cause.`,

            // What each Cancel candidate matched, and the real markup if all missed.
            cancelAttempts: closed.attempts ?? null,
            modalHeaderHtml: closed.modalHeaderHtml ?? null,
            dialogs: closed.dialogs ?? null,
            inPagePrompt: closed.inPagePrompt ?? null,

            identityRead: identity, // diagnostic only — a failed run supplies no identity
            identity: null,
            modalClosed: false,
            requiresHumanReview: closed.requiresHumanReview ?? true,
            dashboardUrl,
            fieldsModified: 0,
        };
    }

    return {
        ok: true,
        identity,
        optionalMissing: missing.filter((m) => !REQUIRED_FIELDS.includes(m.field)),
        modalClosed: true,
        dashboardUrl,

        // INVARIANT. This module cannot write; there is no code path that could.
        fieldsModified: 0,
    };
}

/**
 * Exit the Edit Profile modal via the CANCEL button.
 *
 * ===========================================================================
 * FROZEN NAVIGATION (Business Trappers ruling, updated):
 *
 *   Click Cancel
 *        ↓
 *   Verify the Edit Profile modal is no longer visible
 *        ↓
 *   Verify the "View/Edit Profile" link is visible on the dashboard
 *
 * The upper-right X is no longer used.
 *
 * We verify BOTH conditions. "The modal is gone" and "we are back on a working
 * dashboard" are different facts: a modal can disappear into a spinner, an error
 * state, or a navigation we did not intend. Confirming the View/Edit Profile link
 * is visible is a POSITIVE confirmation that the dashboard is intact and usable —
 * an absence check alone would happily pass on a blank page.
 *
 * ===========================================================================
 * AN UNSAVED-CHANGES PROMPT IS A PROCESSOR FAILURE.
 *
 * We are in READ MODE. We filled nothing, selected nothing, typed nothing. The
 * form is CLEAN. There is therefore no legitimate reason for Cancel to ask us
 * whether we want to discard changes.
 *
 * If it does, a field WAS modified — on the one form holding the consumer's legal
 * identity — and that is the most serious failure this module can have.
 *
 * THE TRAP: Playwright AUTO-DISMISSES native dialogs by default. A browser-level
 * confirm("You have unsaved changes") would be dismissed silently, the modal would
 * close, the run would continue, and we would never learn that the processor had
 * edited a client's record. The one failure we most need to catch is the one the
 * framework hides by default.
 *
 * So we attach a dialog listener BEFORE clicking, and treat any dialog as a hard
 * failure. We also check for an IN-PAGE unsaved-changes prompt, since CRC may
 * render its own rather than using a native one.
 * ===========================================================================
 */

const CANCEL_LABEL = "Cancel";
const UNSAVED_CHANGES_PATTERN = /unsaved|discard|save your changes|leave without saving|changes you made/i;

async function cancelModal(page, modal) {
    // ---- Catch a native dialog BEFORE it can be auto-dismissed -------------
    const dialogs = [];

    const dialogHandler = async (dialog) => {
        dialogs.push({ type: dialog.type(), message: dialog.message() });

        console.error(`DIALOG APPEARED ON CANCEL: "${dialog.message()}"`);

        // Dismiss it so the session is not wedged. The RUN still fails — see below.
        // Dismissing is the safe direction: it discards, it does not save.
        await dialog.dismiss().catch(() => {});
    };

    page.on("dialog", dialogHandler);

    try {
        // ---- Find Cancel. Tag-agnostic, role LAST. -------------------------
        //
        // CRC renders href-less <a> controls that carry NO ARIA role, so a
        // role-based query silently returns zero matches. That is what made the
        // X unreachable: we led with getByRole and matched nothing, then reported
        // that the modal "refused to close" when we had never touched it.
        const candidates = [
            { name: "exact text (any tag)", locator: () => modal.locator(`:is(button, a, input, span, div):text-is("${CANCEL_LABEL}")`).first() },
            { name: "input[value=Cancel]", locator: () => modal.locator(`input[value="${CANCEL_LABEL}" i]`).first() },
            { name: "class-based", locator: () => modal.locator('.btn-cancel, .cancel, [data-dismiss="modal"]').first() },
            { name: "contains text (any tag)", locator: () => modal.locator(`:is(button, a, input):has-text("${CANCEL_LABEL}")`).first() },
            { name: "role=button (last resort)", locator: () => modal.getByRole("button", { name: /^cancel$/i }).first() },
        ];

        const attempts = [];
        let clicked = false;

        for (const candidate of candidates) {
            let count = 0;

            try {
                count = await candidate.locator().count();
            } catch (error) {
                attempts.push({ candidate: candidate.name, matched: null, error: error.message });
                continue;
            }

            attempts.push({ candidate: candidate.name, matched: count });

            if (count === 0) continue;

            try {
                await candidate.locator().click({ timeout: FIELD_TIMEOUT });
                console.log(`Clicked Cancel via: ${candidate.name}`);
                clicked = true;
                break;
            } catch (error) {
                attempts[attempts.length - 1].clickError = error.message;
            }
        }

        if (!clicked) {
            return {
                ok: false,
                error_code: "CANCEL_CONTROL_NOT_FOUND",
                error:
                    `No Cancel control could be found or clicked in the Edit Profile modal. Nothing ` +
                    `was clicked — this is a SELECTOR miss, not the modal refusing to close.`,
                attempts,
                modalHeaderHtml: await captureModalHtml(modal),
            };
        }

        // Give a prompt, if there is one, a moment to appear.
        await page.waitForTimeout(1000);

        // ---- A NATIVE unsaved-changes dialog -> PROCESSOR FAILURE ----------
        if (dialogs.length > 0) {
            return {
                ok: false,
                error_code: "UNSAVED_CHANGES_PROMPT",
                error:
                    `PROCESSOR FAILURE: clicking Cancel produced a dialog — "${dialogs[0].message}". ` +
                    `This module is READ ONLY. It filled nothing, selected nothing, and typed nothing, ` +
                    `so the form MUST be clean and Cancel must not ask about unsaved changes. That it ` +
                    `did means A FIELD WAS MODIFIED on the form holding the consumer's legal identity. ` +
                    `The dialog was dismissed (discard, never save), but the run FAILS and requires ` +
                    `immediate human review of this client's record.`,
                dialogs,
                attempts,
                requiresHumanReview: true,
            };
        }

        // ---- An IN-PAGE unsaved-changes prompt -> same failure -------------
        //
        // CRC may render its own confirm rather than a native one, in which case
        // no dialog event fires at all and the check above would pass happily.
        const inPagePrompt = await findUnsavedChangesPrompt(page);

        if (inPagePrompt) {
            return {
                ok: false,
                error_code: "UNSAVED_CHANGES_PROMPT",
                error:
                    `PROCESSOR FAILURE: clicking Cancel produced an in-page unsaved-changes prompt ` +
                    `("${inPagePrompt}"). READ MODE modifies nothing, so the form must be clean. A ` +
                    `field WAS modified. Immediate human review required.`,
                inPagePrompt,
                attempts,
                requiresHumanReview: true,
            };
        }

        // ---- VERIFY 1: the modal is gone ----------------------------------
        const modalGone = await waitFor(page, async () => !(await findModal(page)), 8000);

        if (!modalGone) {
            return {
                ok: false,
                error_code: "MODAL_STILL_VISIBLE",
                error:
                    `Cancel was clicked, but the Edit Profile modal is still visible. No unsaved-changes ` +
                    `prompt was detected, so the click landed on something that did not dismiss it.`,
                attempts,
                modalHeaderHtml: await captureModalHtml(modal),
            };
        }

        // ---- VERIFY 2: we are back on a WORKING dashboard ------------------
        //
        // The modal being gone is not the same as the dashboard being usable. This
        // is a POSITIVE check: an absence check alone would pass on a blank page,
        // an error screen, or a navigation we never intended.
        const linkBack = await waitFor(
            page,
            async () => (await page.getByText(PROFILE_LINK_TEXT, { exact: false }).first().count()) > 0,
            8000
        );

        if (!linkBack) {
            return {
                ok: false,
                error_code: "DASHBOARD_NOT_RESTORED",
                error:
                    `The Edit Profile modal closed, but the "${PROFILE_LINK_TEXT}" link is not visible ` +
                    `on the dashboard. The modal disappearing is not proof the dashboard is intact — we ` +
                    `may be on an error page, a spinner, or a navigation we did not intend. Processing ` +
                    `does not continue from a page we cannot confirm.`,
                attempts,
                currentUrl: page.url(),
            };
        }

        console.log("Edit Profile modal cancelled. Dashboard restored.");

        return { ok: true, attempts, dialogs: [] };

    } finally {
        // Always detach. A leaked listener would silently swallow dialogs raised
        // by a LATER milestone in the same session.
        page.off("dialog", dialogHandler);
    }
}

/** Poll a condition. Returns true if it became true within the timeout. */
async function waitFor(page, condition, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await condition().catch(() => false)) return true;
        await page.waitForTimeout(200);
    }

    return false;
}

/** Look for an in-page (non-native) unsaved-changes prompt. */
async function findUnsavedChangesPrompt(page) {
    for (const frame of page.frames()) {
        try {
            const prompt = frame.getByText(UNSAVED_CHANGES_PATTERN).first();

            if (await prompt.count()) {
                return (await prompt.textContent())?.trim().slice(0, 200) ?? "(unreadable)";
            }
        } catch {
            // detached frame
        }
    }

    return null;
}

/**
 * Capture the modal markup on failure, so a selector is written against real
 * evidence rather than another guess. Read-only: reads outerHTML, touches nothing.
 */
async function captureModalHtml(modal) {
    for (const selector of [".modal-footer", ".modal-content", "[role='dialog']", ".modal"]) {
        try {
            const el = modal.locator(selector).first();

            if (await el.count()) {
                const html = await el.evaluate((node) => node.outerHTML.slice(0, 2000));
                return { selector, html };
            }
        } catch {
            // try the next container
        }
    }

    return { selector: null, html: "(could not locate a modal container to capture)" };
}

export { FIELD_LABELS, REQUIRED_FIELDS };
