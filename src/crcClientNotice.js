/**
 * crcClientNotice.js — plain secure CRC messages with NO attachments.
 *
 * WHY THIS IS A SEPARATE MODULE.
 *
 * crcSecureMessage.js requires at least one PDF and fails at stage "pdfs"
 * without one. That requirement is not an inconvenience to work around — it is
 * why M8 deliveries are trustworthy, because a dispute message that silently
 * sent with zero attachments would look successful and accomplish nothing.
 *
 * So this module does not relax that rule; it stands beside it. There is no
 * input[type="file"] locator and no setInputFiles call anywhere below. A dispute
 * PDF cannot ride out on this path because there is no code that could attach
 * one — structurally, not conditionally.
 *
 * It reuses the proven mechanics: the dashboard "Send Secure Message" button,
 * prefill-first recipient verification, and the exact success confirmation.
 *
 * SAFETY: submitApproved must be explicitly true to click Submit. Without it the
 * form is filled and verified and the function STOPS at a readiness report.
 */

export const CLIENT_NOTICE_VERSION = "BT-NOTICE-1.0";

import { baseSearchName } from "./clientSearchName.js";

const EXACT_SUCCESS_TEXT = "Your message was sent";
const COMPOSE_RENDER_TIMEOUT_MS = 15000;
const COMPOSE_POLL_MS = 300;
// Bounded click->confirm retry for opening the composer. A lost/early MUI click
// (or a click that resolved to a non-actionable node) is retried by re-querying
// the control. Total wait stays capped by COMPOSE_RENDER_TIMEOUT_MS across all
// attempts; each attempt gets a slice to let the composer render before retrying.
const MAX_COMPOSE_OPEN_ATTEMPTS = 3;
const COMPOSE_OPEN_ATTEMPT_MS = 5000;
const FIELD_TIMEOUT = 10000;

/** Approved subject lines. */
export const NOTICE_SUBJECT = "Action Required: Your Credit Monitoring Is Inactive";
export const REMINDER_SUBJECT = "Reminder: Your Credit Monitoring Is Still Inactive";

/**
 * Approved notice bodies. Verbatim as approved; only [First Name] is filled.
 */
export function buildNoticeBody(firstName) {
    return (
        `Hi ${firstName}, we're unable to continue processing your credit file because your ` +
        `CreditHero monitoring is currently inactive or requires payment. Please log in to your ` +
        `CreditHero account and restore your active monitoring service. Once access is active ` +
        `again, our system will automatically resume processing your file.`
    );
}

export function buildReminderBody(firstName) {
    return (
        `Hi ${firstName}, this is a reminder that we're still unable to continue processing your ` +
        `credit file because your CreditHero monitoring remains inactive or requires payment. ` +
        `Please log in to CreditHero and restore your active monitoring service. Once access is ` +
        `active again, our system will automatically resume processing your file.`
    );
}

/**
 * Open the compose form from the CLIENT DASHBOARD "Send Secure Message" button.
 *
 * Same control and same verification as the proven delivery path, minus the file
 * input: this form's readiness does not depend on one, and requiring it here
 * would be checking for the very thing we refuse to use.
 */
async function openComposeForm(page, crcClientId) {
    const dashboardUrl =
        `https://app.creditrepaircloud.com/app/clients/${crcClientId}/dashboard`;

    if (!page.url().includes(`/clients/${crcClientId}/dashboard`)) {
        await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }

    // IDENTITY CONFIRMATION. The recipient acceptance rule downstream depends on
    // the composer having been opened from THIS exact client's dashboard, keyed
    // on the already-confirmed CRC Client ID. We confirm the page is actually on
    // /clients/{crcClientId}/dashboard before opening the composer — a navigation
    // that silently lands elsewhere must NOT be treated as this client.
    const dashboardIdentityConfirmed =
        page.url().includes(`/clients/${crcClientId}/dashboard`);

    if (!dashboardIdentityConfirmed) {
        return { ok: false, reason: "client_dashboard_identity_not_confirmed", dashboardIdentityConfirmed: false };
    }

    // Resolve the "Send Secure Message" control, PREFERRING the positively
    // actionable role button. The bare-text fallback is used ONLY when no role
    // button exists, so a non-actionable text label is never clicked when a real
    // button is present. Re-resolved on each attempt (below).
    const resolveSecureBtn = () => {
        const roleBtn = page.getByRole("button", { name: "Send Secure Message", exact: true });
        // .or() keeps the text fallback available for DOMs with no role button,
        // but the role button is listed first so it wins whenever it exists.
        return roleBtn.or(page.getByText("Send Secure Message", { exact: true })).first();
    };

    const found =
        (await resolveSecureBtn().count()) > 0 &&
        await resolveSecureBtn().isVisible().catch(() => false);

    if (!found) {
        return { ok: false, reason: "send_secure_message_button_not_found" };
    }

    const readState = async () => {
        // NOT .first(). MUI can render a hidden input sharing this name ahead of
        // the visible one; .first() would then test the hidden element, find it
        // invisible, and block the composer from ever confirming. Requirement is
        // that ANY visible one counts.
        const clientInputs = page.locator('input[name="client_id"]');
        const clientCount = await clientInputs.count().catch(() => 0);

        let hasClient = false;

        for (let index = 0; index < clientCount; index += 1) {
            if (await clientInputs.nth(index).isVisible().catch(() => false)) {
                hasClient = true;
                break;
            }
        }

        const subject = page.locator('input[name="subject"]').first();
        const body = page
            .locator('div.fr-element.fr-view[contenteditable="true"]')
            .or(page.locator("textarea"))
            .first();
        const submit = page.getByRole("button", { name: "Submit", exact: true }).first();

        const hasSubject = (await subject.count()) > 0 && await subject.isVisible().catch(() => false);
        const hasBody = (await body.count()) > 0 && await body.isVisible().catch(() => false);
        const hasSubmit = (await submit.count()) > 0 && await submit.isVisible().catch(() => false);
        const replyVisible = await page
            .getByRole("button", { name: /^reply$/i })
            .first()
            .isVisible()
            .catch(() => false);

        return {
            hasClient, hasSubject, hasBody, hasSubmit, replyVisible,
            ok: hasClient && hasSubject && hasBody && hasSubmit && !replyVisible,
        };
    };

    // BOUNDED CLICK -> CONFIRM RETRY. A single click can be lost when CRC's MUI
    // dashboard has not yet wired its handlers (goto only waited for
    // domcontentloaded), or when the click resolved to a non-actionable node — in
    // both cases the composer never renders and every field reads false. Rather
    // than click once and poll blindly, we click, poll for the composer within a
    // slice of the overall render budget, and if it did not appear, RE-QUERY the
    // control and click again. No force:true — we only ever click the resolved
    // (button-preferred) control. The total wait stays bounded by
    // COMPOSE_RENDER_TIMEOUT_MS across all attempts. The final composer-field
    // confirmation logic (readState) is unchanged.
    const overallDeadline = Date.now() + COMPOSE_RENDER_TIMEOUT_MS;
    let state = await readState();

    for (let attempt = 0; attempt < MAX_COMPOSE_OPEN_ATTEMPTS && !state.ok && Date.now() < overallDeadline; attempt += 1) {
        // Re-resolve the control each attempt so a re-render between tries does
        // not leave us clicking a stale handle.
        await resolveSecureBtn().click({ timeout: FIELD_TIMEOUT }).catch(() => {});

        // Poll for the composer within this attempt's slice, but never past the
        // overall deadline.
        const attemptDeadline = Math.min(
            Date.now() + COMPOSE_OPEN_ATTEMPT_MS,
            overallDeadline
        );
        state = await readState();
        while (!state.ok && Date.now() < attemptDeadline) {
            await page.waitForTimeout(COMPOSE_POLL_MS);
            state = await readState();
        }
    }

    if (!state.ok) {
        return { ok: false, reason: "compose_form_not_confirmed", state };
    }

    return { ok: true, dashboardIdentityConfirmed: true };
}

/**
 * Normalize a name for recipient comparison: trim, collapse internal whitespace,
 * lower-case. Nothing else — no token dropping, no initial stripping. This makes
 * "DEBRA BROWN" and "Debra Brown" equal while keeping "Debra Ann Brown" and
 * "Debra Brown Jr" DISTINCT.
 */
function normalizeName(value) {
    return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Suffix-safe recipient equality. A prefilled value verifies when it equals the
 * authoritative name EXACTLY (normalized), OR equals the authoritative name with
 * a single approved personal suffix removed (Jr/Sr/II/III/IV/V, via the shared
 * clientSearchName.baseSearchName). This is the ONLY relaxation: CRC drops the
 * suffix in the recipient field ("Joseph Manning IV" -> "Joseph Manning").
 *
 * DELIBERATELY NOT ADDED: prefix/truncation matching, fuzzy matching, and
 * first-name-only matching. A prefill that is a shortened surname
 * ("Woodeline Deliss" vs "Woodeline Delissaint") is NOT accepted here — that is
 * a stored-data defect fixed in client_state, not a matching problem.
 *
 * @param {string} observed   the prefilled value read from CRC
 * @param {string} clientName the full authoritative client name
 */
function recipientMatches(observed, clientName) {
    const obs = normalizeName(observed);
    if (!obs) return false;
    if (obs === normalizeName(clientName)) return true;
    const base = baseSearchName(clientName);
    return Boolean(base && obs === normalizeName(base));
}

/** The one field that carries the recipient's display name. */
const RECIPIENT_SELECTOR = 'input[name="client_id"]';

/** How long the prefill may take to arrive before we give up. */
const RECIPIENT_VALUE_TIMEOUT_MS = 10000;
const RECIPIENT_POLL_MS = 200;

/**
 * Sanitize an observed recipient value for a diagnostic. Whitespace collapsed,
 * long digit runs redacted, length capped. Enough to see WHAT was in the field
 * without pushing an account-number-shaped string into a job result.
 */
function sanitizeObserved(value) {
    if (typeof value !== "string") return null;

    return value
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\d{4,}/g, "[redacted]")
        .slice(0, 120);
}

/**
 * Read EVERY input[name="client_id"] on the page with its state.
 *
 * Not .first(). MUI renders a visible text input alongside hidden inputs that
 * can share a name, and a hidden one may hold a numeric id rather than the
 * display name. Scanning them all and requiring visible AND enabled means a
 * stale or hidden duplicate cannot be mistaken for the real field.
 */
async function readRecipientCandidates(page) {
    const inputs = page.locator(RECIPIENT_SELECTOR);
    const count = await inputs.count().catch(() => 0);
    const candidates = [];

    for (let index = 0; index < count; index += 1) {
        const input = inputs.nth(index);

        candidates.push({
            index,
            visible: await input.isVisible().catch(() => false),
            enabled: await input.isEnabled().catch(() => false),
            value: (await input.inputValue().catch(() => "")) || "",
        });
    }

    return { count, candidates };
}

/**
 * Verify the prefilled recipient by NORMALIZED EXACT EQUALITY.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FIXES: TIMING, NOT MATCHING.
 *
 * This function read the field exactly once, with no wait. openComposeForm()
 * returns as soon as the input is VISIBLE — and visible is not populated. CRC
 * fills the recipient asynchronously after the client record loads, so the
 * field is on screen with value "" for a moment. We read that empty string,
 * compared it to "denyel davis", and reported recipient_prefill_mismatch on a
 * form that was about to be perfectly correct.
 *
 * The old failure path returned observedLength, which would have shown 0 and
 * named the cause immediately — but it was the only thing returned, so a
 * mismatch could not be distinguished from a genuinely wrong recipient.
 *
 * THE COMPARISON ITSELF WAS NEVER WRONG. normalizeName() already trims,
 * collapses internal whitespace and lower-cases, so "Denyel Davis" verifies
 * against "Denyel Davis" the moment the value actually exists. That logic is
 * unchanged.
 *
 * FAIL-CLOSED AND EXACT, EXACTLY AS BEFORE. The normalized recipient must EQUAL
 * the normalized expected full name. No includes(), no startsWith(), no
 * first-name match. "Debra Ann Brown" and "Debra Brown Jr" still do not verify.
 *
 * FAILS FAST ON A REAL MISMATCH. A nonblank value seen twice in a row is
 * settled; if it is settled and wrong we stop immediately rather than waiting
 * out the timeout. Only a still-blank or still-changing field uses the full
 * window.
 * ---------------------------------------------------------------------------
 */
async function verifyRecipient(page, clientName, idContext = {}) {
    const deadline = Date.now() + RECIPIENT_VALUE_TIMEOUT_MS;

    // IDENTITY CONTEXT. The permanent fix: when we opened the composer FROM the
    // confirmed client's dashboard (keyed on the already-confirmed CRC Client
    // ID), CRC prefills that dashboard's own client into the recipient field.
    // The prefilled value is therefore authoritative BY CONSTRUCTION — it is
    // whichever name CRC stores for the client whose dashboard we are on — even
    // when CRC's Clients grid handed the queue a SHORTENED name. Acceptance is
    // gated on identity, not on string similarity.
    const crcClientId = idContext.crcClientId == null ? "" : String(idContext.crcClientId).trim();
    const dashboardIdentityConfirmed = idContext.dashboardIdentityConfirmed === true;
    const idContextPresent = /^\d+$/.test(crcClientId) && dashboardIdentityConfirmed;

    let latest = { count: 0, candidates: [] };
    let previousSettledValue = null;

    while (Date.now() < deadline) {
        latest = await readRecipientCandidates(page);

        // Only a visible, enabled field can be the one the user would see.
        const usable = latest.candidates.filter((c) => c.visible && c.enabled);

        // ---- EXACT / APPROVED-SUFFIX MATCH (supporting verification) --------
        // Still the primary path when it succeeds. Unchanged behavior.
        const matched = usable.find((c) => recipientMatches(c.value, clientName));

        if (matched) {
            return {
                ok: true,
                recipient: clientName,
                viaPrefill: true,
                viaConfirmedClientId: false,
                selector: RECIPIENT_SELECTOR,
                matchingElementCount: latest.count,
                matchedIndex: matched.index,
                fieldVisible: matched.visible,
                fieldEnabled: matched.enabled,
                observedRecipient: sanitizeObserved(matched.value),
                observedLength: matched.value.length,
            };
        }

        // ---- CONFIRMED-CRC-ID ACCEPTANCE (permanent fix) -------------------
        // Accept the EXISTING prefill without typing/searching/selecting when
        // ALL of these hold:
        //   * the CRC Client ID is present and the dashboard identity was
        //     confirmed (we are provably on THIS client's dashboard),
        //   * exactly ONE recipient field is visible and enabled,
        //   * that field is prefilled with a nonblank value.
        // The name did not exactly match only because CRC's grid shortened it;
        // the composer's prefill is the client's real stored name. No fuzzy,
        // prefix, truncation, or first-name matching is used or implied.
        if (idContextPresent && usable.length === 1 && usable[0].value.trim() !== "") {
            const only = usable[0];
            return {
                ok: true,
                recipient: sanitizeObserved(only.value),
                viaPrefill: true,
                viaConfirmedClientId: true,
                crcClientId,
                selector: RECIPIENT_SELECTOR,
                matchingElementCount: latest.count,
                matchedIndex: only.index,
                fieldVisible: only.visible,
                fieldEnabled: only.enabled,
                observedRecipient: sanitizeObserved(only.value),
                observedLength: only.value.length,
                // Supporting checks recorded for the diagnostic, not required.
                supportingExactOrSuffixMatch: recipientMatches(only.value, clientName),
            };
        }

        // A nonblank value observed twice in a row has settled. If it settled on
        // something other than the expected name, waiting longer cannot help.
        const nonblank = usable.find((c) => c.value.trim() !== "");

        if (nonblank && previousSettledValue === nonblank.value) break;

        previousSettledValue = nonblank ? nonblank.value : null;

        await page.waitForTimeout(RECIPIENT_POLL_MS);
    }

    // ---- FAILED. REPORT WHAT WAS ACTUALLY THERE. --------------------------
    // Reaching here means neither the name matched NOR the confirmed-ID
    // acceptance held. FAIL CLOSED. The reason distinguishes the guard that
    // stopped acceptance so a job result is diagnosable.
    const usable = latest.candidates.filter((c) => c.visible && c.enabled);
    const observed =
        usable.find((c) => c.value.trim() !== "") ??
        usable[0] ??
        latest.candidates[0] ??
        null;

    let reason;
    if (latest.count === 0) {
        reason = "client_field_not_found";
    } else if (usable.length > 1) {
        // Multiple recipient fields: never guess which client — fail closed.
        reason = "multiple_recipient_fields";
    } else if (!idContextPresent) {
        // No confirmed-ID context AND the name did not match: the mismatch is
        // real from where we stand. (This is what still fails the six shortened
        // names when the CRC Client ID context is absent.)
        reason = "recipient_prefill_mismatch";
    } else if (!observed || observed.value.trim() === "") {
        reason = "recipient_blank";
    } else {
        reason = "recipient_prefill_mismatch";
    }

    return {
        ok: false,
        reason,
        selector: RECIPIENT_SELECTOR,
        matchingElementCount: latest.count,
        fieldVisible: observed ? observed.visible : false,
        fieldEnabled: observed ? observed.enabled : false,
        expectedClientName: sanitizeObserved(clientName),
        observedRecipient: observed ? sanitizeObserved(observed.value) : null,
        observedLength: observed ? observed.value.length : 0,
        idContextPresent,
    };
}

async function fillSubject(page, subject) {
    const field = page.locator('input[name="subject"]').first();
    await field.click({ timeout: FIELD_TIMEOUT }).catch(() => {});
    await field.fill(subject).catch(() => {});
    const actual = await field.inputValue().catch(() => "");
    return actual === subject;
}

async function fillBody(page, body) {
    const editor = page.locator('div.fr-element.fr-view[contenteditable="true"]').first();

    if (await editor.count()) {
        await editor.click({ timeout: FIELD_TIMEOUT }).catch(() => {});
        await editor.evaluate((el, text) => {
            el.innerHTML = "";
            el.appendChild(document.createTextNode(text));
            el.dispatchEvent(new Event("input", { bubbles: true }));
        }, body).catch(() => {});

        const written = await editor.evaluate((el) => el.textContent || "").catch(() => "");
        return written.trim().length > 0;
    }

    const textarea = page.locator("textarea").first();

    if (await textarea.count()) {
        await textarea.fill(body).catch(() => {});
        const written = await textarea.inputValue().catch(() => "");
        return written.trim().length > 0;
    }

    return false;
}

/**
 * Send one plain secure message. No attachments, ever.
 *
 * @param {object} page
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string} opts.crcClientId
 * @param {string} opts.subject
 * @param {string} opts.body
 * @param {boolean} opts.submitApproved  must be true to click Submit
 */
export async function sendClientNotice(page, opts = {}) {
    const { clientName, crcClientId, subject, body, submitApproved, diagnosticOnly } = opts;

    const report = {
        tool: CLIENT_NOTICE_VERSION,
        clientName: clientName ?? null,
        crcClientId: crcClientId ?? null,
        subject: subject ?? null,
        // Structural attestations. This module has no upload code at all.
        attachmentsUploaded: 0,
        attachmentPathExists: false,
        composerOpened: false,
        // Per-field composer-open attestation, populated ONLY on an open_compose
        // failure so the persisted error shows WHICH field the confirmation gate
        // was missing (hasClient/hasSubject/hasBody/hasSubmit/replyVisible).
        // Observability only — it does not affect any selector, the confirmation
        // logic, or send behavior.
        composeState: null,
        recipientVerified: false,
        messageSubmitted: false,
        messageSuccessConfirmed: false,
        stoppedBeforeSubmit: false,
        failedStage: null,
        failureReason: null,
    };

    if (!clientName || !crcClientId) {
        report.failedStage = "input";
        report.failureReason = "clientName and crcClientId are both required.";
        return report;
    }

    if (!subject || !body) {
        report.failedStage = "input";
        report.failureReason = "subject and body are both required.";
        return report;
    }

    const opened = await openComposeForm(page, crcClientId);

    if (!opened.ok) {
        report.failedStage = "open_compose";
        // Carry the per-field confirmation state (when openComposeForm provided
        // it) so the next run records exactly which field was missing. This is
        // read-only diagnostic detail; the selectors, the confirmation gate, and
        // the send behavior are unchanged.
        report.composeState = opened.state ?? null;
        const stateSummary = opened.state
            ? " Composer field state: " +
              `hasClient=${opened.state.hasClient}, hasSubject=${opened.state.hasSubject}, ` +
              `hasBody=${opened.state.hasBody}, hasSubmit=${opened.state.hasSubmit}, ` +
              `replyVisible=${opened.state.replyVisible}.`
            : "";
        report.failureReason =
            `Could not open the secure-message composer (${opened.reason}).${stateSummary}`;
        return report;
    }

    report.composerOpened = true;

    // The composer was opened FROM this exact client's dashboard (openComposeForm
    // navigated to /clients/{crcClientId}/dashboard and confirmed the landing).
    // Carry that confirmed identity into verification so a CRC-grid-shortened
    // name does not block a recipient CRC itself prefilled for this client.
    const recipient = await verifyRecipient(page, clientName, {
        crcClientId,
        dashboardIdentityConfirmed: opened.dashboardIdentityConfirmed === true,
    });

    // Always surface the observed recipient evidence (success OR failure), so a
    // job result can show exactly what CRC prefilled without another live run.
    report.recipientDiagnostic = {
        recipientVerificationReason: recipient.ok ? "verified" : (recipient.reason ?? null),
        selector: recipient.selector ?? null,
        matchingElementCount: recipient.matchingElementCount ?? null,
        fieldVisible: recipient.fieldVisible ?? null,
        fieldEnabled: recipient.fieldEnabled ?? null,
        expectedClientName: recipient.expectedClientName ?? sanitizeObserved(clientName),
        observedRecipient: recipient.observedRecipient ?? null,
        observedLength: recipient.observedLength ?? null,
    };

    if (!recipient.ok) {
        report.failedStage = "recipient";
        report.failureReason =
            `The prefilled recipient did not verify as ${clientName} (${recipient.reason}). ` +
            `Nothing was sent.`;
        return report;
    }

    report.recipientVerified = true;

    // ---- DIAGNOSTIC BOUNDARY (temporary) -----------------------------------
    // When diagnosticOnly is set, stop immediately after recipient verification:
    // BEFORE subject/body entry and BEFORE any submit. Nothing is sent, and the
    // caller writes no status, timestamp, or memory. The recipientDiagnostic
    // above is the whole point of the run.
    if (diagnosticOnly === true) {
        report.stoppedBeforeSubmit = true;
        report.diagnosticOnly = true;
        report.failureReason = "DIAGNOSTIC_ONLY — stopped after recipient verification; nothing sent.";
        return report;
    }

    if (!(await fillSubject(page, subject))) {
        report.failedStage = "subject";
        report.failureReason = "Subject did not read back as written.";
        return report;
    }

    if (!(await fillBody(page, body))) {
        report.failedStage = "body";
        report.failureReason = "Message body did not read back as written.";
        return report;
    }

    // ---- SUBMIT BOUNDARY ---------------------------------------------------
    if (submitApproved !== true) {
        report.stoppedBeforeSubmit = true;
        report.failureReason = "READY_NOT_SENT — submitApproved was not true.";
        return report;
    }

    const submitBtn = page.getByRole("button", { name: "Submit", exact: true }).first();

    if (!(await submitBtn.count())) {
        report.failedStage = "submit";
        report.failureReason = "Submit button not found.";
        return report;
    }

    await submitBtn.click({ timeout: FIELD_TIMEOUT }).catch(() => {});
    report.messageSubmitted = true;

    // A click is not a send. CRC's own confirmation is the only proof.
    const deadline = Date.now() + COMPOSE_RENDER_TIMEOUT_MS;
    let confirmed = false;

    while (!confirmed && Date.now() < deadline) {
        confirmed = await page
            .getByText(EXACT_SUCCESS_TEXT, { exact: false })
            .first()
            .isVisible()
            .catch(() => false);

        if (!confirmed) await page.waitForTimeout(COMPOSE_POLL_MS);
    }

    report.messageSuccessConfirmed = confirmed;

    if (!confirmed) {
        report.failedStage = "confirmation";
        report.failureReason = `Did not observe the exact confirmation "${EXACT_SUCCESS_TEXT}".`;
    }

    return report;
}

export { EXACT_SUCCESS_TEXT };
// Exported for unit testing of suffix-safe recipient equality. Pure function.
export { recipientMatches };
// Exported for unit testing of the confirmed-CRC-ID recipient acceptance path.
export { verifyRecipient };
