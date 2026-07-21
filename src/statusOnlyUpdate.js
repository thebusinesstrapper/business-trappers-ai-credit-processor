/**
 * statusOnlyUpdate.js — set a CRC client's Status and NOTHING else.
 *
 * Stage 2 routes blocked classifications (WAITING_FOR_FREE_REPORT,
 * CREDENTIALS_OR_AUTH_FAILED) to a CRC status with no delivery. This helper owns
 * that single action in its own session.
 *
 * WHAT IT CANNOT DO, BY CONSTRUCTION. It imports browserbase, crcLogin,
 * openClient, crcClientId, and crcClientStatus — nothing else. It does not import
 * milestone6/7/8, openCreditHero, crcSecureMessage, m8Pdf, or clientMemory, so
 * it cannot open CreditHero, run a milestone, send a message or attachment, take
 * a delivery lock, advance a round, or order a report. Those are unreachable, not
 * merely un-called.
 *
 * READ-ONLY LABEL CHECK FIRST. Before writing, it verifies the exact target label
 * exists in the CRC dropdown. If it does not, it returns STATUS_LABEL_NOT_FOUND
 * and writes nothing — it never substitutes or invents a label.
 */

import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { getCrcClientId } from "./crcClientId.js";
import { updateClientStatus, STATUS_LABEL } from "./crcClientStatus.js";

export const STATUS_ONLY_VERSION = "BT-STATUS-ONLY-2.0";

const PROFILE_LINK_TEXT = "View/Edit Profile";
const TIMEOUT = 20000;

/** Collapse whitespace for exact-but-tolerant label comparison. */
function normalize(value) {
    return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Find the Edit Profile modal frame, the same way the status module does. */
async function findModal(page) {
    for (const frame of page.frames()) {
        try {
            if (await frame.getByLabel("First Name", { exact: false }).first().count()) {
                return frame;
            }
        } catch {
            // detached frame
        }
    }
    return null;
}

/**
 * READ-ONLY: open the profile and list the Status control's option labels.
 * Opens the modal, reads, and returns — it never selects, saves, or types.
 *
 * @returns {Promise<{ok: boolean, labels: string[], error_code?: string}>}
 */
async function readStatusOptions(page, crcClientId) {
    const dashboardUrl =
        `https://app.creditrepaircloud.com/app/clients/${crcClientId}/dashboard`;

    if (!page.url().includes(`/clients/${crcClientId}/dashboard`)) {
        await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }

    const link = page.getByText(PROFILE_LINK_TEXT, { exact: false }).first();

    if (!(await link.count())) {
        return { ok: false, labels: [], error_code: "PROFILE_LINK_NOT_FOUND" };
    }

    await link.click({ timeout: TIMEOUT }).catch(() => {});

    const deadline = Date.now() + TIMEOUT;
    let modal = null;

    while (Date.now() < deadline) {
        modal = await findModal(page);
        if (modal) break;
        await page.waitForTimeout(300);
    }

    if (!modal) return { ok: false, labels: [], error_code: "MODAL_NOT_VISIBLE" };

    const statusField = modal.getByLabel(STATUS_LABEL, { exact: false }).first();

    if (!(await statusField.count())) {
        return { ok: false, labels: [], error_code: "STATUS_FIELD_NOT_FOUND" };
    }

    // Native <select>: read its option labels. MUI listbox: open, read li[role=option].
    const isNativeSelect = await statusField
        .evaluate((el) => el.tagName.toLowerCase() === "select")
        .catch(() => false);

    let labels = [];

    if (isNativeSelect) {
        labels = await statusField
            .evaluate((el) =>
                Array.from(el.options ?? []).map((o) => (o.label || o.textContent || "").trim())
            )
            .catch(() => []);
    } else {
        // Open the listbox read-only to enumerate options, then close it. Opening
        // a dropdown to read its choices selects nothing.
        await statusField.click({ timeout: TIMEOUT }).catch(() => {});
        const optDeadline = Date.now() + TIMEOUT;

        while (Date.now() < optDeadline) {
            labels = await modal
                .getByRole("option")
                .evaluateAll((nodes) => nodes.map((n) => (n.textContent || "").replace(/\s+/g, " ").trim()))
                .catch(() => []);
            if (labels.length === 0) {
                labels = await page
                    .getByRole("option")
                    .evaluateAll((nodes) => nodes.map((n) => (n.textContent || "").replace(/\s+/g, " ").trim()))
                    .catch(() => []);
            }
            if (labels.length > 0) break;
            await page.waitForTimeout(200);
        }

        // Close the listbox without choosing anything.
        await page.keyboard.press("Escape").catch(() => {});
    }

    return { ok: true, labels: labels.filter(Boolean) };
}

/**
 * Open a status-only session and set the client's Status to `targetStatus`.
 *
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string|number} opts.crcClientId
 * @param {string} opts.targetStatus   the EXACT CRC label to set
 * @param {string} [opts.blockReason]   informational, echoed in the report only
 */
export async function statusOnlyUpdate(opts = {}) {
    const { clientName, crcClientId, targetStatus } = opts;

    const report = {
        tool: STATUS_ONLY_VERSION,
        clientName: clientName ?? null,
        crcClientId: crcClientId != null ? String(crcClientId) : null,
        targetStatus: targetStatus ?? null,
        previousStatus: null,
        statusUpdated: false,
        labelVerified: false,
        // Structural attestations.
        creditHeroOpened: false,
        milestoneRun: false,
        messageSent: false,
        attachmentsUploaded: 0,
        deliveryLockAcquired: false,
        roundChanged: false,
        reportOrdered: false,
        error_code: null,
        failureReason: null,
    };

    if (!clientName || crcClientId == null || !/^\d+$/.test(String(crcClientId))) {
        report.error_code = "INPUT_INVALID";
        report.failureReason = "clientName and a numeric crcClientId are both required.";
        return report;
    }

    if (!targetStatus) {
        report.error_code = "INPUT_INVALID";
        report.failureReason = "targetStatus is required.";
        return report;
    }

    let browser = null;

    try {
        const session = await launchBrowser();
        browser = session.browser;
        const page = session.page;

        await loginToCRC(page);
        await openClient(page, clientName);

        const openedId = String(await getCrcClientId(page));

        if (openedId !== String(crcClientId)) {
            report.error_code = "WRONG_CLIENT_OPENED";
            report.failureReason =
                `Opened client ${openedId}, expected ${crcClientId}. Nothing was written.`;
            return report;
        }

        // ---- READ-ONLY LABEL VERIFICATION ---------------------------------
        //
        // Confirm the EXACT label exists before writing. If it does not, stop —
        // never substitute, never create.
        const options = await readStatusOptions(page, openedId);

        if (!options.ok) {
            report.error_code = options.error_code ?? "STATUS_OPTIONS_UNREADABLE";
            report.failureReason = "Could not read the Status control options.";
            return report;
        }

        const wanted = normalize(targetStatus).toLowerCase();
        const exact = options.labels.find((l) => normalize(l).toLowerCase() === wanted);

        if (!exact) {
            report.error_code = "STATUS_LABEL_NOT_FOUND";
            report.failureReason =
                `The exact status "${targetStatus}" is not offered by CRC. No status was written.`;
            return report;
        }

        report.labelVerified = true;

        // ---- WRITE (idempotent; governed helper) --------------------------
        const result = await updateClientStatus(
            page, openedId, exact, { processingCycleComplete: true }
        );

        report.previousStatus = result?.previousStatus ?? null;
        report.statusUpdated = result?.ok === true;

        if (result?.ok !== true) {
            report.error_code = result?.error_code ?? "STATUS_UPDATE_FAILED";
            report.failureReason = result?.error ?? "Status update failed.";
        }

        return report;
    } catch (error) {
        report.error_code = report.error_code ?? "STATUS_ONLY_EXCEPTION";
        report.failureReason = report.failureReason ?? error.message;
        return report;
    } finally {
        try { if (browser) await browser.close(); } catch { /* ignore */ }
    }
}
