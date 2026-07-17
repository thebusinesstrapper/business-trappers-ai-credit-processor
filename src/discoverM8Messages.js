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

        // ---- Find the REAL "New Message" control ---------------------------
        // V1 mistakenly captured a notifications icon reading "7". Prefer an
        // explicit "New Message" text/button; enumerate candidates for evidence.
        const newMsgCandidates = await page.locator("button, a").evaluateAll((nodes) =>
            nodes.map((n, i) => ({
                i,
                tag: n.tagName.toLowerCase(),
                text: (n.textContent || "").replace(/\s+/g, " ").trim(),
                title: n.getAttribute("title"),
                ariaLabel: n.getAttribute("aria-label"),
                classes: (n.className && n.className.toString) ? n.className.toString() : "",
                visible: (() => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
            })).filter((c) => c.visible &&
                (/new message/i.test(c.text) || /new message/i.test(c.title || "") ||
                 /new message/i.test(c.ariaLabel || "") || /compose/i.test(c.text)))
        ).catch(() => []);
        report.newMessageCandidates = newMsgCandidates;

        // Try to open the compose form via an explicit New Message control.
        let opened = false;
        const newMsgLoc = page.getByRole("button", { name: /new message/i })
            .or(page.getByText(/new message/i)).first();
        if (await newMsgLoc.count()) {
            assertNoForbidden("New Message"); // "New Message" is safe (no send/upload word)
            await newMsgLoc.click({ timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1500);
            opened = true;
        }
        report.newMessageControl = await describe(newMsgLoc);
        report.stagesReached.push(opened ? "compose_opened" : "compose_not_opened");
        report.artifacts.push(await shot(page, "02-compose"));

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
        // A hidden <input type=file> is what we'll set files on; the visible
        // "Attach"/paperclip button triggers it. Capture BOTH.
        report.fileInput = await describe(page.locator('input[type="file"]'));
        report.attachmentControl = await describe(
            page.getByRole("button", { name: /attach|file|upload|paperclip/i })
                .or(page.getByText(/attach|add file|upload/i))
        );
        // Where uploaded filenames will appear (for verification).
        report.attachmentListContainer = await describe(
            page.locator('[class*="attachment"], [class*="Attachment"], [class*="file-list"], ul')
        );

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
