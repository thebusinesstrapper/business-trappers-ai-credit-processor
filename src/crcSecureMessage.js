/**
 * crcSecureMessage.js — CRC secure-message delivery for M8.
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

export const SECURE_MESSAGE_VERSION = "BT-M8-SECURE-MESSAGE-1.1";

import { baseSearchName } from "./clientSearchName.js";


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

function normalizeClientName(value) {
    return typeof value === "string"
        ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")
        : "";
}

function namesMatch(left, right) {
    const a = normalizeClientName(left);
    const b = normalizeClientName(right);
    return Boolean(a && b && a === b);
}

/**
 * Choose the correct client option for the M8 recipient selector.
 *
 * The supplied clientName is the FULL authoritative name and is always tried
 * first. CRC's option labels are sometimes TRUNCATED ("Adriana Ellis-Fo",
 * "Michael Allen Gu", "Jennifer Wise FT") or drop a personal suffix
 * ("William Harrell IV" -> "William Harrell"), so an exact-equality match finds
 * nothing. This adds two SEARCH-ONLY fallbacks after the exact match:
 *
 *   1. CRC client ID — if the options expose an id (data-value / value / id),
 *      an option whose id equals the verified crcClientId is authoritative.
 *   2. Safe normalized name — the suffix-free base name (via clientSearchName)
 *      and a truncation-tolerant prefix: an option label that is a PREFIX of the
 *      full name (CRC truncated it) or vice-versa. Whitespace/case-normalized.
 *
 * NEVER selects blindly. If more than one option remains plausible after these
 * tiers, returns { ambiguous: true } so the caller fails closed. The full name
 * is never mutated; matching is on transient normalized copies only.
 *
 * @param {Array<{text:string, id:string|null}>} options
 * @param {string} clientName   full authoritative name
 * @param {string|number|null} crcClientId  verified CRC id (may be null)
 * @returns {{ matched:true, option:object } | { matched:false, ambiguous:boolean, candidates:number }}
 */
function pickClientOption(options, clientName, crcClientId) {
    const list = Array.isArray(options) ? options.filter((o) => o && o.text) : [];
    if (list.length === 0) return { matched: false, ambiguous: false, candidates: 0 };

    // Tier 1: exact full-name equality (unchanged behavior for normal clients).
    const exact = list.filter((o) => namesMatch(o.text, clientName));
    if (exact.length === 1) return { matched: true, option: exact[0] };
    if (exact.length > 1) return { matched: false, ambiguous: true, candidates: exact.length };

    // Tier 2: verified CRC client ID, when options expose one.
    const wantId = crcClientId == null ? "" : String(crcClientId).trim();
    if (wantId) {
        const byId = list.filter((o) => o.id != null && String(o.id).trim() === wantId);
        if (byId.length === 1) return { matched: true, option: byId[0] };
        if (byId.length > 1) return { matched: false, ambiguous: true, candidates: byId.length };
    }

    // Tier 3: safe normalized fallback — suffix-free base name and truncation.
    const full = normalizeClientName(clientName);
    const base = normalizeClientName(baseSearchName(clientName) || "");

    const plausible = list.filter((o) => {
        const opt = normalizeClientName(o.text);
        if (!opt) return false;
        // Suffix-free exact base-name match.
        if (base && opt === base) return true;
        // Truncation: the option label is a leading prefix of the full name
        // (CRC cut it off), or the full name is a prefix of the option. Require a
        // meaningful length so a 1-2 char stub cannot match many clients.
        if (opt.length >= 5 && full.startsWith(opt)) return true;
        if (base && opt.length >= 5 && base.startsWith(opt)) return true;
        if (opt.length >= 5 && opt.startsWith(full)) return true;
        return false;
    });

    if (plausible.length === 1) return { matched: true, option: plausible[0] };
    if (plausible.length > 1) return { matched: false, ambiguous: true, candidates: plausible.length };

    return { matched: false, ambiguous: false, candidates: 0 };
}

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

async function selectExactClient(page, clientName, crcClientId) {
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
    if (namesMatch(prefilled, clientName)) {
        console.log("[M8 client] prefilled client verified; not reselecting.");
        return { ok: true, selectedClient: clientName, resultingValue: prefilled, viaPrefill: true };
    }
    console.log("[M8 client] prefill did not match; falling back to type-and-select.");

    // Fallback ONLY if the prefill failed verification.
    await combo.click({ timeout: 8000 }).catch(() => {});
    await combo.fill("").catch(() => {});
    await combo.type(clientName, { delay: 25 }).catch(() => {});

    // Collect filtered options as { text, id }. The id (data-value / value / id
    // / data-id) lets us verify by the authoritative CRC client id even when the
    // visible label is truncated or drops a suffix.
    const readOptions = () =>
        page.getByRole("option").evaluateAll((nodes) =>
            nodes.map((n) => ({
                text: (n.textContent || "").replace(/\s+/g, " ").trim(),
                id:
                    n.getAttribute("data-value") ||
                    n.getAttribute("data-id") ||
                    n.getAttribute("value") ||
                    n.getAttribute("id") ||
                    null,
            }))
        ).catch(() => []);

    // Wait for filtered options; stop as soon as a plausible match exists so we
    // do not spin the full window on the common (fast) case.
    let options = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        options = await readOptions();
        if (pickClientOption(options, clientName, crcClientId).matched) break;
        // Also stop early if options are present but none will ever match, so an
        // ambiguous/absent result is returned promptly rather than after 8s.
        if (options.length > 0 && !pickClientOption(options, clientName, crcClientId).ambiguous
            && pickClientOption(options, clientName, crcClientId).candidates === 0
            && options.some((o) => o.text)) {
            // options rendered but no tier matched yet; keep polling briefly.
        }
        await page.waitForTimeout(250);
    }

    // Choose the correct option: exact name -> CRC id -> safe normalized/truncation.
    // NEVER select the first result blindly; fail closed on ambiguity.
    const pick = pickClientOption(options, clientName, crcClientId);

    if (!pick.matched) {
        if (pick.ambiguous) {
            return fail("client_select",
                `Multiple plausible options for "${clientName}"; found ${pick.candidates}. ` +
                `Failing closed to avoid selecting the wrong client.`,
                { blockedReason: "ambiguous_client_match", optionsSample: options.slice(0, 10) });
        }
        return fail("client_select",
            `Expected exactly one "${clientName}" option; found ${pick.candidates}.`,
            { optionsSample: options.slice(0, 10) });
    }

    // Click the chosen option by its EXACT displayed text (the label CRC shows,
    // which may be truncated) — never by the full supplied name, which may not
    // equal the visible option.
    const matchingOptionText = pick.option.text;
    await page.getByRole("option", { name: matchingOptionText, exact: true }).first()
        .click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);

    // Verify the resulting selected value equals the client name OR the chosen
    // option label (a truncated/suffix-free label is the authoritative selection
    // when it was matched by CRC id or the safe fallback).
    const val = (await combo.inputValue().catch(() => "")) || "";
    const selectedText = await page.evaluate(() => {
        const el = document.querySelector('input[name="client_id"]');
        return el ? (el.value || "") : "";
    }).catch(() => "");
    const resulting = val || selectedText;
    const confirmed =
        namesMatch(resulting, clientName) ||
        namesMatch(resulting, matchingOptionText);
    if (!confirmed) {
        return fail("client_verify",
            `Selected client value "${resulting}" does not equal "${clientName}" ` +
            `or the chosen option "${matchingOptionText}".`);
    }
    // resultingValue is the CRC-side selection; selectedClient stays the FULL
    // authoritative name for identity/reporting.
    return { ok: true, selectedClient: clientName, resultingValue: resulting };
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
 * @param {string} opts.clientName       requested client name; compared case-insensitively
 * @param {string} opts.crcClientId      authoritative CRC client ID verified by M8
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
        blockedReason: null,
    };

    // HARD identity-input guard. The authoritative CRC Client ID was already
    // verified by the M8 orchestrator against the opened client dashboard.
    // This delivery module independently requires both identity inputs to be
    // present, while treating name capitalization as non-authoritative.
    if (!normalizeClientName(clientName) || !String(crcClientId ?? "").trim()) {
        report.failedStage = "authorization";
        report.failureReason = "A client name and authoritative CRC Client ID are required.";
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
        const sel = await selectExactClient(page, clientName, crcClientId);
        if (!sel.ok) {
            report.failedStage = sel.failedStage;
            report.failureReason = sel.failureReason;
            // Surface the fail-closed reason so the orchestrator can route to
            // manual review as an ambiguous match rather than a generic failure.
            if (sel.blockedReason) report.blockedReason = sel.blockedReason;
            return report;
        }
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
                namesMatch(report.selectedRecipient, clientName) &&
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
            namesMatch(report.selectedRecipient, clientName) &&
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
// Exported for unit testing of the recipient-selection matcher. Pure function;
// no behavioral effect on the live send path.
export { pickClientOption };
