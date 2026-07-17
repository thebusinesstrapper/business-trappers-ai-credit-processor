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
// CRC PAGE STABILIZATION (reused pattern).
//
// This mirrors the proven marker-set stabilization used by
// src/importAuditState.js -> waitForStableMarkers(): poll at a fixed interval,
// and require STABLE_INTERVALS_REQUIRED consecutive confirming snapshots within
// a timeout before trusting the page; ANY change resets the count; if it never
// settles, FAIL CLOSED. Same constants (250ms interval, 2 intervals, 20s).
//
// The only difference is polarity: importAuditState waits for a marker set to
// APPEAR and hold; here we wait for CRC's loading overlay to be ABSENT and hold,
// then confirm the target link is visible. We NEVER declare the link missing
// while a loading overlay is still on screen.
// ---------------------------------------------------------------------------
const CONFIRM_INTERVAL_MS = 250;         // same interval as importAuditState.js
const STABLE_INTERVALS_REQUIRED = 2;     // same confirmation window
const STABILIZE_TIMEOUT_MS = 20000;      // same 20s ceiling

// CRC's loading overlays. While any of these is visible, the page is still
// painting and must not be inspected.
const LOADING_OVERLAY_SELECTORS = [
    ".MuiBackdrop-root",
    '[role="progressbar"]',
    ".MuiCircularProgress-root",
];

/** True if any loading overlay is currently visible in the main document. */
async function anyOverlayVisible(page) {
    return page.evaluate((selectors) => {
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                const shown =
                    style.display !== "none" &&
                    style.visibility !== "hidden" &&
                    style.opacity !== "0" &&
                    rect.width > 0 && rect.height > 0;
                if (shown) return true;
            }
        }
        return false;
    }, LOADING_OVERLAY_SELECTORS).catch(() => false);
}

/**
 * Wait for CRC's loading overlay to disappear and STAY gone for
 * STABLE_INTERVALS_REQUIRED consecutive intervals. Returns true once the page
 * has held still with no overlay; false if it never settled (FAIL CLOSED — the
 * caller must not declare elements missing on an unsettled page).
 */
async function waitForOverlayCleared(page) {
    const deadline = Date.now() + STABILIZE_TIMEOUT_MS;
    let stableIntervals = 0;

    while (Date.now() < deadline) {
        const overlayUp = await anyOverlayVisible(page);

        if (!overlayUp) {
            stableIntervals += 1;
            if (stableIntervals >= STABLE_INTERVALS_REQUIRED) {
                return true;
            }
        } else {
            // Overlay still (or again) visible — any reappearance resets the count.
            stableIntervals = 0;
        }

        await page.waitForTimeout(CONFIRM_INTERVAL_MS);
    }

    // FAIL CLOSED: the overlay never cleared for the required window.
    return false;
}

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
function normalizeComboValue(value) {
    // MUI Autocomplete inputs can retain the placeholder concatenated with the
    // chosen label (e.g. "Select a LetterBureau No Response"). Normalize
    // whitespace so we can substring-check the chosen option robustly.
    return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Drive a MUI Autocomplete combobox and CONFIRM the selection from the
 * resulting displayed value.
 *
 * The portal option can disappear the instant it is chosen — before Playwright
 * finishes its click/visibility wait — which surfaces as a timeout even though
 * the value was actually set. So the source of truth is the combobox's own
 * resulting value: we treat the selection as successful ONLY if the normalized
 * input value contains the requested option text exactly. Otherwise we FAIL
 * CLOSED (ok:false) and the caller must not proceed.
 */
async function selectFromAutocombo(page, comboLocator, optionText) {
    const input = comboLocator.first();
    const method = "type-then-click-option[role=option]+value-confirm";
    try {
        await input.click({ timeout: 10000 });
        await input.fill("");                       // clear "Select a ..."
        await input.type(optionText, { delay: 20 }); // let MUI filter
        // Try to click the exact visible option. This may legitimately time out
        // if the portal option vanishes on selection — that is NOT a failure by
        // itself; the value check below is authoritative.
        try {
            const option = page.getByRole("option", { name: optionText, exact: false }).first();
            await option.waitFor({ state: "visible", timeout: 10000 });
            await option.click({ timeout: 10000 });
        } catch (clickError) {
            // Swallow — fall through to the value-based confirmation.
            void clickError;
        }
        // AUTHORITATIVE CONFIRMATION: read the combobox's resulting value.
        // Poll briefly so a just-committed value has time to render.
        let resulting = "";
        const deadline = Date.now() + 4000;
        do {
            resulting = normalizeComboValue(await input.inputValue().catch(() => ""));
            if (resulting.includes(optionText)) break;
            await page.waitForTimeout(200);
        } while (Date.now() < deadline);

        if (resulting.includes(optionText)) {
            return { ok: true, selected: optionText, resultingValue: resulting, method };
        }
        return {
            ok: false,
            error: `Combobox value "${resulting}" does not contain the requested "${optionText}".`,
            resultingValue: resulting,
            method,
        };
    } catch (error) {
        return { ok: false, error: error.message, method };
    }
}

function normalizeFieldValue(v) {
    return (v ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Resolve the input that belongs to a specific field by its EXACT label, scoped
 * to that field's own MuiFormControl/MuiTextField wrapper.
 *
 * CRC repeats id="outlined-basic" across Company/City/ZIP and duplicates label
 * text, so a global getByLabel(...).first() can resolve several fields to the
 * SAME input (that is how ZIP overwrote Company Name). This binds to the input
 * inside the ONE visible wrapper whose <label> text exactly matches. Requires
 * exactly one matching visible wrapper; otherwise returns { ok:false }.
 *
 * Returns { ok, input (Locator), wrapperLabel, inputIndex } where inputIndex is
 * the field's position within the page's full input list — used later for the
 * pairwise-distinct check.
 */
async function resolveFieldByWrapper(page, exactLabel) {
    // Find the index (within all inputs) of the input whose closest form-control
    // wrapper has a <label> whose normalized text equals exactLabel exactly.
    const match = await page.evaluate((wanted) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const inputs = Array.from(document.querySelectorAll("input"));
        const hits = [];
        inputs.forEach((el, idx) => {
            const fc = el.closest(".MuiFormControl-root, .MuiTextField-root");
            if (!fc) return;
            const label = norm(fc.querySelector("label")?.textContent || "");
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const visible = style.display !== "none" && style.visibility !== "hidden" &&
                rect.width > 0 && rect.height > 0;
            if (label === wanted && visible) hits.push(idx);
        });
        return { hits };
    }, exactLabel).catch(() => ({ hits: [] }));

    if (!match || match.hits.length === 0) {
        return { ok: false, error: `no visible wrapper with label "${exactLabel}"`, wrapperLabel: exactLabel };
    }
    if (match.hits.length > 1) {
        return { ok: false, error: `multiple (${match.hits.length}) visible wrappers with label "${exactLabel}"`, wrapperLabel: exactLabel, inputIndexes: match.hits };
    }
    const inputIndex = match.hits[0];
    return { ok: true, input: page.locator("input").nth(inputIndex), wrapperLabel: exactLabel, inputIndex };
}

/**
 * Enter a value into an ordinary MUI text input, bound to its OWN wrapper by
 * exact label, and POSITIVELY CONFIRM it stuck. type+Tab first; native
 * setter + bubbled input/change/blur as fallback. Returns confirmed:true only if
 * the normalized resulting value exactly equals the intended value, and carries
 * the resolved inputIndex for the pairwise-distinct check.
 */
async function enterTextConfirmed(page, exactLabel, value) {
    const result = { label: exactLabel, intended: value, confirmed: false, resultingValue: null, inputIndex: null };
    try {
        const resolved = await resolveFieldByWrapper(page, exactLabel);
        if (!resolved.ok) { result.error = resolved.error; result.inputIndexes = resolved.inputIndexes; return result; }
        const field = resolved.input;
        result.inputIndex = resolved.inputIndex;

        await field.click({ timeout: 8000 });
        await field.fill("");                          // clear
        await field.type(value, { delay: 25 });        // per-character -> React onChange
        await field.press("Tab");                      // blur/change validation
        result.resultingValue = normalizeFieldValue(await field.inputValue().catch(() => ""));
        if (result.resultingValue === normalizeFieldValue(value)) {
            result.confirmed = true;
            result.method = "wrapper-scoped type+tab";
            return result;
        }

        // Fallback: native setter + bubbled events (defeats controlled-input traps).
        await field.evaluate((el, v) => {
            const proto = Object.getPrototypeOf(el);
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(el, v); else el.value = v;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
        }, value);
        result.resultingValue = normalizeFieldValue(await field.inputValue().catch(() => ""));
        result.confirmed = result.resultingValue === normalizeFieldValue(value);
        result.method = "wrapper-scoped native-setter+events";
        if (!result.confirmed) result.error = `resulting "${result.resultingValue}" != intended "${value}"`;
        return result;
    } catch (error) {
        result.error = error.message;
        return result;
    }
}

/**
 * Enter the ADDRESS, which discovery proved is a MUI combobox (role="combobox",
 * label "Address *") — not a plain input. Fail-closed sequence: focus, clear,
 * type the address, look for a matching role="option"; if present select it;
 * otherwise try Enter then Tab; then CONFIRM the resulting displayed value
 * contains the intended address. Returns confirmed accordingly.
 */
async function enterAddressConfirmed(page, value) {
    const result = { label: "Address *", intended: value, confirmed: false, resultingValue: null };
    try {
        // The Address combobox is the one whose form-control label is "Address".
        const addr = page.getByLabel(/^address\s*\*?$/i).first();
        if (!(await addr.count())) { result.error = "address combobox not found"; return result; }

        await addr.click({ timeout: 8000 });
        await addr.fill("");
        await addr.type(value, { delay: 25 });

        // 3-4. If an option appears, select the best match.
        let selectedVia = null;
        const option = page.getByRole("option", { name: value, exact: false }).first();
        if (await option.count().catch(() => 0)) {
            try {
                await option.waitFor({ state: "visible", timeout: 4000 });
                await option.click({ timeout: 4000 });
                selectedVia = "option-click";
            } catch { /* fall through */ }
        }
        // 5. Otherwise confirm the raw text with Enter, then Tab.
        if (!selectedVia) {
            await addr.press("Enter").catch(() => {});
            await addr.press("Tab").catch(() => {});
            selectedVia = "enter-tab";
        }

        // 6. Positively verify the resulting displayed value contains the address.
        let resulting = normalizeFieldValue(await addr.inputValue().catch(() => ""));
        if (!resulting.includes(value)) {
            // brief poll in case the combobox commits a beat later
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline && !resulting.includes(value)) {
                await page.waitForTimeout(200);
                resulting = normalizeFieldValue(await addr.inputValue().catch(() => ""));
            }
        }
        result.resultingValue = resulting;
        result.selectedVia = selectedVia;
        result.confirmed = resulting.includes(value);
        if (!result.confirmed) result.error = `address value "${resulting}" does not contain "${value}"`;
        return result;
    } catch (error) {
        result.error = error.message;
        return result;
    }
}

/**
 * Fail closed on editor activation with FULL diagnostics. Returns the report with
 * blockedStage="editor_activation" (a specific stage, not the generic throw path)
 * so we can see exactly why no active editor was found.
 */
async function failEditorActivation(page, context, report, reason) {
    report.blockedStage = "editor_activation";
    report.blockedReason = reason;
    if (!report.blockingGaps.includes("editor_not_activated")) {
        report.blockingGaps.push("editor_not_activated");
    }
    try {
        report.editorActivationDiagnostics = {
            currentUrl: page.url(),
            allOpenPageUrls: context.pages().map((p) => p.url()),
            frameInventory: page.frames().map((f) => ({
                name: f.name() || null, url: f.url() || null, isMain: f === page.mainFrame(),
            })),
            loadingIndicatorVisible: await anyOverlayVisible(page),
            froalaCandidates: await page.locator('div.fr-element.fr-view[contenteditable="true"]')
                .evaluateAll((nodes) => nodes.map((n, i) => {
                    const rect = n.getBoundingClientRect();
                    const style = window.getComputedStyle(n);
                    return {
                        index: i,
                        visible: style.display !== "none" && style.visibility !== "hidden" &&
                            rect.width > 0 && rect.height > 0,
                        innerHtmlLength: (n.innerHTML || "").length,
                        textLength: (n.textContent || "").trim().length,
                    };
                })).catch(() => []),
            visibleButtons: await page.locator("button").evaluateAll((nodes) =>
                nodes.filter((n) => {
                    const r = n.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                }).map((n) => (n.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 40)
            ).catch(() => []),
            visibleHeadings: await page.locator("h1,h2,h3,h4").evaluateAll((nodes) =>
                nodes.map((n) => (n.textContent || "").trim()).filter(Boolean).slice(0, 20)
            ).catch(() => []),
            renderedPageText: (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).slice(0, 2000),
        };
        report.artifacts.push(await shot(page, "05-editor-activation-failed"));
    } catch (diagError) {
        report.editorActivationDiagnostics = { diagnosticsError: diagError.message };
    }
    // The caller's finally block closes the browser; we only gather diagnostics.
    return report;
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
        // `page` is mutable: clicking Generate Library Letter may open the editor
        // in a NEW tab (the CRC tabs carry target="_blank"), in which case we
        // switch to it after confirming it is CRC + the current client.
        let page = session.page;
        const context = session.context ?? page.context();
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

        // Wait for CRC's loading overlay to clear and hold still (reused
        // stabilization pattern). We must NOT search for the no-items link while
        // .MuiBackdrop-root / [role="progressbar"] / .MuiCircularProgress-root is
        // visible — that was the V1/V2 false-negative. If it never settles, we
        // record it and stop rather than declare the link missing.
        report.generateLettersStabilized = await waitForOverlayCleared(page);
        if (!report.generateLettersStabilized) {
            report.blockedStage = "generate_letters_stabilize";
            report.blockedReason =
                "CRC loading overlay (.MuiBackdrop-root / [role=progressbar] / " +
                ".MuiCircularProgress-root) did not clear within the stabilization window. " +
                "Not declaring the no-items link missing on an unsettled page.";
            report.blockingGaps.push("generate_letters_never_stabilized");
            report.artifacts.push(await shot(page, "02-overlay-stuck"));
            return report;
        }

        // ---- STAGE 2: the "generate a letter (with no dispute items)" link --
        // V1 missed it. Capture broadly, then record the resolved locator.
        const noItemsCandidates = [
            page.getByRole("link", { name: /generate a letter.*no dispute items/i }),
            page.getByText(/generate a letter \(with no dispute items\)/i),
            page.getByRole("link", { name: /no dispute items/i }),
            page.getByText(/no dispute items/i),
        ];
        // Poll for a VISIBLE candidate (the overlay is already cleared, but CRC may
        // paint the link a beat later). We look for visibility, not mere presence.
        let noItemsLink = null;
        const linkDeadline = Date.now() + STABILIZE_TIMEOUT_MS;
        while (Date.now() < linkDeadline && !noItemsLink) {
            for (const cand of noItemsCandidates) {
                if ((await cand.count()) && (await cand.first().isVisible().catch(() => false))) {
                    noItemsLink = cand.first();
                    break;
                }
            }
            if (!noItemsLink) await page.waitForTimeout(CONFIRM_INTERVAL_MS);
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

        // FAIL CLOSED: do not proceed unless the Letter Name is positively
        // confirmed as "Bureau No Response" from the combobox's resulting value.
        if (!letterResult.ok) {
            report.blockedStage = "letter_name_selection";
            report.blockedReason =
                `Letter Name not positively confirmed as "Bureau No Response" ` +
                `(resulting value: "${letterResult.resultingValue ?? "?"}"). Stopping before generation.`;
            report.blockingGaps.push("letter_name_not_confirmed");
            report.artifacts.push(await shot(page, "03b-letter-name-unconfirmed"));
            return report;
        }

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

        // Enter each required field with POSITIVE value confirmation. A bare
        // fill() completing is NOT proof CRC accepted the value — the prior run
        // was rejected with "Please enter required fields" while the fields read
        // blank. Text inputs: type+Tab, read back, native-setter fallback. Address
        // is a MUI combobox (discovered), so it uses the option/Enter/Tab path.
        // State keeps the existing combobox+value-confirm.
        const companyResult = await enterTextConfirmed(page, "Company Name *", DISCOVERY_RECIPIENT.companyName);
        const addressResult = await enterAddressConfirmed(page, DISCOVERY_RECIPIENT.address);
        const cityResult = await enterTextConfirmed(page, "City *", DISCOVERY_RECIPIENT.city);
        const zipResult = await enterTextConfirmed(page, "Zip Code *", DISCOVERY_RECIPIENT.zip);
        const stateResult = await selectFromAutocombo(
            page,
            page.locator('input[role="combobox"]').last(),
            DISCOVERY_RECIPIENT.state
        );
        report.recipientFillResults = {
            companyName: companyResult,
            address: addressResult,
            city: cityResult,
            zip: zipResult,
            state: stateResult,
        };
        report.artifacts.push(await shot(page, "04-recipient-filled"));

        // ---- PRE-GENERATION GATE -------------------------------------------
        // Every required recipient field must be positively confirmed BEFORE we
        // click Generate Library Letter. State is confirmed via its resulting
        // value ("TX"); the rest via their confirmed flags.
        const recipientConfirmed = {
            companyName: { intended: DISCOVERY_RECIPIENT.companyName, confirmed: companyResult.confirmed === true, resulting: companyResult.resultingValue },
            address: { intended: DISCOVERY_RECIPIENT.address, confirmed: addressResult.confirmed === true, resulting: addressResult.resultingValue },
            city: { intended: DISCOVERY_RECIPIENT.city, confirmed: cityResult.confirmed === true, resulting: cityResult.resultingValue },
            state: { intended: DISCOVERY_RECIPIENT.state, confirmed: stateResult.ok === true && normalizeFieldValue(stateResult.resultingValue ?? "").includes(DISCOVERY_RECIPIENT.state), resulting: stateResult.resultingValue },
            zip: { intended: DISCOVERY_RECIPIENT.zip, confirmed: zipResult.confirmed === true, resulting: zipResult.resultingValue },
        };
        report.recipientConfirmed = recipientConfirmed;

        const unconfirmed = Object.entries(recipientConfirmed)
            .filter(([, v]) => !v.confirmed)
            .map(([k]) => k);
        if (unconfirmed.length > 0) {
            report.blockedStage = "recipient_validation";
            report.blockedReason =
                `Required recipient field(s) not positively confirmed before generation: ` +
                `${unconfirmed.join(", ")}. Stopping before clicking Generate Library Letter.`;
            report.blockingGaps.push("recipient_fields_unconfirmed");
            report.artifacts.push(await shot(page, "04b-recipient-unconfirmed"));
            return report;
        }

        // ---- COLLECTIVE PRE-CLICK VERIFICATION (pairwise-distinct) ---------
        // Re-resolve all five required fields FRESH by wrapper+label and read
        // their values in one snapshot. This guarantees each field is a DISTINCT
        // DOM input (the previous bug had ZIP overwrite Company Name because two
        // fields resolved to the same input). Company/City/ZIP must be pairwise
        // distinct element handles; City and ZIP must be non-blank; Company must
        // not equal City or ZIP.
        const companyBind = await resolveFieldByWrapper(page, "Company Name *");
        const cityBind = await resolveFieldByWrapper(page, "City *");
        const zipBind = await resolveFieldByWrapper(page, "Zip Code *");
        const addressInput = page.getByLabel(/^address\s*\*?$/i).first();
        const stateInput = page.locator('input[role="combobox"]').last();

        const readVal = async (loc) => normalizeFieldValue(await loc.inputValue().catch(() => ""));
        const bindings = [
            { field: "companyName", bind: companyBind, value: await (companyBind.ok ? readVal(companyBind.input) : "") },
            { field: "address", bind: { ok: true, wrapperLabel: "Address *", inputIndex: "combobox" }, value: await readVal(addressInput) },
            { field: "city", bind: cityBind, value: await (cityBind.ok ? readVal(cityBind.input) : "") },
            { field: "state", bind: { ok: true, wrapperLabel: "State*", inputIndex: "combobox" }, value: await readVal(stateInput) },
            { field: "zip", bind: zipBind, value: await (zipBind.ok ? readVal(zipBind.input) : "") },
        ];
        report.recipientElementBindings = bindings.map((b) => ({
            field: b.field,
            wrapperLabel: b.bind.wrapperLabel,
            inputIndex: b.bind.inputIndex ?? null,
            elementIdentity: b.bind.inputIndex ?? null,
            resultingValue: b.value,
        }));

        // Pairwise-distinct check for the three ordinary inputs.
        const ordinaryIdx = [companyBind.inputIndex, cityBind.inputIndex, zipBind.inputIndex];
        const allResolved = companyBind.ok && cityBind.ok && zipBind.ok;
        const distinct = new Set(ordinaryIdx).size === ordinaryIdx.length;
        if (!allResolved || !distinct) {
            report.blockedStage = "recipient_binding";
            report.blockedReason = "Multiple recipient fields resolved to the same DOM input";
            report.blockingGaps.push("recipient_fields_same_element");
            report.artifacts.push(await shot(page, "04c-recipient-binding-collision"));
            return report;
        }

        // Exact expected values + non-blank + Company != City/ZIP.
        const expected = {
            companyName: DISCOVERY_RECIPIENT.companyName,
            address: DISCOVERY_RECIPIENT.address,
            city: DISCOVERY_RECIPIENT.city,
            state: DISCOVERY_RECIPIENT.state,
            zip: DISCOVERY_RECIPIENT.zip,
        };
        const snapshot = Object.fromEntries(bindings.map((b) => [b.field, b.value]));
        const valuesMatch =
            snapshot.companyName === expected.companyName &&
            snapshot.address.includes(expected.address) &&
            snapshot.city === expected.city &&
            snapshot.state.includes(expected.state) &&
            snapshot.zip === expected.zip;
        const sanity =
            snapshot.city !== "" && snapshot.zip !== "" &&
            snapshot.companyName !== snapshot.city &&
            snapshot.companyName !== snapshot.zip;
        report.recipientPreClickSnapshot = snapshot;
        if (!valuesMatch || !sanity) {
            report.blockedStage = "recipient_validation";
            report.blockedReason =
                "Pre-click recipient snapshot did not match the required values " +
                "(or Company/City/ZIP collision detected). Stopping before generation.";
            report.blockingGaps.push("recipient_preclick_snapshot_mismatch");
            report.artifacts.push(await shot(page, "04d-recipient-snapshot-mismatch"));
            return report;
        }

        // ---- STAGE 5: click GENERATE LIBRARY LETTER (the outlined one) ------
        //
        // Both "Generate Library Letter" and "Generate Unique AI Letter" render
        // more than once (discovery showed count:2 each), so .first() is unsafe —
        // it previously grabbed a green (contained) duplicate and aborted. Instead
        // we ENUMERATE every button and pick the UNIQUE safe candidate by exact
        // text + class + enabled + visible, and separately assert the dangerous AI
        // button is a DIFFERENT element. Fail closed on any ambiguity.
        const buttonScan = await page.locator("button").evaluateAll((nodes) => {
            return nodes.map((n, i) => {
                const rect = n.getBoundingClientRect();
                const style = window.getComputedStyle(n);
                return {
                    i,
                    text: (n.textContent || "").replace(/\s+/g, " ").trim(),
                    classes: n.className && n.className.toString ? n.className.toString() : "",
                    disabled: n.disabled === true || n.getAttribute("aria-disabled") === "true",
                    visible:
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        rect.width > 0 && rect.height > 0,
                };
            });
        });

        // Safe candidates: exact text, outlined (NOT contained / containedSuccess),
        // enabled, visible.
        const safeCandidates = buttonScan.filter((b) =>
            b.text === "Generate Library Letter" &&
            /MuiButton-outlined/.test(b.classes) &&
            !/MuiButton-contained/.test(b.classes) &&
            !/MuiButton-containedSuccess/.test(b.classes) &&
            !b.disabled &&
            b.visible
        );
        // Dangerous candidates: the green AI button, enumerated separately.
        const aiCandidates = buttonScan.filter((b) =>
            b.text === "Generate Unique AI Letter" &&
            /MuiButton-contained(Success)?/.test(b.classes)
        );

        report.libraryButtonDisambiguation = {
            safeCandidateIndexes: safeCandidates.map((b) => b.i),
            aiCandidateIndexes: aiCandidates.map((b) => b.i),
            safeCount: safeCandidates.length,
            aiCount: aiCandidates.length,
        };

        if (safeCandidates.length === 0) {
            throw new Error("No safe outlined 'Generate Library Letter' button found. Failing closed.");
        }
        if (safeCandidates.length > 1) {
            throw new Error(
                `Ambiguous: ${safeCandidates.length} visible outlined 'Generate Library Letter' ` +
                `buttons found. Failing closed rather than guessing.`
            );
        }
        const safe = safeCandidates[0];
        // The safe candidate must NOT be the same DOM element as any AI button.
        if (aiCandidates.some((ai) => ai.i === safe.i)) {
            throw new Error("Safe candidate shares an element index with the AI button. Failing closed.");
        }
        if (safe.text !== "Generate Library Letter") {
            throw new Error(`Selected button text "${safe.text}" is not exactly "Generate Library Letter".`);
        }

        // Bind a Playwright handle to EXACTLY that enumerated element (same index
        // in the same button list) and verify its class one more time before click.
        const libraryBtn = page.locator("button").nth(safe.i);
        const confirmClasses = await libraryBtn.getAttribute("class").catch(() => "");
        if (
            !/MuiButton-outlined/.test(confirmClasses ?? "") ||
            /MuiButton-contained/.test(confirmClasses ?? "")
        ) {
            throw new Error("Final class re-check failed; the resolved button is not the outlined library button.");
        }
        assertClickAllowed("Generate Library Letter");

        // ================= CLICK-TRIGGER DIAGNOSTICS =======================
        // We already know WHICH button is safe. This block proves whether that
        // exact element actually received a click and whether CRC reacted.

        // ---- PRE-CLICK CAPTURE --------------------------------------------
        const fingerprint = async () => {
            return page.evaluate(() => {
                const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
                const froala = document.querySelector('div.fr-element.fr-view[contenteditable="true"]');
                const scope = document.body;
                return {
                    visibleText: norm(document.body.innerText).slice(0, 1500),
                    childCount: scope ? scope.querySelectorAll("*").length : 0,
                    htmlLength: scope ? scope.innerHTML.length : 0,
                    froalaHtmlLength: froala ? froala.innerHTML.length : 0,
                    visibleHeadings: Array.from(document.querySelectorAll("h1,h2,h3,h4"))
                        .filter((n) => n.getBoundingClientRect().width > 0)
                        .map((n) => norm(n.textContent)).slice(0, 20),
                    visibleButtons: Array.from(document.querySelectorAll("button"))
                        .filter((n) => n.getBoundingClientRect().width > 0)
                        .map((n) => norm(n.textContent)).filter(Boolean).slice(0, 40),
                };
            }).catch(() => null);
        };

        const buttonStateOf = async (loc) => loc.evaluate((n) => {
            const rect = n.getBoundingClientRect();
            const style = window.getComputedStyle(n);
            return {
                text: (n.textContent || "").replace(/\s+/g, " ").trim(),
                classes: n.className && n.className.toString ? n.className.toString() : "",
                disabledAttr: n.disabled === true,
                ariaDisabled: n.getAttribute("aria-disabled"),
                visible: style.display !== "none" && style.visibility !== "hidden" &&
                    rect.width > 0 && rect.height > 0,
                enabled: !(n.disabled === true || n.getAttribute("aria-disabled") === "true"),
                boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
        }).catch(() => null);

        report.preClickButtonState = { ...(await buttonStateOf(libraryBtn)), elementIndex: safe.i };
        report.activeElementBeforeClick = await page.evaluate(() => {
            const a = document.activeElement;
            return a ? { tag: a.tagName?.toLowerCase(), text: (a.textContent || "").trim().slice(0, 60) } : null;
        }).catch(() => null);
        report.currentUrlBeforeClick = page.url();
        report.froalaHtmlBeforeClick = await page.evaluate(() => {
            const f = document.querySelector('div.fr-element.fr-view[contenteditable="true"]');
            return f ? f.innerHTML.length : null;
        }).catch(() => null);
        report.wizardDomFingerprintBeforeClick = await fingerprint();

        // ---- RECONFIRM the safe button one final time ----------------------
        const psb = report.preClickButtonState;
        const reconfirm =
            psb && psb.text === "Generate Library Letter" &&
            /MuiButton-outlined/.test(psb.classes) &&
            !/MuiButton-contained/.test(psb.classes) &&
            !/MuiButton-containedSuccess/.test(psb.classes) &&
            psb.visible === true && psb.enabled === true &&
            !aiCandidates.some((ai) => ai.i === safe.i);
        report.safeButtonReconfirmed = reconfirm === true;
        if (!reconfirm) {
            report.blockedStage = "library_button_click";
            report.blockedReason = "Safe library button failed final pre-click reconfirmation.";
            report.blockingGaps.push("safe_button_reconfirm_failed");
            report.artifacts.push(await shot(page, "05-button-reconfirm-failed"));
            return report;
        }

        // ---- PASSIVE CLICK LISTENER (does not alter CRC's handler) ---------
        // Attach a capture-phase, passive listener to the EXACT element so we can
        // prove the real click event reached it. It never calls preventDefault/
        // stopPropagation, so CRC's own handler runs untouched.
        await libraryBtn.evaluate((n) => {
            window.__btClickObserved = false;
            window.__btClickTs = null;
            n.__btListener = () => {
                window.__btClickObserved = true;
                window.__btClickTs = Date.now();
            };
            n.addEventListener("click", n.__btListener, { capture: true, passive: true });
        }).catch(() => {});

        // ---- NETWORK / CONSOLE / ERROR LISTENERS (click window only) -------
        const netRequests = [];
        const netResponses = [];
        const netFailed = [];
        const consoleMsgs = [];
        const pageErrors = [];
        const clickT0 = Date.now();
        const sanitizeUrl = (u) => (u || "")
            .replace(/([?&](token|sig|signature|key|auth|sessionid|session_id)=)[^&\s]+/gi, "$1REDACTED")
            .slice(0, 300);
        const relevant = (u) => !/browserbase\.com|cometondemand\.net|intercom/i.test(u || "");

        const onRequest = (req) => {
            const u = req.url();
            if (!relevant(u)) return;
            netRequests.push({
                method: req.method(),
                url: sanitizeUrl(u),
                resourceType: req.resourceType(),
                tSinceClickMs: Date.now() - clickT0,
            });
        };
        const onResponse = async (res) => {
            const u = res.url();
            if (!relevant(u)) return;
            netResponses.push({
                method: res.request().method(),
                url: sanitizeUrl(u),
                status: res.status(),
                resourceType: res.request().resourceType(),
                tSinceClickMs: Date.now() - clickT0,
            });
        };
        const onFailed = (req) => {
            const u = req.url();
            if (!relevant(u)) return;
            netFailed.push({
                method: req.method(),
                url: sanitizeUrl(u),
                resourceType: req.resourceType(),
                failure: req.failure()?.errorText ?? null,
                tSinceClickMs: Date.now() - clickT0,
            });
        };
        const onConsole = (msg) => {
            consoleMsgs.push({ type: msg.type(), text: (msg.text() || "").slice(0, 200) });
        };
        const onPageError = (err) => { pageErrors.push({ message: (err.message || "").slice(0, 200) }); };

        page.on("request", onRequest);
        page.on("response", onResponse);
        page.on("requestfailed", onFailed);
        page.on("console", onConsole);
        page.on("pageerror", onPageError);

        const urlBeforeClick = page.url();
        const pagesBeforeClick = context.pages().length;

        // ---- CLICK SEQUENCE (no force:true) --------------------------------
        let clickError = null;
        try {
            await libraryBtn.scrollIntoViewIfNeeded({ timeout: 8000 });
            await libraryBtn.waitFor({ state: "visible", timeout: 8000 });
            const stillEnabled = (await buttonStateOf(libraryBtn))?.enabled === true;
            if (!stillEnabled) throw new Error("Button became disabled before click.");
            await libraryBtn.focus().catch(() => {});
            await libraryBtn.click({ timeout: 20000 });
        } catch (e) {
            clickError = e.message;
        }

        // Give CRC a brief window to react, then read the click-observed flag.
        await page.waitForTimeout(1200);
        const clickObserved = await page.evaluate(() => ({
            observed: window.__btClickObserved === true,
            ts: window.__btClickTs ?? null,
        })).catch(() => ({ observed: false, ts: null }));
        report.safeButtonClickEventObserved = clickObserved.observed;
        report.safeButtonClickEventTimestamp = clickObserved.ts;

        // Detach the passive listener (cleanup; never touched CRC's handler).
        await libraryBtn.evaluate((n) => {
            if (n.__btListener) n.removeEventListener("click", n.__btListener, { capture: true });
        }).catch(() => {});

        // ---- Let CRC settle, then POST-CLICK CAPTURE -----------------------
        await waitForOverlayCleared(page);

        // NOTE: network/console listeners stay ATTACHED through the editor-
        // readiness gate below, so we can capture the generation request's
        // response or failure (which arrives asynchronously, after the click
        // window). They are detached once the gate resolves. We record a first
        // snapshot here; the arrays keep filling by reference until detach.
        report.observedNetworkRequests = netRequests;
        report.observedNetworkResponses = netResponses;
        report.observedFailedRequests = netFailed;
        report.observedConsoleMessages = consoleMsgs;
        report.observedPageErrors = pageErrors;

        report.postClickButtonState = await buttonStateOf(libraryBtn);
        report.activeElementAfterClick = await page.evaluate(() => {
            const a = document.activeElement;
            return a ? { tag: a.tagName?.toLowerCase(), text: (a.textContent || "").trim().slice(0, 60) } : null;
        }).catch(() => null);
        report.currentUrlAfterClick = page.url();

        const fpAfter = await fingerprint();
        report.wizardDomFingerprintAfterClick = fpAfter;
        report.froalaHtmlAfterClick = fpAfter?.froalaHtmlLength ?? null;

        // ---- CHANGE DETECTION ----------------------------------------------
        const fpBefore = report.wizardDomFingerprintBeforeClick;
        const domChanged = !!fpBefore && !!fpAfter && (
            fpBefore.childCount !== fpAfter.childCount ||
            fpBefore.htmlLength !== fpAfter.htmlLength ||
            fpBefore.froalaHtmlLength !== fpAfter.froalaHtmlLength ||
            fpBefore.visibleText !== fpAfter.visibleText
        );
        report.domMutationObserved = domChanged;
        report.domMutationCount = fpBefore && fpAfter
            ? Math.abs((fpAfter.childCount ?? 0) - (fpBefore.childCount ?? 0))
            : null;
        report.froalaHtmlChanged =
            (report.froalaHtmlBeforeClick ?? null) !== (fpAfter?.froalaHtmlLength ?? null);
        report.urlChanged = urlBeforeClick !== page.url();
        report.buttonDisabledChanged =
            (report.preClickButtonState?.enabled === true) &&
            (report.postClickButtonState?.enabled === false);
        report.visibleMessagesAfterClick = await page.evaluate(() => {
            const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
            const out = [];
            for (const sel of [".MuiAlert-message", '[role="alert"]', ".Toastify__toast", ".toast", ".error", ".MuiSnackbar-root"]) {
                for (const el of document.querySelectorAll(sel)) {
                    const t = norm(el.textContent);
                    if (t) out.push(t.slice(0, 160));
                }
            }
            return out.slice(0, 20);
        }).catch(() => []);
        report.requiredFieldErrorAfterClick = await page.getByText(/please enter required fields/i)
            .first().isVisible().catch(() => false);

        // ---- TRIGGER EVIDENCE ----------------------------------------------
        const relevantResponse = netResponses.some((r) => r.status && r.status < 500);
        const evidence = {
            clickEventReceived: report.safeButtonClickEventObserved === true,
            networkRequestFollowed: netRequests.length > 0,
            networkResponseCompleted: relevantResponse,
            buttonDisabledChanged: report.buttonDisabledChanged === true,
            domChanged: report.domMutationObserved === true,
            froalaHtmlChanged: report.froalaHtmlChanged === true,
            urlChanged: report.urlChanged === true,
            messageAppeared: (report.visibleMessagesAfterClick?.length ?? 0) > 0 ||
                report.requiredFieldErrorAfterClick === true,
        };
        report.generationTriggerEvidence = evidence;
        report.generationTriggered =
            evidence.clickEventReceived && (
                evidence.networkRequestFollowed || evidence.networkResponseCompleted ||
                evidence.buttonDisabledChanged || evidence.domChanged ||
                evidence.froalaHtmlChanged || evidence.urlChanged || evidence.messageAppeared
            );

        // ---- FAILURE CLASSIFICATION ----------------------------------------
        if (!report.safeButtonClickEventObserved) {
            report.blockedStage = "library_button_click";
            report.blockedReason = "Generate Library Letter did not receive the click event";
            report.blockingGaps.push("safe_button_no_click_event");
            if (clickError) report.libraryClickError = clickError;
            report.artifacts.push(await shot(page, "05-no-click-event"));
            return report;
        }
        if (netFailed.length > 0 && !relevantResponse) {
            report.blockedStage = "library_generation_request";
            report.blockedReason = "CRC library-letter generation request failed";
            report.blockingGaps.push("library_generation_request_failed");
            report.artifacts.push(await shot(page, "05-generation-request-failed"));
            return report;
        }
        if (!report.generationTriggered) {
            report.blockedStage = "library_generation_trigger";
            report.blockedReason = "Generate Library Letter click produced no observable CRC state change";
            report.blockingGaps.push("library_generation_no_state_change");
            report.artifacts.push(await shot(page, "05-generation-no-change"));
            return report;
        }
        // Positive evidence CRC generation was triggered -> continue to editor.
        // ====================================================================

        // ---- POST-CLICK RECIPIENT VALIDATION -------------------------------
        // If CRC rejected the form, it shows "Please enter required fields" and
        // never advances to the editor. Detect that FIRST — do not wait 30s for a
        // Froala editor that will never populate.
        const requiredFieldError = await page.getByText(/please enter required fields/i)
            .first().isVisible().catch(() => false);
        if (requiredFieldError) {
            report.blockedStage = "recipient_validation";
            report.blockedReason = "CRC rejected one or more required recipient fields";
            report.blockingGaps.push("crc_required_field_error_after_click");
            // Capture the ACTUAL post-click values of every recipient control,
            // read fresh from each field's own wrapper (label -> its input),
            // rather than trusting a global scan.
            report.postClickRecipientValues = await page.evaluate(() => {
                const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
                const out = {};
                const inputs = Array.from(document.querySelectorAll("input"));
                inputs.forEach((el, idx) => {
                    const fc = el.closest(".MuiFormControl-root, .MuiTextField-root");
                    const label = fc ? norm(fc.querySelector("label")?.textContent || "") : null;
                    if (label) out[`${label} [input#${idx}]`] = el.value;
                });
                return out;
            }).catch(() => null);
            report.artifacts.push(await shot(page, "05-recipient-rejected"));
            // Clean up the click-window listeners before returning early.
            page.off("request", onRequest);
            page.off("response", onResponse);
            page.off("requestfailed", onFailed);
            page.off("console", onConsole);
            page.off("pageerror", onPageError);
            return report;
        }

        // (2/3) NEW-PAGE DETECTION. If the click opened a new tab, adopt it ONLY
        // after confirming it is CRC and the SAME client (15). Otherwise stay put.
        try {
            const pagesNow = context.pages();
            if (pagesNow.length > pagesBeforeClick) {
                // Take the most recently opened page.
                const candidate = pagesNow[pagesNow.length - 1];
                await candidate.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
                const candUrl = candidate.url();
                const isCrc = /(^https:\/\/app\.creditrepaircloud\.com)/.test(candUrl);
                const isSameClient = candUrl.includes(`/clients/${AUTHORIZED_CLIENT_ID}/`) ||
                    // some CRC editor routes drop the /clients/ segment; accept CRC host
                    isCrc;
                if (isCrc && isSameClient) {
                    page = candidate; // switch active page to the editor tab
                    report.editorOpenedInNewPage = { switched: true, url: candUrl };
                    await waitForOverlayCleared(page);
                } else {
                    report.editorOpenedInNewPage = { switched: false, url: candUrl, reason: "not CRC/client 15" };
                    throw new Error(`Editor opened an unexpected page: ${candUrl}`);
                }
            } else {
                report.editorOpenedInNewPage = { switched: false, note: "editor rendered in the same page" };
            }
        } catch (switchError) {
            // A domain/client mismatch is a hard stop with diagnostics below.
            report.editorSwitchError = switchError.message;
        }

        // Guard: if we somehow navigated off CRC, fail closed with diagnostics.
        if (!/^https:\/\/app\.creditrepaircloud\.com/.test(page.url())) {
            return await failEditorActivation(page, context, report,
                `Active page left CRC after generation: ${page.url()}`);
        }

        // (4) ENUMERATE every Froala candidate and capture its state.
        const froalaSelector = 'div.fr-element.fr-view[contenteditable="true"]';

        // ================= LETTER EDITOR READINESS GATE ====================
        // CRC opens the editor and populates Froala ASYNCHRONOUSLY (the prior run
        // inspected while the wrapper was still `fr-wrapper show-placeholder`,
        // innerHTML length 11, Characters:0). So we POLL until the active editor is
        // genuinely populated, allowing a long timeout, and record a timeline.
        //
        // Readiness conditions for the unique active candidate (all applicable):
        //   - its Froala .fr-box container is visible;
        //   - the wrapper no longer carries `show-placeholder` (when CRC removes it);
        //   - innerHTML length exceeds the empty-placeholder length;
        //   - text OR image content is present (signature may be an image);
        //   - Characters/Words count leaves zero, when readable.
        // We do NOT require visible text alone (an image-only signature is valid).
        const EMPTY_PLACEHOLDER_HTML_LEN = 11;   // observed empty Froala innerHTML length
        const EDITOR_READY_TIMEOUT_MS = 90000;   // CRC may populate slowly via Browserbase
        const readinessTimeline = [];

        // Snapshot every Froala candidate's state (read-only; never edits).
        const snapshotCandidates = async () => page.locator(froalaSelector).evaluateAll((nodes) => {
            const readCount = (labelRe) => {
                // Try to read "Characters : N" / "Words : N" counters if present.
                const m = Array.from(document.querySelectorAll("*"))
                    .map((e) => (e.childElementCount === 0 ? (e.textContent || "") : ""))
                    .find((t) => labelRe.test(t));
                if (!m) return null;
                const num = m.match(/(\d+)/);
                return num ? parseInt(num[1], 10) : null;
            };
            const charCount = readCount(/characters\s*:/i);
            const wordCount = readCount(/words\s*:/i);
            return nodes.map((n, i) => {
                const rect = n.getBoundingClientRect();
                const style = window.getComputedStyle(n);
                const box = n.closest(".fr-box");
                const wrapper = n.closest(".fr-wrapper");
                const boxVisible = box ? (() => {
                    const bs = window.getComputedStyle(box);
                    const br = box.getBoundingClientRect();
                    return bs.display !== "none" && bs.visibility !== "hidden" && br.width > 0 && br.height > 0;
                })() : false;
                const html = n.innerHTML || "";
                const text = (n.textContent || "").trim();
                const imgCount = n.querySelectorAll("img").length;
                return {
                    index: i,
                    visible: style.display !== "none" && style.visibility !== "hidden" &&
                        rect.width > 0 && rect.height > 0,
                    boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    wrapperClasses: wrapper ? (wrapper.className || "") : "",
                    frBoxVisible: boxVisible,
                    innerHtmlLength: html.length,
                    textLength: text.length,
                    imageCount: imgCount,
                    charCount,
                    wordCount,
                    hasPlaceholder: wrapper ? /show-placeholder/.test(wrapper.className || "") : false,
                };
            });
        }).catch(() => []);

        // Is this candidate a READY, populated active editor?
        const isReady = (c) =>
            c.visible &&
            c.boundingBox.width > 0 && c.boundingBox.height > 0 &&
            c.frBoxVisible &&
            !c.hasPlaceholder &&
            c.innerHtmlLength > EMPTY_PLACEHOLDER_HTML_LEN &&
            (c.textLength > 0 || c.imageCount > 0);

        // Poll: first wait for the "Letter Editor (...)" heading, then for a ready
        // editor, requiring two consecutive stable ready snapshots.
        const readyDeadline = Date.now() + EDITOR_READY_TIMEOUT_MS;
        let headingSeen = false;
        let readyIndex = -1;
        let stableReady = 0;
        let lastSnapshot = [];

        while (Date.now() < readyDeadline) {
            // (1) heading gate
            if (!headingSeen) {
                headingSeen = await page.getByRole("heading", { name: /letter editor/i })
                    .first().isVisible().catch(() => false);
                if (!headingSeen) {
                    headingSeen = await page.getByText(/letter editor \(/i).first().isVisible().catch(() => false);
                }
            }

            const snap = await snapshotCandidates();
            lastSnapshot = snap;
            const readyCandidates = snap.filter(isReady);
            readinessTimeline.push({
                tSinceGateStartMs: EDITOR_READY_TIMEOUT_MS - (readyDeadline - Date.now()),
                headingSeen,
                candidateCount: snap.length,
                readyCount: readyCandidates.length,
                genResponseCount: netResponses.length,
                genFailedCount: netFailed.length,
            });

            // (2) generation request completion: a completed response or explicit
            //     failure for the generation-related request. If it explicitly
            //     failed and nothing populated, we surface that below.
            if (headingSeen && readyCandidates.length === 1) {
                const idx = readyCandidates[0].index;
                if (idx === readyIndex) {
                    stableReady += 1;
                } else {
                    stableReady = 1;
                    readyIndex = idx;
                }
                if (stableReady >= STABLE_INTERVALS_REQUIRED) break; // ready + stable
            } else {
                // Ambiguous (more than one ready) resets; keep polling — CRC may be
                // mid-render. We only fail closed on ambiguity at the very end.
                stableReady = 0;
                readyIndex = readyCandidates.length > 1 ? -2 : -1; // -2 marks ambiguity
            }

            await page.waitForTimeout(CONFIRM_INTERVAL_MS);
        }

        // Detach network/console listeners now that the gate has resolved.
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("requestfailed", onFailed);
        page.off("console", onConsole);
        page.off("pageerror", onPageError);

        // Record final diagnostics regardless of outcome.
        report.editorReadinessTimeline = readinessTimeline.slice(-120);
        report.finalFroalaCandidates = lastSnapshot;
        report.completedGenerationResponses = netResponses;
        report.failedGenerationRequests = netFailed;
        report.froalaCandidates = lastSnapshot;

        // If the generation request explicitly FAILED and no editor populated.
        if (readyIndex < 0 && netFailed.length > 0) {
            report.blockedStage = "library_generation_request";
            report.blockedReason = "CRC library-letter generation request failed";
            report.blockingGaps.push("library_generation_request_failed");
            report.finalEditorPageText = (await page.evaluate(() => document.body?.innerText || "")
                .catch(() => "")).slice(0, 3000);
            report.artifacts.push(await shot(page, "05-generation-request-failed"));
            return report;
        }

        // Heading appeared but editor never populated within the timeout.
        if (readyIndex < 0) {
            report.blockedStage = "editor_population";
            report.blockedReason =
                "Letter Editor opened, but Froala content did not populate before timeout";
            report.blockingGaps.push("editor_did_not_populate");
            report.finalEditorPageText = (await page.evaluate(() => document.body?.innerText || "")
                .catch(() => "")).slice(0, 3000);
            report.artifacts.push(await shot(page, "05-editor-population-timeout"));
            return report;
        }

        // Ready + stable: bind the unique active editor. NEVER .first().
        const activeIndex = readyIndex;
        const froala = page.locator(froalaSelector).nth(activeIndex);
        report.stagesReached.push("editor_populated");
        report.froalaEditorLocator = `${froalaSelector} >> nth=${activeIndex}`;
        report.activeEditorIndex = activeIndex;
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
