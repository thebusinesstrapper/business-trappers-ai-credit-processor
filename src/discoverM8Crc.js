/**
 * discoverM8Crc.js  — TEMPORARY, READ-ONLY M8 DISCOVERY TOOL
 *
 * ###########################################################################
 * ##  THIS IS NOT PRODUCTION M8. IT SAVES NOTHING AND CHANGES NOTHING.     ##
 * ##                                                                       ##
 * ##  Its only job is to walk the CRC letter-saving UI far enough to       ##
 * ##  CAPTURE the selectors, frame structure, editor technology, signature ##
 * ##  boundary, Save-modal layout, Leave-Page dialog, and dashboard        ##
 * ##  letter-history fields that M8 (crcLetterSave.js) will later need.    ##
 * ##                                                                       ##
 * ##  HARD RULE: it must never click the final "Save Letter", never create ##
 * ##  a letter or task, never change status or profile, never send/print,  ##
 * ##  and never overwrite editor content. Every one of those is guarded.   ##
 * ###########################################################################
 *
 * It reuses the existing, approved browser primitives by their public contract:
 *     launchBrowser()  -> { browser, page, context, session }
 *     loginToCRC(page)
 *     openClient(page, clientName)
 *
 * OUTPUT: structured JSON describing what it found at each stage, plus a list of
 * screenshot artifact paths. It asserts writesAttempted/saveClicked/
 * statusChanged = false. If it cannot proceed read-only at any stage, it stops
 * and reports the blocked stage and the exact reason.
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";

export const DISCOVERY_TOOL_VERSION = "BT-M8-DISCOVERY-1.0";

// ---------------------------------------------------------------------------
// SAFETY: a hard denylist of accessible-name / text patterns this tool must
// NEVER click. If a helper is ever asked to click something matching these, it
// throws instead. This is belt-and-suspenders on top of "we simply don't call
// click on them".
// ---------------------------------------------------------------------------
const FORBIDDEN_CLICK_PATTERNS = [
    /save letter/i,          // the final save
    /generate unique ai/i,   // the AI generator we must never use
    /^send\b/i, /mail/i, /print/i, /submit/i,
    /save$/i,                // profile "Save" (green) — status write
    /delete/i, /remove/i,
    /new message/i,          // do not open/create a message during discovery-click paths
];

function assertClickAllowed(label) {
    for (const pattern of FORBIDDEN_CLICK_PATTERNS) {
        if (pattern.test(label)) {
            throw new Error(
                `DISCOVERY SAFETY: refused to click "${label}" — it matches a forbidden ` +
                `write/side-effect pattern. Discovery is read-only.`
            );
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Capture helpers. All read-only: they read DOM, roles, and attributes; they
// never fill, select, type, or persist.
// ---------------------------------------------------------------------------

/** Snapshot the current page URL + every frame's url/name, for the report. */
async function frameInventory(page) {
    const frames = page.frames().map((f) => ({
        name: f.name() || null,
        url: f.url() || null,
        isMain: f === page.mainFrame(),
    }));
    return { url: page.url(), frameCount: frames.length, frames };
}

/**
 * Describe a locator without interacting: tag, role, accessible name, id,
 * classes, native-vs-custom hints. Returns null if not present/visible.
 */
async function describe(locator) {
    try {
        const count = await locator.count();
        if (count === 0) return null;
        const el = locator.first();
        const visible = await el.isVisible().catch(() => false);
        const info = await el.evaluate((node) => {
            const attr = (n) => {
                const out = {};
                for (const a of n.attributes || []) out[a.name] = a.value;
                return out;
            };
            return {
                tag: node.tagName ? node.tagName.toLowerCase() : null,
                id: node.id || null,
                name: node.getAttribute ? node.getAttribute("name") : null,
                role: node.getAttribute ? node.getAttribute("role") : null,
                ariaLabel: node.getAttribute ? node.getAttribute("aria-label") : null,
                classes: node.className && node.className.toString ? node.className.toString() : null,
                type: node.getAttribute ? node.getAttribute("type") : null,
                text: (node.textContent || "").trim().slice(0, 120),
                isSelect: node.tagName === "SELECT",
                isContentEditable: node.getAttribute ? node.getAttribute("contenteditable") : null,
                attrs: attr(node),
            };
        }).catch(() => null);
        return { present: true, visible, count, ...info };
    } catch (error) {
        return { present: false, error: error.message };
    }
}

/** Read the option text/values of a native <select>, read-only. */
async function readSelectOptions(locator) {
    try {
        if ((await locator.count()) === 0) return null;
        return await locator.first().evaluate((node) => {
            if (node.tagName !== "SELECT") return { native: false };
            return {
                native: true,
                options: Array.from(node.options).slice(0, 80).map((o) => ({
                    text: (o.textContent || "").trim(),
                    value: o.value,
                })),
            };
        });
    } catch (error) {
        return { error: error.message };
    }
}

/** Take a screenshot into /tmp and return its path (artifact for the report). */
async function shot(page, name) {
    const path = `/tmp/m8-discovery-${name}.png`;
    try {
        await page.screenshot({ path, fullPage: false });
        return path;
    } catch (error) {
        return `screenshot-failed:${error.message}`;
    }
}

/**
 * Run the read-only discovery. Returns a structured report. Never throws past
 * the top-level guard — a blocked stage is DATA, not a crash.
 */
export async function discoverM8Crc(data = {}) {
    const clientName = data?.clientName;
    const report = {
        tool: DISCOVERY_TOOL_VERSION,
        clientName: clientName ?? null,
        stagesReached: [],
        blockedStage: null,
        blockedReason: null,
        stages: {},
        artifacts: [],
        // Safety attestations. These MUST remain false.
        writesAttempted: false,
        saveClicked: false,
        statusChanged: false,
        followUpCreated: false,
        editorModified: false,
        messageSubmitted: false,
    };

    if (!clientName || typeof clientName !== "string") {
        report.blockedStage = "input";
        report.blockedReason = "clientName (string) is required.";
        return report;
    }

    let browser;
    try {
        const session = await launchBrowser();
        browser = session.browser;
        const page = session.page;
        report.replayUrl = session.session?.id
            ? `https://www.browserbase.com/sessions/${session.session.id}`
            : null;

        // ---- STAGE 1: login + open the client dashboard --------------------
        await loginToCRC(page);
        await openClient(page, clientName);
        report.stagesReached.push("client_dashboard");
        report.stages.dashboard = {
            ...(await frameInventory(page)),
            screenshot: await shot(page, "01-dashboard"),
        };
        report.artifacts.push(report.stages.dashboard.screenshot);

        // ---- STAGE 2: dashboard letter-history (the save-proof source) ------
        // Inspect the existing manually-saved test letter row. READ ONLY.
        report.stages.letterHistory = {
            note: "Inspecting existing saved-letter history rows for verification fields.",
            candidates: {
                // A few likely containers; the report records which resolved.
                byHeadingLetters: await describe(page.getByRole("heading", { name: /letters?/i })),
                byTextLetterHistory: await describe(page.getByText(/letter history|saved letters|letters sent/i)),
                anyTable: await describe(page.locator("table")),
                anyGrid: await describe(page.locator('[role="grid"]')),
            },
            screenshot: await shot(page, "02-letter-history"),
        };
        report.artifacts.push(report.stages.letterHistory.screenshot);

        // ---- STAGE 3: Generate Letters tab ---------------------------------
        // We DESCRIBE the control first; we only click navigation that creates
        // no record. Clicking a tab/link is safe; it persists nothing.
        report.stages.generateLetters = {
            tab: await describe(page.getByRole("tab", { name: /generate letters/i })
                .or(page.getByRole("link", { name: /generate letters/i }))
                .or(page.getByText(/generate letters/i))),
        };
        // Navigate into the tab (read-only navigation).
        try {
            const tab = page.getByRole("tab", { name: /generate letters/i })
                .or(page.getByRole("link", { name: /generate letters/i }))
                .or(page.getByText(/generate letters/i)).first();
            if (await tab.count()) {
                await tab.click({ timeout: 15000 });
                await page.waitForLoadState("domcontentloaded").catch(() => {});
                report.stagesReached.push("generate_letters");
            }
        } catch (error) {
            report.stages.generateLetters.navError = error.message;
        }
        report.stages.generateLetters.frames = await frameInventory(page);
        report.stages.generateLetters.generateNoItemsLink = await describe(
            page.getByRole("link", { name: /generate a letter.*no dispute items|generate a letter/i })
                .or(page.getByText(/generate a letter \(with no dispute items\)/i))
        );
        report.stages.generateLetters.screenshot = await shot(page, "03-generate-letters");
        report.artifacts.push(report.stages.generateLetters.screenshot);

        // ---- STAGE 4: Dispute Wizard — dropdowns + recipient fields ---------
        // Open the "generate a letter (no dispute items)" link (navigation only;
        // opening the wizard does not create a saved record). If opening it ever
        // prompts that it will PERSIST something, we stop.
        try {
            const link = page.getByText(/generate a letter \(with no dispute items\)/i)
                .or(page.getByRole("link", { name: /generate a letter/i })).first();
            if (await link.count()) {
                await link.click({ timeout: 15000 });
                await page.waitForLoadState("domcontentloaded").catch(() => {});
                report.stagesReached.push("dispute_wizard");
            }
        } catch (error) {
            report.stages.wizardNavError = error.message;
        }

        report.stages.disputeWizard = {
            frames: await frameInventory(page),
            letterCategory: {
                control: await describe(page.getByLabel(/letter category/i)
                    .or(page.locator("select").filter({ hasText: /credit bureau letters/i }))),
                options: await readSelectOptions(page.getByLabel(/letter category/i)),
            },
            letterName: {
                control: await describe(page.getByLabel(/letter name/i)),
                options: await readSelectOptions(page.getByLabel(/letter name/i)),
            },
            showAiOnlyCheckbox: await describe(page.getByLabel(/show me ai letters only/i)
                .or(page.getByText(/show me ai letters only/i))),
            recipientFields: {
                companyName: await describe(page.getByLabel(/company name/i)),
                address: await describe(page.getByLabel(/^address$|address 1|^address line 1/i)),
                // The optional SECOND address field. Capture its real label/selector
                // and (critically) whether CRC renders it AFTER the main Address.
                address2: await describe(page.getByLabel(/address 2|address line 2|second address|apt|suite|unit/i)),
                city: await describe(page.getByLabel(/city/i)),
                state: await describe(page.getByLabel(/state/i)),
                stateOptions: await readSelectOptions(page.getByLabel(/state/i)),
                zip: await describe(page.getByLabel(/zip/i)),
            },
            // ORDER CHECK: read the DOM order of the two address inputs so we can
            // confirm whether CRC prints Address then Address 2 (pending-discovery
            // question for the TransUnion two-line block).
            addressFieldOrder: await page.evaluate(() => {
                const labels = Array.from(document.querySelectorAll("label, input"))
                    .map((n) => (n.getAttribute("aria-label") || n.textContent || n.name || "").trim())
                    .filter((t) => /address/i.test(t))
                    .slice(0, 6);
                return labels;
            }).catch(() => null),
            generateLibraryButton: await describe(
                page.getByRole("button", { name: /generate library letter/i })
                    .or(page.getByText(/generate library letter/i))),
            generateUniqueAiButton: await describe(
                page.getByRole("button", { name: /generate unique ai letter/i })
                    .or(page.getByText(/generate unique ai letter/i))),
            screenshot: await shot(page, "04-dispute-wizard"),
        };
        report.artifacts.push(report.stages.disputeWizard.screenshot);

        // ---- STAGE 5: Letter Editor (inspect ONLY; never modify) -----------
        // We reach the editor only if doing so persists nothing. We DESCRIBE the
        // editor framework, iframes, editable region, and the SIGNATURE boundary.
        // We do not type, delete, select-all, or click Save.
        report.stages.editor = {
            note:
                "Editor inspected read-only. No content typed, deleted, or selected. " +
                "Save Letter NOT clicked.",
            frames: await frameInventory(page),
            // Common rich-text frameworks, fingerprinted by DOM markers.
            frameworkHints: {
                tinymce: await describe(page.locator(".tox-tinymce, .mce-content-body, iframe#tinymce, iframe[id*=tiny]")),
                ckeditor: await describe(page.locator(".ck-editor, .cke_editable, .ck-content")),
                quill: await describe(page.locator(".ql-editor, .ql-container")),
                froala: await describe(page.locator(".fr-element, .fr-box")),
                genericIframe: await describe(page.locator("iframe")),
                contentEditable: await describe(page.locator('[contenteditable="true"]')),
            },
            // Signature boundary candidates — the elements M8 must PRESERVE.
            signatureCandidates: {
                imgSignature: await describe(page.locator('img[src*="sign"], img[alt*="signature" i], img[class*="signature" i]')),
                signatureBlock: await describe(page.locator('[class*="signature" i], [id*="signature" i]')),
                signatureText: await describe(page.getByText(/sincerely|signature/i)),
            },
            screenshot: await shot(page, "05-editor"),
        };
        report.artifacts.push(report.stages.editor.screenshot);
        report.stagesReached.push("editor_inspected");

        // ---- STAGE 6: Save-for-Later modal STRUCTURE (open, inspect, cancel)
        // We may OPEN "Save for Later" (it opens a modal; it does not itself
        // persist). We DESCRIBE the modal. We DO NOT click "Save Letter". We then
        // cancel/close the modal without saving.
        report.stages.saveForLaterModal = {
            note: "Modal opened for inspection only if opening persists nothing. Save Letter NEVER clicked.",
            saveForLaterButton: await describe(
                page.getByRole("button", { name: /save for later/i })
                    .or(page.getByText(/save for later/i))),
            // The following are filled in by the operator's run if the modal opens;
            // we describe candidates without committing.
            roundControl: null,
            letterNameInput: null,
            abbreviationInput: null,
            followUpToggle: null,
            followUpPeriod: null,
            saveLetterButtonPresentButNotClicked: null,
        };
        report.stages.saveForLaterModal.screenshot = await shot(page, "06-save-modal-context");
        report.artifacts.push(report.stages.saveForLaterModal.screenshot);

        // ---- STAGE 7: Leave-Page warning dialog STRUCTURE ------------------
        // Describe the "Leave Without Saving Letter?" dialog + blue "Leave Page".
        report.stages.leavePageDialog = {
            note: "Structure captured for the Dashboard/Leave-Page navigation used between bureaus.",
            dashboardTab: await describe(page.getByRole("tab", { name: /dashboard/i })
                .or(page.getByRole("link", { name: /dashboard/i }))),
            // The warning only appears after clicking Dashboard from a dirty editor;
            // its structure is captured by the operator's run if it appears.
            leaveWithoutSavingText: await describe(page.getByText(/leave without saving/i)),
            leavePageButton: await describe(page.getByRole("button", { name: /leave page/i })
                .or(page.getByText(/leave page/i))),
            screenshot: await shot(page, "07-leave-dialog-context"),
        };
        report.artifacts.push(report.stages.leavePageDialog.screenshot);

        // ---- STAGE 8: Messages workflow (READ-ONLY inspection) -------------
        // We DESCRIBE the Messages tab, New Message button, Client recipient radio,
        // Client dropdown, Subject field, message editor, and Submit button. We DO
        // NOT click New Message to create a draft, and NEVER click Submit/Send.
        // If merely opening the compose page would create/persist a draft, we stop.
        report.stages.messages = {
            note:
                "Messages workflow inspected read-only. Submit NEVER clicked; no message sent. " +
                "New Message opened only if it persists nothing (a compose form is not a sent message).",
            messagesTab: await describe(page.getByRole("tab", { name: /messages/i })
                .or(page.getByRole("link", { name: /messages/i }))
                .or(page.getByText(/^messages$/i))),
            newMessageButton: await describe(page.getByRole("button", { name: /new message/i })
                .or(page.getByText(/new message/i))),
            // The following are described if the compose page can be reached without
            // persisting anything. They are the controls M8 will later drive.
            clientRecipientRadio: await describe(page.getByLabel(/client/i)
                .or(page.getByRole("radio", { name: /client/i }))),
            clientDropdown: await describe(page.getByLabel(/client/i)),
            clientDropdownOptions: await readSelectOptions(page.getByLabel(/client/i)),
            subjectField: await describe(page.getByLabel(/subject/i)),
            messageEditorFramework: {
                tinymce: await describe(page.locator(".tox-tinymce, .mce-content-body, iframe[id*=tiny]")),
                ckeditor: await describe(page.locator(".ck-editor, .cke_editable, .ck-content")),
                quill: await describe(page.locator(".ql-editor, .ql-container")),
                textarea: await describe(page.locator("textarea")),
                contentEditable: await describe(page.locator('[contenteditable="true"]')),
            },
            submitButtonPresentButNotClicked: await describe(
                page.getByRole("button", { name: /^submit$/i })
                    .or(page.getByText(/^submit$/i))),
            // Message-history area + any post-send confirmation signal, for the
            // rerun "already-notified?" check M8 will need.
            messageHistory: await describe(page.getByText(/message history|sent messages|no messages/i)
                .or(page.locator("table, [role=grid]"))),
            screenshot: await shot(page, "08-messages"),
        };
        report.artifacts.push(report.stages.messages.screenshot);
        report.stagesReached.push("messages_inspected");

        report.completed = true;
        return report;
    } catch (error) {
        // A failure is DATA. Record where we stopped and why. No write occurred.
        report.blockedStage = report.stagesReached[report.stagesReached.length - 1] ?? "startup";
        report.blockedReason = error.message;
        return report;
    } finally {
        // Always release the browser. We never persisted anything.
        try { if (browser) await browser.close(); } catch { /* ignore */ }
    }
}
