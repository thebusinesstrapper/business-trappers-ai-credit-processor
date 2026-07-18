/**
 * discoverM8Messages.js — READ-ONLY discovery of CRC's secure-message compose
 * form for client 15. It maps the real selectors the M8 uploader will need:
 *   - the real "New Message" control (V1 captured a notifications icon by mistake)
 *   - recipient-type = Client selector
 *   - the Client dropdown + how the selected client is displayed
 *   - Subject field
 *   - message body editor
 *   - the attachment / file input control
 *   - the attachment-list row (for post-upload filename verification)
 *   - the green Submit button
 *
 * IT SUBMITS NOTHING. No message is sent, no file is uploaded, nothing persists.
 * A compose form left open is not a sent message.
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";

export const MESSAGES_DISCOVERY_VERSION = "BT-M8-MESSAGES-DISCOVERY-1.0";

const AUTHORIZED_CLIENT_ID = "15";
const AUTHORIZED_CLIENT_NAME = "Elizabeth Kelley";

// Never click anything that could send/submit/upload during discovery.
const FORBIDDEN = [/submit/i, /^send\b/i, /upload/i, /attach/i, /mail/i, /print/i, /delete/i];
// Exact-text navigation controls that OPEN the compose form. These do not send,
// submit, upload, or write anything by themselves, so they are explicitly
// allowed even though their text contains "Send".
const ALLOWED_NAV_LABELS = new Set(["Send New Message", "New Message"]);
function assertNoForbidden(label) {
    const trimmed = (label ?? "").trim();
    // Allow the known-safe navigation openers verbatim.
    if (ALLOWED_NAV_LABELS.has(trimmed)) return;
    for (const re of FORBIDDEN) {
        if (re.test(trimmed)) {
            throw new Error(`DISCOVERY SAFETY: refused to click "${label}".`);
        }
    }
}

async function describe(locator) {
    try {
        if ((await locator.count()) === 0) return null;
        const el = locator.first();
        const visible = await el.isVisible().catch(() => false);
        const info = await el.evaluate((node) => {
            const attrs = {};
            for (const a of node.attributes || []) attrs[a.name] = a.value;
            return {
                tag: node.tagName ? node.tagName.toLowerCase() : null,
                id: node.id || null,
                role: node.getAttribute ? node.getAttribute("role") : null,
                type: node.getAttribute ? node.getAttribute("type") : null,
                classes: node.className && node.className.toString ? node.className.toString() : null,
                text: (node.textContent || "").trim().slice(0, 120),
                attrs,
            };
        }).catch(() => null);
        return { present: true, visible, ...info };
    } catch (e) {
        return { present: false, error: e.message };
    }
}

async function shot(page, name) {
    const path = `/tmp/m8msg-${name}.png`;
    try { await page.screenshot({ path, fullPage: false }); return path; }
    catch (e) { return `screenshot-failed:${e.message}`; }
}

export async function discoverM8Messages(data = {}) {
    const clientName = data?.clientName ?? AUTHORIZED_CLIENT_NAME;
    const report = {
        tool: MESSAGES_DISCOVERY_VERSION,
        clientName,
        stagesReached: [],
        blockedStage: null,
        blockedReason: null,
        messagesUrl: null,
        newMessageControl: null,
        recipientTypeControl: null,
        clientDropdown: null,
        actualClientSelector: null,
        clientSelectorLabel: null,
        clientSelectorCurrentValue: null,
        clientDropdownOptionsSample: null,
        clientSearchText: null,
        filteredClientOptions: null,
        exactMatchCount: 0,
        elizabethOptionFound: false,
        elizabethOptionDescriptor: null,
        subjectField: null,
        bodyEditor: null,
        fileInput: null,
        attachmentControl: null,
        attachmentListContainer: null,
        submitButton: null,
        composeFormText: null,
        artifacts: [],
        replayUrl: null,
        // attestations
        writesAttempted: false,
        messageSubmitted: false,
        fileUploaded: false,
        implementationReady: false,
        blockingGaps: [],
    };

    if (clientName !== AUTHORIZED_CLIENT_NAME) {
        report.blockedStage = "authorization";
        report.blockedReason = `Authorized only for ${AUTHORIZED_CLIENT_NAME} (Client ${AUTHORIZED_CLIENT_ID}).`;
        return report;
    }

    let browser;
    try {
        const session = await launchBrowser();
        browser = session.browser;
        const page = session.page;
        report.replayUrl = session.session?.id
            ? `https://www.browserbase.com/sessions/${session.session.id}` : null;

        await loginToCRC(page);
        await openClient(page, clientName);

        // Navigate to Messages by URL (tabs open target=_blank; discovered earlier).
        const messagesUrl = `https://app.creditrepaircloud.com/app/messages/all/${AUTHORIZED_CLIENT_ID}`;
        await page.goto(messagesUrl, { waitUntil: "domcontentloaded" });
        if (!page.url().includes(`/messages/all/${AUTHORIZED_CLIENT_ID}`) &&
            !page.url().includes(`/messages`)) {
            throw new Error(`Expected messages route; got ${page.url()}`);
        }
        report.messagesUrl = page.url();
        report.stagesReached.push("messages");
        report.artifacts.push(await shot(page, "01-messages"));

        // ---- Find the REAL "Send New Message" / "New Message" control ------
        // The prior run clicked the red notification icon (text "7",
        // aria-describedby="messagesMenu") via loose text matching and landed in
        // an existing thread + Reply editor. We now enumerate all buttons/links
        // and pick ONLY an element whose NORMALIZED EXACT text is
        // "Send New Message" or "New Message", explicitly EXCLUDING the
        // notification icon and any MUI IconButton.
        const enumerated = await page.locator("button, a").evaluateAll((nodes) =>
            nodes.map((n, i) => {
                const r = n.getBoundingClientRect();
                return {
                    i,
                    tag: n.tagName.toLowerCase(),
                    text: (n.textContent || "").replace(/\s+/g, " ").trim(),
                    classes: (n.className && n.className.toString) ? n.className.toString() : "",
                    ariaDescribedby: n.getAttribute("aria-describedby"),
                    dataTestid: n.getAttribute("data-testid"),
                    visible: r.width > 0 && r.height > 0,
                };
            })
        ).catch(() => []);

        // Safe candidates: EXACT text, visible, NOT the notifications menu icon,
        // NOT a MUI IconButton (the "7" badge is an IconButton bound to
        // aria-describedby="messagesMenu").
        const isSafeOpener = (c, exactText) =>
            c.visible &&
            c.text === exactText &&
            c.ariaDescribedby !== "messagesMenu" &&
            !/MuiIconButton-root/.test(c.classes) &&
            c.dataTestid !== "IconButton";

        const sendNewMsg = enumerated.filter((c) => isSafeOpener(c, "Send New Message"));
        const newMsg = enumerated.filter((c) => isSafeOpener(c, "New Message"));
        report.newMessageCandidates = [...sendNewMsg, ...newMsg];

        // Click by exact index of the chosen safe candidate (never loose text).
        const clickEnumerated = async (candidate, labelForGuard) => {
            assertNoForbidden(labelForGuard); // both labels are safe (no send/upload word)
            const loc = page.locator("button, a").nth(candidate.i);
            report.newMessageControl = await describe(loc);
            await loc.click({ timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1500);
        };

        // Verify we are on a TRUE new-message compose form (not Reply on an
        // existing thread). Requires a client recipient field, subject, body
        // editor, and a Submit button — and that we are NOT in an existing
        // conversation/Reply view.
        // After clicking "Send New Message" there is a brief loading spinner and
        // the compose form renders asynchronously. So we POLL for the real
        // compose elements to appear (element-appearance-driven, not a fixed
        // sleep) up to COMPOSE_RENDER_TIMEOUT_MS, and only conclude
        // "not confirmed" once that wait expires.
        const COMPOSE_RENDER_TIMEOUT_MS = 15000;
        const COMPOSE_POLL_MS = 300;

        const readComposeState = async () => {
            const subj = page.getByLabel(/subject/i).or(page.getByPlaceholder(/subject/i)).first();
            const body = page.locator('div.fr-element.fr-view[contenteditable="true"]')
                .or(page.locator("textarea")).first();
            const client = page.getByLabel(/client/i)
                .or(page.getByRole("radio", { name: /client/i }))
                .or(page.locator('input[role="combobox"]')).first();
            const submit = page.getByRole("button", { name: /^submit$/i })
                .or(page.getByRole("button", { name: /^send$/i })).first();

            const hasSubject = (await subj.count()) > 0 && await subj.isVisible().catch(() => false);
            const hasBody = (await body.count()) > 0 && await body.isVisible().catch(() => false);
            const hasClient = (await client.count()) > 0 && await client.isVisible().catch(() => false);
            const hasSubmit = (await submit.count()) > 0 && await submit.isVisible().catch(() => false);
            // Reply-mode / existing-conversation signal.
            const replyVisible = await page.getByRole("button", { name: /^reply$/i })
                .first().isVisible().catch(() => false);

            return {
                hasSubject, hasBody, hasClient, hasSubmit, replyVisible,
                ok: hasSubject && hasBody && hasClient && hasSubmit && !replyVisible,
            };
        };

        const verifyComposeForm = async () => {
            const deadline = Date.now() + COMPOSE_RENDER_TIMEOUT_MS;
            let state = await readComposeState();
            // Wait for the spinner/async render: poll until the compose elements
            // are present OR the timeout expires. Do NOT conclude failure early.
            while (!state.ok && Date.now() < deadline) {
                await page.waitForTimeout(COMPOSE_POLL_MS);
                state = await readComposeState();
            }
            return state;
        };

        // Attempt 1: "Send New Message". Attempt 2 (if not confirmed): "New Message".
        let composeCheck = null;
        let opened = false;
        if (sendNewMsg.length > 0) {
            await clickEnumerated(sendNewMsg[0], "Send New Message");
            composeCheck = await verifyComposeForm();
            opened = composeCheck.ok;
        }
        if (!opened && newMsg.length > 0) {
            await clickEnumerated(newMsg[0], "New Message");
            composeCheck = await verifyComposeForm();
            opened = composeCheck.ok;
        }
        report.composeVerification = composeCheck;
        report.stagesReached.push(opened ? "compose_opened" : "compose_open_attempted");
        report.artifacts.push(await shot(page, "02-compose"));

        // FAIL CLOSED if we could not confirm a true new-message form.
        if (!opened) {
            report.blockedStage = "open_new_message";
            report.blockedReason = "new_message_form_not_confirmed";
            report.blockingGaps.push("new_message_form_not_confirmed");
            report.composeFormText = (await page.evaluate(() => document.body?.innerText || "")
                .catch(() => "")).slice(0, 2000);
            report.artifacts.push(await shot(page, "02b-not-compose"));
            return report;
        }

        // ---- Describe the compose form pieces (read-only) ------------------
        // Recipient type = Client (radio/toggle/segmented control).
        report.recipientTypeControl = await describe(
            page.getByText(/^client$/i).or(page.getByRole("radio", { name: /client/i }))
        );
        // ---- The ACTUAL client selector under "Client*" -------------------
        // The prior run mis-captured the recipient-TYPE radio (name="user_type",
        // type="radio", value="client") as the client dropdown. That radio only
        // chooses the recipient category; the real client PICKER is a separate
        // MUI combobox/autocomplete tied to the "Client*" label. Find it while
        // EXCLUDING any user_type radio.
        const clientSelectorInfo = await page.evaluate(() => {
            const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
            const isUserTypeRadio = (el) =>
                el.getAttribute("type") === "radio" || el.getAttribute("name") === "user_type";

            // Candidate inputs: comboboxes / autocomplete / text inputs that are
            // NOT the user_type radio. Prefer one whose form-control label or
            // nearby text contains "Client".
            const inputs = Array.from(document.querySelectorAll(
                'input[role="combobox"], input[aria-autocomplete], input[type="text"], ' +
                '.MuiAutocomplete-root input, [role="combobox"]'
            )).filter((el) => !isUserTypeRadio(el));

            const scoreOf = (el) => {
                const fc = el.closest(".MuiFormControl-root, .MuiTextField-root, .MuiAutocomplete-root");
                const label = fc ? norm(fc.querySelector("label")?.textContent || "") : "";
                const near = norm((el.closest("div")?.textContent || "").slice(0, 60));
                let score = 0;
                if (/client\*?/i.test(label)) score += 10;
                if (/client/i.test(near)) score += 3;
                if (el.getAttribute("role") === "combobox") score += 2;
                if (el.hasAttribute("aria-autocomplete")) score += 1;
                return { score, label };
            };

            let best = null;
            inputs.forEach((el, idx) => {
                const { score, label } = scoreOf(el);
                if (score <= 0) return;
                if (!best || score > best.score) {
                    const attrs = {};
                    for (const a of el.attributes || []) attrs[a.name] = a.value;
                    best = {
                        score, label,
                        domIndexHint: idx,
                        tag: el.tagName.toLowerCase(),
                        id: el.id || null,
                        role: el.getAttribute("role"),
                        ariaAutocomplete: el.getAttribute("aria-autocomplete"),
                        classes: (el.className && el.className.toString) ? el.className.toString() : "",
                        value: el.value ?? "",
                        attrs,
                    };
                }
            });
            return best;
        }).catch(() => null);

        report.actualClientSelector = clientSelectorInfo;
        report.clientSelectorLabel = clientSelectorInfo?.label ?? null;
        report.clientSelectorCurrentValue = clientSelectorInfo?.value ?? null;
        // Keep clientDropdown pointing at the REAL selector (not the radio) for
        // the readiness gate below.
        report.clientDropdown = clientSelectorInfo
            ? { present: true, tag: clientSelectorInfo.tag, id: clientSelectorInfo.id,
                role: clientSelectorInfo.role, classes: clientSelectorInfo.classes,
                label: clientSelectorInfo.label, attrs: clientSelectorInfo.attrs }
            : null;

        // Open the REAL client selector, TYPE "Elizabeth Kelley" to filter the MUI
        // autocomplete, and confirm the exact option exists. We NEVER click or
        // commit the option; afterward we Escape + CLEAR so no recipient remains
        // selected (clientSelectorCurrentValue must end empty).
        const CLIENT_SEARCH_TEXT = "Elizabeth Kelley";
        if (clientSelectorInfo) {
            try {
                // Bind directly to the confirmed client combobox by its name.
                let clientLoc = page.locator('input[name="client_id"]').first();
                if (!(await clientLoc.count())) {
                    clientLoc = page.locator('input[role="combobox"]:not([name="user_type"])').first();
                }
                if (await clientLoc.count()) {
                    await clientLoc.click({ timeout: 6000 }).catch(() => {});
                    await clientLoc.fill("").catch(() => {});
                    // Type the search text to filter the autocomplete list.
                    await clientLoc.type(CLIENT_SEARCH_TEXT, { delay: 25 }).catch(() => {});
                    report.clientSearchText = CLIENT_SEARCH_TEXT;

                    // Wait for filtered options to render (element-appearance driven,
                    // brief bounded poll — not a fixed-only sleep).
                    const optDeadline = Date.now() + 8000;
                    let options = [];
                    while (Date.now() < optDeadline) {
                        options = await page.getByRole("option").evaluateAll((nodes) =>
                            nodes.slice(0, 40).map((n) => (n.textContent || "").replace(/\s+/g, " ").trim())
                        ).catch(() => []);
                        // Stop once the list has filtered down to Elizabeth-matching rows.
                        if (options.some((o) => /elizabeth\s+kelley/i.test(o))) break;
                        await page.waitForTimeout(250);
                    }
                    report.filteredClientOptions = options.slice(0, 20);
                    report.clientDropdownOptionsSample = options.slice(0, 12);

                    // Exact (normalized) match against "Elizabeth Kelley".
                    const exactMatches = options.filter((o) => o === CLIENT_SEARCH_TEXT);
                    report.exactMatchCount = exactMatches.length;
                    report.elizabethOptionFound = exactMatches.length >= 1;
                    report.elizabethOptionDescriptor = exactMatches[0] ?? null;

                    // Close WITHOUT selecting, then CLEAR the field so no recipient
                    // remains chosen.
                    await page.keyboard.press("Escape").catch(() => {});
                    await clientLoc.fill("").catch(() => {});
                    await clientLoc.blur?.().catch?.(() => {});
                    // Re-read the selector's current value to confirm it is empty.
                    report.clientSelectorCurrentValue =
                        (await clientLoc.inputValue().catch(() => "")) || "";
                }
            } catch { /* ignore — read-only best effort */ }
        }

        report.subjectField = await describe(
            page.getByLabel(/subject/i).or(page.getByPlaceholder(/subject/i))
        );
        report.bodyEditor = await describe(
            page.locator('div.fr-element.fr-view[contenteditable="true"]')
                .or(page.locator("textarea"))
        );

        // ---- The attachment / file control (KEY for M8) --------------------
        // The hidden <input type="file"> is the real upload target (setInputFiles
        // in the eventual uploader). This IS reliable — capture every one so we
        // know how many exist and pick the compose-scoped one later.
        report.fileInput = await describe(page.locator('input[type="file"]'));
        report.allFileInputs = await page.locator('input[type="file"]').evaluateAll((nodes) =>
            nodes.map((n, i) => ({
                i,
                accept: n.getAttribute("accept"),
                hidden: n.hasAttribute("hidden"),
                name: n.getAttribute("name"),
                id: n.id || null,
            }))
        ).catch(() => []);

        // The VISIBLE attachment trigger. The prior run mislabeled a message-list
        // row (class "list_button", full of conversation text) as the attachment
        // control. Exclude that: require a real attach/paperclip affordance and
        // explicitly reject the message-history list_button rows.
        const attachTrigger = page.getByRole("button", { name: /^(attach|add file|attach file|upload file)$/i })
            .or(page.locator('button[aria-label*="attach" i]'))
            .or(page.locator('label[for]').filter({ hasText: /attach|file/i }))
            .filter({ hasNot: page.locator('.list_button') })
            .first();
        report.attachmentControl = await describe(attachTrigger);
        report.attachmentControlNote =
            "If null, the hidden input[type=file] is the upload target; the trigger " +
            "may be an icon/label without accessible text. The prior 'list_button' " +
            "match was a message-history row and is intentionally excluded.";

        // Where NEWLY attached filenames will appear (for post-upload
        // verification). This must NOT be the message-history list
        // (#message-scroll-container / list_button rows). Look for an
        // attachment-specific container and explicitly exclude the history list.
        const attachmentList = page.locator(
            '[class*="attachment" i]:not(#message-scroll-container), ' +
            '[class*="file-list" i], [data-testid*="attachment" i]'
        ).first();
        report.attachmentListContainer = await describe(attachmentList);
        report.attachmentListNote =
            "Excludes #message-scroll-container (the existing conversation history). " +
            "If null, the attachment list only appears AFTER a file is chosen; the " +
            "uploader will re-locate it post-upload to verify each filename.";

        // ---- The green Submit button (describe only; NEVER click) ----------
        report.submitButton = await describe(
            page.getByRole("button", { name: /^submit$/i })
                .or(page.getByRole("button", { name: /send message|send$/i }))
        );

        // Capture compose-area text for context.
        report.composeFormText = (await page.evaluate(() => document.body?.innerText || "")
            .catch(() => "")).slice(0, 3000);
        report.artifacts.push(await shot(page, "03-compose-detail"));

        // ---- readiness gate ------------------------------------------------
        // implementationReady requires the REAL client selector (not the
        // user_type radio) AND the exact "Elizabeth Kelley" option identified,
        // in addition to subject, body, file input, and Submit.
        const gaps = [];
        if (!report.fileInput && !report.attachmentControl) gaps.push("no_attachment_control");
        if (!report.actualClientSelector) gaps.push("no_actual_client_selector");
        if (!report.elizabethOptionFound) gaps.push("elizabeth_option_not_found");
        if (report.exactMatchCount !== 1) gaps.push("elizabeth_exact_match_not_unique");
        if (!report.subjectField) gaps.push("no_subject_field");
        if (!report.bodyEditor) gaps.push("no_body_editor");
        if (!report.submitButton) gaps.push("no_submit_button");
        report.blockingGaps = gaps;
        report.implementationReady = gaps.length === 0;

        report.completed = true;
        return report;
    } catch (error) {
        report.blockedStage = report.stagesReached[report.stagesReached.length - 1] ?? "startup";
        report.blockedReason = error.message;
        return report;
    } finally {
        try { if (browser) await browser.close(); } catch { /* ignore */ }
    }
}
