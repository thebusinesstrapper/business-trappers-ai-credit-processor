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
function assertNoForbidden(label) {
    for (const re of FORBIDDEN) {
        if (re.test((label ?? "").trim())) {
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
        clientDropdownOptionsSample: null,
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
        const verifyComposeForm = async () => {
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
            // Reply-mode / existing-conversation signal: a visible "Reply" control
            // or the message-history scroll container being the active editor area.
            const replyVisible = await page.getByRole("button", { name: /^reply$/i })
                .first().isVisible().catch(() => false);

            return {
                hasSubject, hasBody, hasClient, hasSubmit, replyVisible,
                ok: hasSubject && hasBody && hasClient && hasSubmit && !replyVisible,
            };
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
        // Client dropdown (MUI autocomplete/select).
        const clientDd = page.getByLabel(/client/i)
            .or(page.locator('input[role="combobox"]')).first();
        report.clientDropdown = await describe(clientDd);
        // A small sample of client-dropdown options (open it read-only if possible).
        try {
            if (await clientDd.count()) {
                await clientDd.click({ timeout: 6000 }).catch(() => {});
                await page.waitForTimeout(600);
                report.clientDropdownOptionsSample = await page.getByRole("option")
                    .evaluateAll((nodes) => nodes.slice(0, 8)
                        .map((n) => (n.textContent || "").trim().slice(0, 60))).catch(() => null);
                await page.keyboard.press("Escape").catch(() => {});
            }
        } catch { /* ignore */ }

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
        const gaps = [];
        if (!report.fileInput && !report.attachmentControl) gaps.push("no_attachment_control");
        if (!report.clientDropdown) gaps.push("no_client_dropdown");
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
