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
 *   5. Close the modal using the X in the upper-right.
 *   6. Return to the dashboard.
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

import { IDENTITY_SOURCE } from "./intelligence/clientIdentity.js";

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

    console.log("Edit Profile modal is visible. Reading identity fields...");

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
    const closed = await closeModal(page, modal);

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
            error_code: "MODAL_NOT_CLOSED",
            error:
                `The Edit Profile modal did not close (${closed.error}). This is a FAILED NAVIGATION. ` +
                `The processor does not continue with the modal open — every later click in this ` +
                `session would land on the backdrop and fail far from the real cause. ` +
                `NOTE: this was a READ-ONLY pass and NO field was modified, so nothing should be ` +
                `holding this modal open. If an unsaved-changes prompt is blocking it, a field WAS ` +
                `changed, and that requires immediate human review.`,
            identityRead: identity, // diagnostic only
            identity: null,
            modalClosed: false,
            requiresHumanReview: true,
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
 * Close the modal with the X in the upper-right, per the frozen navigation.
 *
 * We do NOT press Escape and we do NOT click a backdrop. Both are guesses about
 * how the modal behaves, and on a form full of live fields a stray interaction
 * is the last thing we want. The X is the control the ruling names.
 */
async function closeModal(page, modal, attempt = 1) {
    const MAX_ATTEMPTS = 2;

    const candidates = [
        () => modal.getByRole("button", { name: /close/i }).first(),
        () => modal.locator('[aria-label="Close" i]').first(),
        () => modal.locator("button.close, .modal-header .close, .modal-header button").first(),
        () => modal.locator('button:has-text("×"), button:has-text("✕"), button:has-text("X")').first(),
    ];

    for (const candidate of candidates) {
        try {
            const locator = candidate();

            if (await locator.count()) {
                await locator.click({ timeout: FIELD_TIMEOUT });

                // Confirm it actually closed rather than assuming the click landed.
                const deadline = Date.now() + 5000;

                while (Date.now() < deadline) {
                    if (!(await findModal(page))) {
                        console.log("Edit Profile modal closed.");
                        return { ok: true };
                    }

                    await page.waitForTimeout(200);
                }
            }
        } catch {
            // try the next candidate
        }
    }

    // One retry. A single missed click should not fail a run; a modal that
    // refuses twice is a real problem.
    if (attempt < MAX_ATTEMPTS) {
        console.log(`Modal still open — retrying close (${attempt + 1}/${MAX_ATTEMPTS})...`);
        await page.waitForTimeout(1000);

        const stillOpen = await findModal(page);
        if (!stillOpen) return { ok: true };

        return closeModal(page, stillOpen, attempt + 1);
    }

    return { ok: false, error: `no close control worked after ${MAX_ATTEMPTS} attempts` };
}

export { FIELD_LABELS, REQUIRED_FIELDS };
