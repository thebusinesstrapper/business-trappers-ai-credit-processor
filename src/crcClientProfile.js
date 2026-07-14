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

import { IDENTITY_SOURCE, normalizeIdentity } from "./intelligence/clientIdentity.js";

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
                `The Edit Profile modal did not close. ${closed.error} This is a FAILED NAVIGATION — ` +
                `the processor does not continue with the modal open, because every later click in ` +
                `this session would land on the backdrop and fail far from the real cause. ` +
                `See closeAttempts for what each candidate matched, and modalHeaderHtml for the real ` +
                `markup. NOTE: this was a READ-ONLY pass and NO field was modified. If — and only if — ` +
                `a close control WAS clicked and the modal still refused, an unsaved-changes prompt ` +
                `may be holding it open, which would mean a field was changed. If every candidate ` +
                `matched zero elements, nothing was clicked and this is a selector problem, not a ` +
                `modal problem.`,
            identityRead: identity, // diagnostic only

            // WHAT EACH CANDIDATE ACTUALLY FOUND. Without this, "the modal would
            // not close" is indistinguishable from "we never found anything to
            // click" — and those need completely different fixes.
            closeAttempts: closed.attempts ?? null,

            // The real markup, if every candidate missed. The next selector is
            // written against THIS, not against another guess.
            modalHeaderHtml: closed.modalHeaderHtml ?? null,

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

    // ---- CANDIDATES: TAG-AGNOSTIC, ROLE LAST ------------------------------
    //
    // The previous list led with getByRole("button") and then required a literal
    // <button> tag. It matched ZERO elements, clicked nothing, and reported
    // "modal would not close" — which read like the modal RESISTING, when in fact
    // we never touched it.
    //
    // openClient.js already documents why, and this module ignored it:
    //
    //   "An <a> only carries the ARIA 'link' role when it has an href. CRC
    //    renders [controls] as href-less <a>/<span> ... it looks and behaves like
    //    a link, but has no role, so every role-based query returns zero matches."
    //
    // A close X in this app is very likely an href-less <a>, <span>, or <i>. It
    // carries no role and is not a <button>. So we lead with TAG- and
    // TEXT-agnostic queries and keep the role-based one LAST, where it can only
    // help and never blind us.
    const candidates = [
        // 1. Anything carrying a close-ish class, ANY tag. Bootstrap/jQuery UI
        //    modals overwhelmingly use one of these.
        { name: "class-based (any tag)", locator: () => modal.locator('.modal-header .close, .modal-header .btn-close, a.close, span.close, .ui-dialog-titlebar-close, [class*="close" i]').first() },

        // 2. Explicit accessible label, ANY tag.
        { name: "aria-label", locator: () => modal.locator('[aria-label="Close" i], [title="Close" i]').first() },

        // 3. The glyph itself, ANY tag. Covers <a>×</a> and <span>✕</span>.
        { name: "close glyph (any tag)", locator: () => modal.locator(':is(a, span, i, div, button):text-matches("^\\s*[×✕✖xX]\\s*$")').first() },

        // 4. Role-based. LAST, deliberately: it only matches if CRC happens to
        //    give the control a real role, and leading with it is what blinded us.
        { name: "role=button (last resort)", locator: () => modal.getByRole("button", { name: /close/i }).first() },
    ];

    // Per-candidate diagnostics. The old code reported only "nothing worked",
    // which is indistinguishable from "never ran" and from "threw" — and that
    // ambiguity is exactly what sent us hunting for an execution-path bug that
    // did not exist.
    const attempts = [];

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
            console.log(`Clicked close control via: ${candidate.name}`);
        } catch (error) {
            attempts[attempts.length - 1].clickError = error.message;
            continue;
        }

        // Confirm it actually closed. A click landing is not a modal closing.
        const deadline = Date.now() + 5000;

        while (Date.now() < deadline) {
            if (!(await findModal(page))) {
                console.log("Edit Profile modal closed.");
                return { ok: true, via: candidate.name, attempts };
            }

            await page.waitForTimeout(200);
        }

        attempts[attempts.length - 1].clickedButStillOpen = true;
    }

    // One retry. A single missed click should not fail a run; a modal that
    // refuses twice is a real problem.
    if (attempt < MAX_ATTEMPTS) {
        console.log(`Modal still open — retrying close (${attempt + 1}/${MAX_ATTEMPTS})...`);
        await page.waitForTimeout(1000);

        const stillOpen = await findModal(page);
        if (!stillOpen) return { ok: true, via: "closed on its own", attempts };

        return closeModal(page, stillOpen, attempt + 1);
    }

    // ---- CAPTURE THE MARKUP SO THE NEXT RUN IS NOT ANOTHER GUESS -----------
    //
    // If every candidate matched zero elements, the X is shaped differently than
    // any of them expect. We do not guess again — we return the actual header
    // markup so the selector can be written against real evidence, exactly as
    // the Milestone 4 eligibility engine was.
    const headerHtml = await captureModalHeader(modal);

    const matchedNothing = attempts.every((a) => !a.matched);

    return {
        ok: false,
        error: matchedNothing
            ? `every close candidate matched ZERO elements — the X was never clicked because nothing ` +
              `was found to click. This is a SELECTOR miss, not the modal resisting.`
            : `a close control was found and clicked, but the modal stayed open.`,
        attempts,
        modalHeaderHtml: headerHtml,
    };
}

/**
 * Return the modal's header markup, so a failed close produces EVIDENCE rather
 * than another round of guessing at selectors.
 *
 * Read-only. Reads outerHTML. Touches nothing.
 */
async function captureModalHeader(modal) {
    const containers = [
        ".modal-header",
        ".ui-dialog-titlebar",
        ".modal-content",
        "[role='dialog']",
        ".modal",
    ];

    for (const selector of containers) {
        try {
            const el = modal.locator(selector).first();

            if (await el.count()) {
                const html = await el.evaluate((node) => node.outerHTML.slice(0, 1500));
                return { selector, html };
            }
        } catch {
            // try the next container
        }
    }

    return { selector: null, html: "(could not locate a modal container to capture)" };
}

export { FIELD_LABELS, REQUIRED_FIELDS };
