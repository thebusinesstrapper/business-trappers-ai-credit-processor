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

const EXACT_SUCCESS_TEXT = "Your message was sent";
const COMPOSE_RENDER_TIMEOUT_MS = 15000;
const COMPOSE_POLL_MS = 300;
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

    const secureBtn = page
        .getByRole("button", { name: "Send Secure Message", exact: true })
        .or(page.getByText("Send Secure Message", { exact: true }))
        .first();

    const found = (await secureBtn.count()) > 0 && await secureBtn.isVisible().catch(() => false);

    if (!found) {
        return { ok: false, reason: "send_secure_message_button_not_found" };
    }

    await secureBtn.click({ timeout: FIELD_TIMEOUT }).catch(() => {});

    const readState = async () => {
        const client = page.locator('input[name="client_id"]').first();
        const subject = page.locator('input[name="subject"]').first();
        const body = page
            .locator('div.fr-element.fr-view[contenteditable="true"]')
            .or(page.locator("textarea"))
            .first();
        const submit = page.getByRole("button", { name: "Submit", exact: true }).first();

        const hasClient = (await client.count()) > 0 && await client.isVisible().catch(() => false);
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

    const deadline = Date.now() + COMPOSE_RENDER_TIMEOUT_MS;
    let state = await readState();

    while (!state.ok && Date.now() < deadline) {
        await page.waitForTimeout(COMPOSE_POLL_MS);
        state = await readState();
    }

    if (!state.ok) {
        return { ok: false, reason: "compose_form_not_confirmed", state };
    }

    return { ok: true };
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
 * Verify the prefilled recipient by NORMALIZED EXACT EQUALITY.
 *
 * The live compose DOM proved input[name="client_id"].value holds the visible
 * display name (e.g. "Debra Brown"), not a numeric id — so that IS the correct
 * name-bearing field to read.
 *
 * FAIL-CLOSED AND EXACT. The normalized recipient must EQUAL the normalized
 * expected full name. No includes(), no startsWith(), no first-name match. A
 * partial or extra-token name ("Debra Ann Brown", "Debra Brown Jr") does not
 * verify, so a message can never go to the wrong or an ambiguous recipient.
 */
async function verifyRecipient(page, clientName) {
    const combo = page.locator('input[name="client_id"]').first();

    if (!(await combo.count())) {
        return { ok: false, reason: "client_field_not_found" };
    }

    const prefilled =
        (await combo.inputValue().catch(() => "")) ||
        (await page
            .evaluate(() => {
                const el = document.querySelector('input[name="client_id"]');
                return el ? el.value || "" : "";
            })
            .catch(() => "")) ||
        "";

    if (normalizeName(prefilled) === normalizeName(clientName)) {
        return { ok: true, recipient: clientName, viaPrefill: true };
    }

    // observedLength only — never the raw recipient text, which is client PII.
    return { ok: false, reason: "recipient_prefill_mismatch", observedLength: prefilled.length };
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
    const { clientName, crcClientId, subject, body, submitApproved } = opts;

    const report = {
        tool: CLIENT_NOTICE_VERSION,
        clientName: clientName ?? null,
        crcClientId: crcClientId ?? null,
        subject: subject ?? null,
        // Structural attestations. This module has no upload code at all.
        attachmentsUploaded: 0,
        attachmentPathExists: false,
        composerOpened: false,
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
        report.failureReason = `Could not open the secure-message composer (${opened.reason}).`;
        return report;
    }

    report.composerOpened = true;

    const recipient = await verifyRecipient(page, clientName);

    if (!recipient.ok) {
        report.failedStage = "recipient";
        report.failureReason =
            `The prefilled recipient did not verify as ${clientName} (${recipient.reason}). ` +
            `Nothing was sent.`;
        return report;
    }

    report.recipientVerified = true;

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
