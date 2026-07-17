/**
 * discoverM8CrcV2.js  — TARGETED M8 DISCOVERY (generation-capable, SAVE-BLOCKED)
 *
 * ###########################################################################
 * ##  THIS IS NOT PRODUCTION M8. IT SAVES NOTHING.                         ##
 * ##                                                                       ##
 * ##  V1 was fully read-only and therefore could not see the POPULATED     ##
 * ##  editor or the Save modal — they don't exist until a letter is        ##
 * ##  generated. V2 is authorized (Client 15 only) to generate ONE UNSAVED ##
 * ##  library-letter draft so it can capture:                              ##
 * ##    - the real "generate a letter (no dispute items)" link             ##
 * ##    - the real recipient-field selectors                               ##
 * ##    - the POPULATED Froala editor innerHTML + signature boundary       ##
 * ##    - the Save-for-Later modal structure                               ##
 * ##    - the Leave-Without-Saving dialog                                  ##
 * ##  ...then LEAVES WITHOUT SAVING.                                        ##
 * ##                                                                       ##
 * ##  HARD RULE: never clicks Save Letter, never creates a follow-up task, ##
 * ##  never clicks Generate Unique AI, never changes status/profile, never ##
 * ##  submits/sends/prints, never touches any client other than 15.        ##
 * ###########################################################################
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";

export const DISCOVERY_V2_VERSION = "BT-M8-DISCOVERY-2.0";

// The ONLY client this tool may touch. A hard guard, not a convention.
const AUTHORIZED_CLIENT_ID = "15";
const AUTHORIZED_CLIENT_NAME = "Elizabeth Kelley";

// Experian recipient — chosen to avoid the unresolved TransUnion two-line issue.
const DISCOVERY_RECIPIENT = Object.freeze({
    companyName: "Experian Information Solutions, Inc.",
    address: "P.O. Box 4500",
    address2: "",
    city: "Allen",
    state: "TX",
    zip: "75013",
});

// ---------------------------------------------------------------------------
// SAFETY DENYLIST. If any helper is ever asked to click a control whose
// accessible name matches these, it THROWS instead of clicking. Belt-and-
// suspenders on top of "we simply never call click() on them".
// ---------------------------------------------------------------------------
const FORBIDDEN_CLICK_PATTERNS = [
    /^save letter$/i,        // the final save — NEVER
    /generate unique ai/i,   // the green AI generator — NEVER
    /^submit$/i, /^send\b/i, /mail/i, /print/i,
    /^save$/i,               // profile "Save" (green) — status write
    /delete/i, /remove/i,
    /save letters/i,         // the "Save Letters" option in the leave-warning
];

function assertClickAllowed(label) {
    for (const pattern of FORBIDDEN_CLICK_PATTERNS) {
        if (pattern.test((label ?? "").trim())) {
            throw new Error(
                `DISCOVERY SAFETY: refused to click "${label}" — matches a forbidden ` +
                `write/side-effect pattern. V2 generates an UNSAVED draft only.`
            );
        }
    }
    return true;
}

/** A guarded click: checks the denylist, then clicks by exact visible text/role. */
async function safeClickByText(page, text, opts = {}) {
    assertClickAllowed(text);
    const loc = page.getByRole(opts.role ?? "button", { name: text, exact: opts.exact ?? false })
        .or(page.getByText(text, { exact: opts.exact ?? false }))
        .first();
    await loc.waitFor({ state: "visible", timeout: opts.timeout ?? 15000 });
    await loc.click({ timeout: opts.timeout ?? 15000 });
    return true;
}

// ---------------------------------------------------------------------------
// Read-only describe/capture helpers (same shape as V1).
// ---------------------------------------------------------------------------
async function describe(locator) {
    try {
        if ((await locator.count()) === 0) return null;
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
                role: node.getAttribute ? node.getAttribute("role") : null,
                classes: node.className && node.className.toString ? node.className.toString() : null,
                text: (node.textContent || "").trim().slice(0, 160),
                attrs: attr(node),
            };
        }).catch(() => null);
        return { present: true, visible, ...info };
    } catch (error) {
        return { present: false, error: error.message };
    }
}

/** Sanitize captured HTML: strip anything sensitive, keep structure/selectors. */
function sanitizeHtml(html) {
    if (typeof html !== "string") return null;
    return html
        // redact long data: URIs (signature images can be huge base64 — keep a marker)
        .replace(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/g, "data:image/REDACTED_BASE64")
        // redact any obvious token-ish query strings on image srcs
        .replace(/([?&](token|sig|signature|key|auth)=)[^"'&\s]+/gi, "$1REDACTED")
        .slice(0, 20000); // cap size for transport
}

async function shot(page, name) {
    const path = `/tmp/m8v2-${name}.png`;
    try { await page.screenshot({ path, fullPage: false }); return path; }
    catch (error) { return `screenshot-failed:${error.message}`; }
}

/**
 * Drive a MUI Autocomplete combobox: focus, type the query, wait for the
 * listbox, click the exact option. Returns what it selected (or an error).
 * This is READ/INPUT to a draft form only — it persists nothing.
 */
async function selectFromAutocombo(page, comboLocator, optionText) {
    try {
        const input = comboLocator.first();
        await input.click({ timeout: 10000 });
        await input.fill("");                       // clear "Select a ..."
        await input.type(optionText, { delay: 20 }); // let MUI filter
        // MUI renders options into a portal <ul role="listbox"><li role="option">
        const option = page.getByRole("option", { name: optionText, exact: false }).first();
        await option.waitFor({ state: "visible", timeout: 10000 });
        const chosen = (await option.textContent().catch(() => optionText)) || optionText;
        await option.click({ timeout: 10000 });
        return { ok: true, selected: chosen.trim(), method: "type-then-click-option[role=option]" };
    } catch (error) {
        return { ok: false, error: error.message, method: "type-then-click-option[role=option]" };
    }
}

export async function discoverM8CrcV2(data = {}) {
    const clientName = data?.clientName ?? AUTHORIZED_CLIENT_NAME;

    const report = {
        tool: DISCOVERY_V2_VERSION,
        clientName,
        stagesReached: [],
        blockedStage: null,
        blockedReason: null,
        // Findings
        noItemsLinkLocator: null,
        recipientFieldMapping: null,
        comboboxOptionSelectionMethod:
            "MUI Autocomplete: focus input -> clear -> type option text -> click li[role=option]. " +
            "Option lists are portal-rendered and absent from the DOM until the combobox is opened.",
        froalaEditorLocator: null,
        populatedEditorInnerHtml: null,
        editorStructure: null,
        signatureElements: null,
        signatureBoundary: null,
        saveForLaterModal: null,
        leavePageDialog: null,
        artifacts: [],
        replayUrl: null,
        // Safety attestations — MUST stay false.
        writesAttempted: false,
        saveClicked: false,
        followUpCreated: false,
        statusChanged: false,
        editorModified: false,
        messageSubmitted: false,
        // Gate
        implementationReady: false,
        blockingGaps: [],
        unresolved: [],
    };

    // HARD CLIENT GUARD.
    if (clientName !== AUTHORIZED_CLIENT_NAME) {
        report.blockedStage = "authorization";
        report.blockedReason =
            `V2 is authorized ONLY for ${AUTHORIZED_CLIENT_NAME} (Client ${AUTHORIZED_CLIENT_ID}). ` +
            `Refusing to run against "${clientName}".`;
        report.blockingGaps.push("unauthorized_client");
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

        // ---- STAGE 1: login + open client 15, assert the URL is client 15 ---
        await loginToCRC(page);
        await openClient(page, clientName);

        // Navigate DIRECTLY to generate-letters by URL (the tabs carry
        // target="_blank" and would spawn a second tab — discovered in V1).
        await page.goto(
            `https://app.creditrepaircloud.com/app/clients/${AUTHORIZED_CLIENT_ID}/generate-letters`,
            { waitUntil: "domcontentloaded" }
        );
        // Assert we are on client 15's page and nowhere else.
        if (!page.url().includes(`/clients/${AUTHORIZED_CLIENT_ID}/`)) {
            throw new Error(`Expected to be on client ${AUTHORIZED_CLIENT_ID}; got ${page.url()}`);
        }
        report.stagesReached.push("generate_letters");

        // ---- STAGE 2: the "generate a letter (with no dispute items)" link --
        // V1 missed it. Capture broadly, then record the resolved locator.
        const noItemsCandidates = [
            page.getByRole("link", { name: /generate a letter.*no dispute items/i }),
            page.getByText(/generate a letter \(with no dispute items\)/i),
            page.getByRole("link", { name: /no dispute items/i }),
            page.getByText(/no dispute items/i),
        ];
        let noItemsLink = null;
        for (const cand of noItemsCandidates) {
            if (await cand.count()) { noItemsLink = cand.first(); break; }
        }
        report.noItemsLinkLocator = noItemsLink ? await describe(noItemsLink) : null;
        if (!noItemsLink) {
            report.blockingGaps.push("no_items_link_not_found");
            report.blockedStage = "generate_letters_link";
            report.blockedReason =
                "Could not locate the 'Generate a letter (with no dispute items)' link. " +
                "Capturing page HTML for selector discovery, then stopping (nothing was created).";
            report.pageHtmlForLinkDiscovery = sanitizeHtml(await page.content());
            report.artifacts.push(await shot(page, "02-no-items-link-missing"));
            return report;
        }
        await safeClickByText(page, "no dispute items", { role: "link" }).catch(async () => {
            // fall back to clicking the resolved locator directly (still guarded)
            await noItemsLink.click({ timeout: 15000 });
        });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        report.stagesReached.push("dispute_wizard");
        report.artifacts.push(await shot(page, "03-wizard"));

        // ---- STAGE 3: select Category + Letter Name (MUI autocompletes) -----
        const categoryCombo = page.locator('input[role="combobox"]').first(); // Category was :r1s1:
        const catResult = await selectFromAutocombo(page, categoryCombo, "Credit Bureau Letters");
        // Letter Name is the next combobox.
        const letterCombo = page.locator('input[role="combobox"]').nth(1);
        const letterResult = await selectFromAutocombo(page, letterCombo, "Bureau No Response");
        report.wizardSelections = { category: catResult, letterName: letterResult };

        // ---- STAGE 4: map the recipient fields, then fill them --------------
        // V1 could not map Company/Address/City/ZIP (shared id="outlined-basic",
        // no labels). Map them positionally by their surrounding MUI label text.
        report.recipientFieldMapping = await page.evaluate(() => {
            // Find every text input in the recipient card and record the visible
            // label text of its MUI form-control, plus a positional index.
            const inputs = Array.from(document.querySelectorAll("input"));
            return inputs.map((el, i) => {
                const fc = el.closest(".MuiFormControl-root, .MuiTextField-root");
                const label = fc ? (fc.querySelector("label")?.textContent || "").trim() : null;
                return {
                    index: i,
                    id: el.id || null,
                    role: el.getAttribute("role"),
                    label,
                    placeholder: el.getAttribute("placeholder"),
                    value: el.value,
                    required: el.hasAttribute("required"),
                };
            }).filter((f) => f.label || f.required || f.role === "combobox");
        }).catch(() => null);

        // Fill by label where possible; each is INPUT to a draft, persists nothing.
        const fillByLabel = async (labelRe, value) => {
            if (value === "") return { label: String(labelRe), skipped: "empty" };
            try {
                const field = page.getByLabel(labelRe).first();
                if (await field.count()) {
                    await field.fill(value, { timeout: 8000 });
                    return { label: String(labelRe), ok: true };
                }
            } catch (error) {
                return { label: String(labelRe), ok: false, error: error.message };
            }
            return { label: String(labelRe), ok: false, error: "not found" };
        };
        report.recipientFillResults = {
            companyName: await fillByLabel(/company name/i, DISCOVERY_RECIPIENT.companyName),
            address: await fillByLabel(/^address/i, DISCOVERY_RECIPIENT.address),
            city: await fillByLabel(/city/i, DISCOVERY_RECIPIENT.city),
            zip: await fillByLabel(/zip/i, DISCOVERY_RECIPIENT.zip),
            state: await selectFromAutocombo(
                page,
                page.locator('input[role="combobox"]').last(),
                DISCOVERY_RECIPIENT.state
            ),
        };
        report.artifacts.push(await shot(page, "04-recipient-filled"));

        // ---- STAGE 5: click GENERATE LIBRARY LETTER (the outlined one) ------
        // Assert we are clicking the outlined library button, NOT the green AI one.
        const libraryBtn = page.getByRole("button", { name: /generate library letter/i }).first();
        const libraryBtnInfo = await describe(libraryBtn);
        if (!libraryBtnInfo || /containedSuccess/i.test(libraryBtnInfo.classes ?? "")) {
            throw new Error(
                "Refusing to click: the 'Generate Library Letter' match looked like the green " +
                "containedSuccess (AI) button. Aborting to avoid the AI generator."
            );
        }
        assertClickAllowed("Generate Library Letter");
        await libraryBtn.click({ timeout: 20000 });
        // Wait for the Froala editable body to become visible & populated.
        const froala = page.locator('div.fr-element.fr-view[contenteditable="true"]').first();
        await froala.waitFor({ state: "visible", timeout: 30000 });
        report.stagesReached.push("editor_populated");
        report.froalaEditorLocator = 'div.fr-element.fr-view[contenteditable="true"]';
        report.artifacts.push(await shot(page, "05-editor-populated"));

        // ---- STAGE 6: capture the POPULATED editor + find the signature -----
        const editorDump = await froala.evaluate((node) => {
            const imgs = Array.from(node.querySelectorAll("img")).map((im, i) => ({
                index: i,
                src: (im.getAttribute("src") || "").slice(0, 60),
                alt: im.getAttribute("alt"),
                className: im.className || null,
                width: im.getAttribute("width"),
                id: im.id || null,
                // path of the image within the editor (child index chain)
            }));
            // Heuristic: signature usually sits after a "Sincerely"/"Signature"
            // marker near the end. Record the last ~5 block children so we can see
            // where the body ends and the signature block begins.
            const blocks = Array.from(node.children).map((c, i) => ({
                index: i,
                tag: c.tagName.toLowerCase(),
                className: c.className || null,
                textPreview: (c.textContent || "").trim().slice(0, 80),
                hasImg: !!c.querySelector("img"),
            }));
            return {
                childCount: node.children.length,
                images: imgs,
                blocks,
                innerHtml: node.innerHTML,
            };
        }).catch((e) => ({ error: e.message }));

        report.editorStructure = editorDump.error ? editorDump : {
            childCount: editorDump.childCount,
            blocks: editorDump.blocks,
        };
        report.populatedEditorInnerHtml = sanitizeHtml(editorDump.innerHtml);
        report.signatureElements = editorDump.images ?? null;

        // Determine the body-vs-signature boundary: the first block (from the end)
        // that contains an image OR a "Sincerely"/signature marker. Everything
        // BEFORE it is safely replaceable body; everything from it onward is the
        // signature region to PRESERVE.
        report.signatureBoundary = await froala.evaluate((node) => {
            const children = Array.from(node.children);
            let sigStart = -1;
            for (let i = children.length - 1; i >= 0; i--) {
                const c = children[i];
                const txt = (c.textContent || "").toLowerCase();
                if (c.querySelector("img") || /sincerely|signature/.test(txt)) {
                    sigStart = i;
                } else if (sigStart !== -1 && txt.trim() !== "") {
                    // hit real body text above the signature -> boundary is sigStart
                    break;
                }
            }
            return {
                found: sigStart !== -1,
                signatureFirstChildIndex: sigStart,
                totalChildren: children.length,
                strategy:
                    "Replace only children[0..signatureFirstChildIndex-1]; preserve " +
                    "children[signatureFirstChildIndex..end]. If found=false, DO NOT REPLACE — " +
                    "fail closed to manual review.",
            };
        }).catch(() => ({ found: false }));

        // ---- STAGE 7: open Save-for-Later modal, DESCRIBE it, do NOT save ---
        try {
            await safeClickByText(page, "Save for Later", { role: "button" });
            const modal = page.locator('[role="dialog"], .MuiDialog-root').first();
            await modal.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
            report.saveForLaterModal = {
                dialog: await describe(modal),
                round: await describe(page.getByLabel(/round/i)
                    .or(page.locator('[role="dialog"] input[role="combobox"]').first())),
                nameOfLetter: await describe(page.getByLabel(/name of letter|letter name/i)),
                abbreviation: await describe(page.getByLabel(/abbreviation/i)),
                followUpCheckbox: await describe(page.getByRole("checkbox")
                    .or(page.getByLabel(/follow.?up/i))),
                followUpPeriod: await describe(page.getByLabel(/day|period/i)),
                saveLetterButton_NOT_CLICKED: await describe(
                    page.getByRole("button", { name: /^save letter$/i })),
                cancelButton: await describe(page.getByRole("button", { name: /cancel/i })),
                closeButton: await describe(page.getByRole("button", { name: /close/i })
                    .or(page.locator('[role="dialog"] [aria-label="close" i]'))),
            };
            report.artifacts.push(await shot(page, "06-save-modal"));
            // Close the modal WITHOUT saving.
            const cancel = page.getByRole("button", { name: /cancel/i }).first();
            if (await cancel.count()) { assertClickAllowed("Cancel"); await cancel.click().catch(() => {}); }
            report.stagesReached.push("save_modal_inspected");
        } catch (error) {
            report.saveForLaterModal = { error: error.message };
            report.unresolved.push("save_for_later_modal_inspection_failed");
        }

        // ---- STAGE 8: trigger + inspect the Leave-Without-Saving dialog -----
        // Navigating away from a dirty editor raises the warning. We DESCRIBE it
        // and then choose "Leave Page" (discard) — never "Save Letters".
        try {
            await page.goto(
                `https://app.creditrepaircloud.com/app/clients/${AUTHORIZED_CLIENT_ID}/dashboard`,
                { waitUntil: "domcontentloaded", timeout: 10000 }
            ).catch(() => {});
            const leaveText = page.getByText(/leave without saving/i);
            if (await leaveText.count()) {
                report.leavePageDialog = {
                    text: await describe(leaveText),
                    leavePageButton: await describe(page.getByRole("button", { name: /leave page/i })
                        .or(page.getByText(/leave page/i))),
                    saveLettersButton_NEVER_CLICKED: await describe(
                        page.getByRole("button", { name: /save letters/i })),
                };
                report.artifacts.push(await shot(page, "07-leave-dialog"));
                // Choose Leave Page (discard the unsaved draft). Guarded.
                assertClickAllowed("Leave Page");
                await page.getByRole("button", { name: /leave page/i })
                    .or(page.getByText(/leave page/i)).first()
                    .click({ timeout: 10000 }).catch(() => {});
                report.stagesReached.push("leave_dialog_inspected");
            } else {
                report.leavePageDialog = { note: "Leave-without-saving warning did not appear on navigation." };
            }
        } catch (error) {
            report.leavePageDialog = { error: error.message };
            report.unresolved.push("leave_dialog_inspection_failed");
        }

        // ---- GATE: implementationReady only if the safety-critical facts hold
        const haveSignature = report.signatureBoundary?.found === true;
        const haveEditor = !!report.froalaEditorLocator;
        const haveNoItems = !!report.noItemsLinkLocator;
        const haveRecipientMap = Array.isArray(report.recipientFieldMapping) &&
            report.recipientFieldMapping.length > 0;
        const haveSaveModal = report.saveForLaterModal && !report.saveForLaterModal.error;

        if (!haveSignature) report.blockingGaps.push("signature_boundary_not_positively_identified");
        if (!haveEditor) report.blockingGaps.push("froala_editor_locator_missing");
        if (!haveNoItems) report.blockingGaps.push("no_items_link_missing");
        if (!haveRecipientMap) report.blockingGaps.push("recipient_field_mapping_incomplete");
        if (!haveSaveModal) report.blockingGaps.push("save_modal_not_captured");

        report.implementationReady =
            haveSignature && haveEditor && haveNoItems && haveRecipientMap && haveSaveModal;

        report.completed = true;
        return report;
    } catch (error) {
        report.blockedStage = report.stagesReached[report.stagesReached.length - 1] ?? "startup";
        report.blockedReason = error.message;
        report.blockingGaps.push("run_threw_before_completion");
        return report;
    } finally {
        try { if (browser) await browser.close(); } catch { /* ignore */ }
    }
}
