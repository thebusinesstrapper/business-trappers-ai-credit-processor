/**
 * crcSecureMessage.js — CRC secure-message delivery for M8 (Elizabeth Kelley test).
 *
 * Sends the M7 bureau-letter PDFs to a client via the client dashboard
 * "Send Secure Message" button (which opens compose with the client prefilled),
 * attaching each PDF separately, verifying every filename, and requiring the exact
 * success confirmation before reporting success. It NEVER prints/mails/submits to a
 * bureau, never uses the broken library-letter path, and treats a Submit click as
 * success ONLY when CRC shows "Your message was sent".
 *
 * SAFETY: submitApproved must be explicitly true to click Submit. Without it, the
 * function fills everything, verifies all attachments, and STOPS at a readiness
 * report (no send) — this is how the pre-authorization dry run works.
 *
 * Confirmed selectors (from BT-M8-MESSAGES-DISCOVERY-1.0):
 *   client selector : input[name="client_id"]  (MUI autocomplete, role=combobox)
 *   subject         : input[name="subject"]
 *   body            : div.fr-element.fr-view[contenteditable="true"]
 *   file input      : input[type="file"]  (hidden)
 *   Submit          : visible green button, exact text "Submit"
 */

export const SECURE_MESSAGE_VERSION = "BT-M8-SECURE-MESSAGE-1.0";

const AUTHORIZED_CLIENT_ID = "15";
const AUTHORIZED_CLIENT_NAME = "Elizabeth Kelley";

const SUBJECT_TEXT = "Your Credit Dispute Letters Are Ready";
const BODY_TEXT =
    "Your new credit dispute letters are attached to this secure message.\n\n" +
    "Please download each letter, review it carefully for accuracy, and submit it " +
    "to the corresponding credit bureau using the instructions provided by Business Trappers.\n\n" +
    "Keep a copy of each letter and any submission confirmation for your records.\n\n" +
    "If you have questions before submitting your letters, please contact the Business Trappers team.";

const EXACT_SUCCESS_TEXT = "Your message was sent";
const MAX_PDF_BYTES = 10 * 1024 * 1024;

// Small helper: structured failure at a named stage (never throws for expected
// validation failures — the orchestrator needs the stage + reason).
function fail(stage, reason, extra = {}) {
    return { ok: false, failedStage: stage, failureReason: reason, ...extra };
}

// Compose-render wait window (spinner after the dashboard "Send Secure Message" click).
const COMPOSE_RENDER_TIMEOUT_MS = 15000;
const COMPOSE_POLL_MS = 300;

async function openComposeForm(page, crcClientId) {
    // ---- DIAGNOSTIC-ONLY logging. ----
    const log = (...args) => console.log("[M8 openCompose]", ...args);
    const snap = async (name) => {
        try { await page.screenshot({ path: `/tmp/m8-compose-${name}.png`, fullPage: false });
            log(`screenshot saved: /tmp/m8-compose-${name}.png`); }
        catch (e) { log(`screenshot ${name} failed: ${e.message}`); }
    };

    // Requirement: open the secure-message compose flow from the CLIENT DASHBOARD
    // via the exact green "Send Secure Message" button — NOT the Messages tab, NOT
    // a FAB. The dashboard opens compose with the client already prefilled.

    // (1) Ensure we are on the client dashboard.
    const dashboardUrl = `https://app.creditrepaircloud.com/app/clients/${crcClientId}/dashboard`;
    if (!page.url().includes(`/clients/${crcClientId}/dashboard`)) {
        log("navigating to client dashboard:", dashboardUrl);
        await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    log("dashboard URL before click:", page.url());

    // (2/3) Locate the exact visible "Send Secure Message" button and click ONLY it.
    const secureBtn = page.getByRole("button", { name: "Send Secure Message", exact: true })
        .or(page.getByText("Send Secure Message", { exact: true })).first();
    const found = (await secureBtn.count()) > 0 && await secureBtn.isVisible().catch(() => false);
    log(`"Send Secure Message" button found & visible: ${found}`);
    if (!found) {
        await snap("no-send-secure-message");
        log("Exact 'Send Secure Message' dashboard button was not found/visible.");
        return false;
    }

    await snap("before-send-secure-message");
    await secureBtn.click({ timeout: 10000 }).catch((e) => { log(`click error: ${e.message}`); });
    log("clicked 'Send Secure Message'");
    await snap("after-send-secure-message");
    // (4) URL after click.
    log("URL after click:", page.url());

    // Read the FULL compose-form state, INCLUDING the prefilled client value.
    const readComposeState = async () => {
        const client = page.locator('input[name="client_id"]').first();
        const subject = page.locator('input[name="subject"]').first();
        const body = page.locator('div.fr-element.fr-view[contenteditable="true"]')
            .or(page.locator("textarea")).first();
        const fileInput = page.locator('input[type="file"]').first();
        const submit = page.getByRole("button", { name: "Submit", exact: true }).first();

        const hasClient = (await client.count()) > 0 && await client.isVisible().catch(() => false);
        const hasSubject = (await subject.count()) > 0 && await subject.isVisible().catch(() => false);
        const hasBody = (await body.count()) > 0 && await body.isVisible().catch(() => false);
        const hasFile = (await fileInput.count()) > 0; // hidden input: presence, not visibility
        const hasSubmit = (await submit.count()) > 0 && await submit.isVisible().catch(() => false);
        const replyVisible = await page.getByRole("button", { name: /^reply$/i })
            .first().isVisible().catch(() => false);

        return {
            hasClient, hasSubject, hasBody, hasFile, hasSubmit, replyVisible,
            ok: hasClient && hasSubject && hasBody && hasFile && hasSubmit && !replyVisible,
        };
    };

    // (5) Poll up to 15s for the async compose render (spinner).
    const deadline = Date.now() + COMPOSE_RENDER_TIMEOUT_MS;
    let state = await readComposeState();
    while (!state.ok && Date.now() < deadline) {
        await page.waitForTimeout(COMPOSE_POLL_MS);
        state = await readComposeState();
    }

    // (12) compose selector visibility.
    log("compose state:", JSON.stringify(state));
    if (!state.ok) {
        const missing = [];
        if (!state.hasClient) missing.push('input[name="client_id"]');
        if (!state.hasSubject) missing.push('input[name="subject"]');
        if (!state.hasBody) missing.push('.fr-element[contenteditable="true"]');
        if (!state.hasFile) missing.push('input[type="file"]');
        if (!state.hasSubmit) missing.push("exact visible Submit button");
        if (state.replyVisible) missing.push("REPLY MODE DETECTED (must be absent)");
        log(`compose form not confirmed — missing/blocking: ${missing.join(", ")}`);
        await snap("compose-not-confirmed");
        return false;
    }

    // (6/12) Detect the PREFILLED client value for verification downstream.
    const prefilled = await page.evaluate(() => {
        const el = document.querySelector('input[name="client_id"]');
        return el ? (el.value || "") : "";
    }).catch(() => "");
    log("detected prefilled client value:", JSON.stringify(prefilled));

    return true;
}

async function selectExactClient(page, clientName) {
    const combo = page.locator('input[name="client_id"]').first();
    if (!(await combo.count())) return fail("client_select", "Client combobox not found.");

    // PREFILL-FIRST: the dashboard "Send Secure Message" flow opens compose with
    // the client already prefilled. Verify that prefill and DO NOT reselect unless
    // it fails verification (requirement: do not clear/reselect a correct prefill).
    const prefilled = (await combo.inputValue().catch(() => "")) ||
        (await page.evaluate(() => {
            const el = document.querySelector('input[name="client_id"]');
            return el ? (el.value || "") : "";
        }).catch(() => "")) || "";
    console.log("[M8 client] prefilled client value:", JSON.stringify(prefilled));
    if (prefilled === clientName || prefilled.includes(clientName)) {
        console.log("[M8 client] prefilled client verified; not reselecting.");
        return { ok: true, selectedClient: clientName, resultingValue: prefilled, viaPrefill: true };
    }
    console.log("[M8 client] prefill did not match; falling back to type-and-select.");

    // Fallback ONLY if the prefill failed verification.
    await combo.click({ timeout: 8000 }).catch(() => {});
    await combo.fill("").catch(() => {});
    await combo.type(clientName, { delay: 25 }).catch(() => {});

    // Wait for filtered options; require exactly one exact match.
    let options = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        options = await page.getByRole("option").evaluateAll((nodes) =>
            nodes.map((n) => (n.textContent || "").replace(/\s+/g, " ").trim())
        ).catch(() => []);
        if (options.some((o) => o === clientName)) break;
        await page.waitForTimeout(250);
    }
    const exact = options.filter((o) => o === clientName);
    if (exact.length !== 1) {
        return fail("client_select",
            `Expected exactly one "${clientName}" option; found ${exact.length}.`,
            { optionsSample: options.slice(0, 10) });
    }
    // Click the exact option.
    await page.getByRole("option", { name: clientName, exact: true }).first()
        .click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);

    // Verify the resulting selected value equals the client name.
    const val = (await combo.inputValue().catch(() => "")) || "";
    const selectedText = await page.evaluate(() => {
        // MUI often shows the chosen value in the input or an adjacent chip.
        const el = document.querySelector('input[name="client_id"]');
        return el ? (el.value || "") : "";
    }).catch(() => "");
    const confirmed = val === clientName || selectedText === clientName ||
        val.includes(clientName) || selectedText.includes(clientName);
    if (!confirmed) {
        return fail("client_verify",
            `Selected client value "${val || selectedText}" does not equal "${clientName}".`);
    }
    return { ok: true, selectedClient: clientName, resultingValue: val || selectedText };
}

/** Fill subject via input[name="subject"] and confirm the value stuck. */
async function fillSubject(page, subject) {
    const f = page.locator('input[name="subject"]').first();
    if (!(await f.count())) return fail("subject", "Subject field not found.");
    await f.click({ timeout: 6000 }).catch(() => {});
    await f.fill("").catch(() => {});
    await f.type(subject, { delay: 10 }).catch(() => {});
    const val = (await f.inputValue().catch(() => "")) || "";
    if (val.trim() !== subject) return fail("subject", `Subject did not stick (got "${val}").`);
    return { ok: true };
}

/** Fill the Froala body editor and confirm it is nonempty. */
async function fillBody(page, body) {
    const editor = page.locator('div.fr-element.fr-view[contenteditable="true"]').first();
    if (!(await editor.count())) return fail("body", "Body editor not found.");
    await editor.click({ timeout: 6000 }).catch(() => {});
    // Set text content and dispatch input so Froala/React registers it.
    await editor.evaluate((el, text) => {
        el.innerHTML = "";
        const paras = text.split("\n\n").map((p) => {
            const d = document.createElement("p");
            d.textContent = p;
            return d;
        });
        for (const p of paras) el.appendChild(p);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
    }, body).catch(() => {});
    const text = (await editor.evaluate((el) => (el.textContent || "").trim()).catch(() => "")) || "";
    if (text.length < 10) return fail("body", "Body editor is empty after fill.");
    return { ok: true };
}

/**
 * Upload one PDF through the hidden input[type=file], then verify its exact
 * filename appears in the compose form. Each call handles ONE file.
 */
async function uploadOnePdf(page, pdf, tmpDir, fsMod, pathMod) {
    // Write the buffer to a temp path so setInputFiles can attach it.
    const filePath = pathMod.join(tmpDir, pdf.filename);
    fsMod.writeFileSync(filePath, Buffer.from(pdf.buffer));

    const fileInput = page.locator('input[type="file"]').first();
    if (!(await fileInput.count())) return fail("attach", "File input not found.", { bureau: pdf.bureau });
    await fileInput.setInputFiles(filePath).catch((e) => { throw e; });

    // Verify the filename appears in the compose form (bounded wait).
    const deadline = Date.now() + 8000;
    let seen = false;
    while (Date.now() < deadline) {
        seen = await page.getByText(pdf.filename, { exact: false }).first().isVisible().catch(() => false);
        if (seen) break;
        await page.waitForTimeout(250);
    }
    if (!seen) {
        return fail("attach_verify",
            `Uploaded ${pdf.filename} but its filename did not appear in the form.`,
            { bureau: pdf.bureau, filename: pdf.filename });
    }
    return { ok: true, filename: pdf.filename, bureau: pdf.bureau };
}

/**
 * Full secure-message delivery. Fills everything, uploads + verifies every PDF,
 * runs the pre-Submit hard checks, and — ONLY if submitApproved === true — clicks
 * Submit and requires the exact success text. Otherwise returns a readiness report
 * without sending.
 *
 * @param {object} page                 Playwright page (already logged in + client open)
 * @param {object} opts
 * @param {string} opts.clientName       must be "Elizabeth Kelley"
 * @param {string} opts.crcClientId      must be "15"
 * @param {Array}  opts.pdfs             [{ bureau, filename, buffer, bytes }]
 * @param {boolean} opts.submitApproved  explicit gate for the live Submit click
 * @param {object} deps                  { fs, path, os } injected for testability
 */
export async function sendSecureMessage(page, opts, deps) {
    const { clientName, crcClientId, pdfs, submitApproved } = opts;
    const fsMod = deps.fs, pathMod = deps.path, osMod = deps.os;

    const report = {
        tool: SECURE_MESSAGE_VERSION,
        clientName,
        crcClientId,
        expectedAttachmentCount: Array.isArray(pdfs) ? pdfs.length : 0,
        verifiedAttachmentCount: 0,
        attachments: [],
        selectedRecipient: null,
        subjectFilled: false,
        bodyFilled: false,
        readyToSubmit: false,
        submitApproved: submitApproved === true,
        messageSubmitted: false,
        messageSuccessConfirmed: false,
        failedStage: null,
        failureReason: null,
    };

    // HARD client identity guard.
    if (clientName !== AUTHORIZED_CLIENT_NAME || String(crcClientId) !== AUTHORIZED_CLIENT_ID) {
        report.failedStage = "authorization";
        report.failureReason =
            `Sender authorized only for ${AUTHORIZED_CLIENT_NAME} (Client ${AUTHORIZED_CLIENT_ID}).`;
        return report;
    }
    if (!Array.isArray(pdfs) || pdfs.length === 0) {
        report.failedStage = "pdfs";
        report.failureReason = "No PDFs provided to deliver.";
        return report;
    }
    // Every PDF must be under 10 MB and have a buffer + filename.
    for (const p of pdfs) {
        if (!p.buffer || !p.filename) {
            report.failedStage = "pdfs";
            report.failureReason = `PDF for ${p.bureau ?? "?"} is missing buffer/filename.`;
            return report;
        }
        if ((p.bytes ?? p.buffer.length) >= MAX_PDF_BYTES) {
            report.failedStage = "pdfs";
            report.failureReason = `PDF ${p.filename} is at/over the 10 MB limit.`;
            return report;
        }
    }

    // Temp dir for file attachment.
    const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "m8-pdfs-"));

    try {
        // 1) Open a true compose form.
        if (!(await openComposeForm(page, crcClientId))) {
            report.failedStage = "open_compose";
            report.failureReason = "Could not open the secure-message compose form via the dashboard \"Send Secure Message\" button.";
            return report;
        }

        // 2) Select the exact client + verify.
        const sel = await selectExactClient(page, clientName);
        if (!sel.ok) { report.failedStage = sel.failedStage; report.failureReason = sel.failureReason; return report; }
        report.selectedRecipient = sel.selectedClient;

        // 3) Subject.
        const subj = await fillSubject(page, SUBJECT_TEXT);
        if (!subj.ok) { report.failedStage = subj.failedStage; report.failureReason = subj.failureReason; return report; }
        report.subjectFilled = true;

        // 4) Body.
        const bod = await fillBody(page, BODY_TEXT);
        if (!bod.ok) { report.failedStage = bod.failedStage; report.failureReason = bod.failureReason; return report; }
        report.bodyFilled = true;

        // ---- DRY-RUN BOUNDARY ---------------------------------------------
        // Navigating away from a populated CRC compose form is NOT verified to
        // discard the draft/attachments safely. So on a DRY RUN we STOP HERE,
        // BEFORE uploading any files. We confirm the recipient/subject/body were
        // reachable and report readiness WITHOUT leaving attachments behind.
        if (submitApproved !== true) {
            report.readyToSubmit =
                report.selectedRecipient === AUTHORIZED_CLIENT_NAME &&
                report.subjectFilled &&
                report.bodyFilled &&
                report.expectedAttachmentCount > 0;
            report.stoppedBeforeSubmit = true;
            report.attachmentsUploadedInDryRun = false;
            report.note =
                "Dry run stopped BEFORE uploading files (unsent-draft discard is unverified). " +
                "No attachments were added. Re-run with submitApproved:true to upload + send.";
            return report;
        }

        // ---- APPROVED SEND ONLY BELOW -------------------------------------
        // 5) Upload each PDF separately, verifying each filename. (Only reached
        // when submitApproved === true, so no dry-run draft is ever left.)
        for (const pdf of pdfs) {
            const up = await uploadOnePdf(page, pdf, tmpDir, fsMod, pathMod);
            if (!up.ok) { report.failedStage = up.failedStage; report.failureReason = up.failureReason; return report; }
            report.attachments.push({ bureau: up.bureau, filename: up.filename, verified: true });
            report.verifiedAttachmentCount += 1;
        }

        // 6) Attachment count must match expected.
        if (report.verifiedAttachmentCount !== report.expectedAttachmentCount) {
            report.failedStage = "attachment_count";
            report.failureReason =
                `Verified ${report.verifiedAttachmentCount} of ${report.expectedAttachmentCount} attachments.`;
            return report;
        }

        // 7) PRE-SUBMIT HARD CHECKS (all must pass immediately before Submit).
        const hardChecks =
            report.selectedRecipient === AUTHORIZED_CLIENT_NAME &&
            report.subjectFilled &&
            report.bodyFilled &&
            report.verifiedAttachmentCount === report.expectedAttachmentCount &&
            report.expectedAttachmentCount > 0;
        report.readyToSubmit = hardChecks;
        if (!hardChecks) {
            report.failedStage = "pre_submit_check";
            report.failureReason = "Pre-submit hard checks did not all pass.";
            return report;
        }

        // 8) Click the visible green button with exact text "Submit".
        const submitBtn = page.getByRole("button", { name: "Submit", exact: true }).first();
        if (!(await submitBtn.count()) || !(await submitBtn.isVisible().catch(() => false))) {
            report.failedStage = "submit_locate";
            report.failureReason = "Submit button not found/visible.";
            return report;
        }
        await submitBtn.click({ timeout: 15000 }).catch((e) => {
            report.failedStage = "submit_click";
            report.failureReason = `Submit click failed: ${e.message}`;
        });
        if (report.failedStage) return report;
        report.messageSubmitted = true;

        // 10) Require the EXACT success confirmation.
        let confirmed = false;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            confirmed = await page.getByText(EXACT_SUCCESS_TEXT, { exact: false })
                .first().isVisible().catch(() => false);
            if (confirmed) break;
            await page.waitForTimeout(400);
        }
        report.messageSuccessConfirmed = confirmed;
        if (!confirmed) {
            report.failedStage = "success_confirm";
            report.failureReason = `Did not observe exact confirmation "${EXACT_SUCCESS_TEXT}".`;
            return report;
        }

        return report;
    } catch (error) {
        report.failedStage = report.failedStage ?? "exception";
        report.failureReason = report.failureReason ?? error.message;
        return report;
    } finally {
        // Clean up temp PDFs.
        try {
            for (const f of fsMod.readdirSync(tmpDir)) fsMod.unlinkSync(pathMod.join(tmpDir, f));
            fsMod.rmdirSync(tmpDir);
        } catch { /* ignore */ }
    }
}

export { SUBJECT_TEXT, BODY_TEXT, EXACT_SUCCESS_TEXT };
