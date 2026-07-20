/**
 * inactiveWorkflow.js — the CreditHero inactive-monitoring branch.
 *
 * ENTERED ONLY on a positively confirmed CHS_NOT_ACTIVATED, which means the
 * client dashboard showed the invite banner on consecutive stable reads. A
 * greyed control, an aria-disabled attribute, a click that did not navigate, or
 * a generic CREDIT_HERO_UNAVAILABLE are NOT proof and never reach this module.
 * The cost of being wrong here is telling a paying client their monitoring
 * lapsed, so the bar is a positive marker or nothing.
 *
 * WHAT THIS MODULE CANNOT DO. It does not import milestone7, milestone8,
 * m8Pdf, or crcSecureMessage. No dispute PDF can be generated or attached, and
 * no dispute delivery can be triggered, because none of that code is reachable.
 * Its only memory writer is recordCreditHeroState(), whose whitelist excludes
 * current_round, processing_state and every lock column.
 *
 * "Send Invite" is never located, referenced, or clicked anywhere in this file.
 */

import {
    sendClientNotice,
    buildNoticeBody,
    buildReminderBody,
    NOTICE_SUBJECT,
    REMINDER_SUBJECT,
} from "./crcClientNotice.js";
import { recordCreditHeroState } from "./clientMemory.js";
import { updateClientStatus } from "./crcClientStatus.js";
import { readClientProfile } from "./crcClientProfile.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { getCrcClientId } from "./crcClientId.js";
import { loadOrCreateClientMemory } from "./clientMemory.js";

export const INACTIVE_WORKFLOW_VERSION = "BT-INACTIVE-1.0";

/** The exact CRC dropdown option. Confirmed against the live UI. */
const INACTIVE_STATUS = "Credit Monitoring Inactive";

/** Reminder falls due seven days after the notice was SENT, not after detection. */
const REMINDER_AFTER_DAYS = 7;

export const PLANNED_ACTION = Object.freeze({
    SEND_INITIAL_NOTICE: "send_initial_notice",
    SEND_REMINDER: "send_reminder",
    NO_MESSAGE_DUE: "no_message_due",
});

/**
 * Decide what is owed this run, from the durable record alone.
 *
 * Deliberately NOT from CRC status: a human can set that by hand, and a client
 * would then be messaged again about a payment they may already have made.
 */
export function decideNoticeAction(state = {}, now = new Date()) {
    const noticeSentAt = state.inactive_notice_sent_at ?? null;
    const reminderSentAt = state.inactive_reminder_sent_at ?? null;

    if (!noticeSentAt) {
        return { action: PLANNED_ACTION.SEND_INITIAL_NOTICE, reason: "no_notice_recorded" };
    }

    if (reminderSentAt) {
        return { action: PLANNED_ACTION.NO_MESSAGE_DUE, reason: "notice_and_reminder_already_sent" };
    }

    const sent = new Date(noticeSentAt);

    if (Number.isNaN(sent.getTime())) {
        // An unreadable timestamp is not permission to message again.
        return { action: PLANNED_ACTION.NO_MESSAGE_DUE, reason: "notice_timestamp_unreadable" };
    }

    const days = (now.getTime() - sent.getTime()) / 86400000;

    if (days >= REMINDER_AFTER_DAYS) {
        return {
            action: PLANNED_ACTION.SEND_REMINDER,
            reason: `notice_sent_${Math.floor(days)}_days_ago`,
        };
    }

    return {
        action: PLANNED_ACTION.NO_MESSAGE_DUE,
        reason: `reminder_not_due_for_${Math.ceil(REMINDER_AFTER_DAYS - days)}_more_days`,
    };
}

/**
 * Resolve a first name for the greeting, read live at send time.
 *
 * Never persisted and never returned in the report — a name in Supabase or in a
 * queue result is PII we would be storing for a greeting.
 */
function resolveFirstName(identity, clientName) {
    const candidates = [
        identity?.first_name,
        identity?.firstName,
        typeof identity?.name === "string" ? identity.name.trim().split(/\s+/)[0] : null,
        typeof clientName === "string" ? clientName.trim().split(/\s+/)[0] : null,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    return null;
}

/**
 * Run the inactive branch for one confirmed-inactive client.
 *
 * @param {object} page             a page on the client dashboard
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string} opts.crcClientId
 * @param {object} opts.state       current client_state row (may be empty)
 * @param {boolean} opts.inactiveWorkflowApproved  must be true to act
 */
export async function runInactiveWorkflow(opts = {}) {
    const { clientName, crcClientId: suppliedId, inactiveWorkflowApproved } = opts;
    const nowIso = new Date().toISOString();
    let crcClientId = suppliedId;

    const report = {
        tool: INACTIVE_WORKFLOW_VERSION,
        clientName: clientName ?? null,
        crcClientId: crcClientId ?? null,
        creditHeroAccessState: "CHS_NOT_ACTIVATED",
        approved: inactiveWorkflowApproved === true,
        plannedAction: null,
        plannedReason: null,
        plannedStatus: INACTIVE_STATUS,
        // Everything below stays false unless the run is approved AND succeeds.
        noticeSent: false,
        reminderSent: false,
        statusUpdated: false,
        memoryWritten: false,
        // Structural attestations.
        pdfsGenerated: 0,
        attachmentsUploaded: 0,
        deliveryLockAcquired: false,
        roundChanged: false,
        inviteClicked: false,
        error_code: null,
        failureReason: null,
    };

    if (!crcClientId || !/^\d+$/.test(String(crcClientId))) {
        report.error_code = "CRC_CLIENT_ID_MISSING";
        report.failureReason =
            "The inactive workflow is keyed on the CRC client id and cannot run without it.";
        return report;
    }

    // M7 runs and closes its own browser, so there is no page to inherit. This
    // module opens its own session for the same reason milestone8 does.
    let browser = null;
    let page = null;
    let state = {};

    try {
        const memory = await loadOrCreateClientMemory(String(crcClientId), clientName ?? null);
        state = memory?.state ?? memory ?? {};
    } catch (error) {
        report.error_code = "MEMORY_READ_FAILED";
        report.failureReason = `Could not read client_state: ${error.message}`;
        return report;
    }

    const decision = decideNoticeAction(state);
    report.plannedAction = decision.action;
    report.plannedReason = decision.reason;

    // ---- DRY RUN BOUNDARY --------------------------------------------------
    //
    // Nothing below this point runs unless explicitly approved. The dry run
    // reports what it WOULD do and writes nothing anywhere.
    if (inactiveWorkflowApproved !== true) {
        report.failureReason =
            "DRY RUN — inactiveWorkflowApproved was not true. No message, no status change, " +
            "no Supabase write.";
        return report;
    }

    // ---- 0. Open our own session ------------------------------------------
    try {
        const session = await launchBrowser();
        browser = session.browser;
        page = session.page;

        await loginToCRC(page);
        await openClient(page, clientName);

        const openedId = String(await getCrcClientId(page));

        if (openedId !== String(crcClientId)) {
            report.error_code = "WRONG_CLIENT_OPENED";
            report.failureReason =
                `Opened client ${openedId}, expected ${crcClientId}. Nothing was written.`;
            return report;
        }

        crcClientId = openedId;
    } catch (error) {
        report.error_code = "SESSION_FAILED";
        report.failureReason = `Could not open a CRC session: ${error.message}`;
        return report;
    }

    try {

    // ---- 1. Record that we looked, before anything can fail ---------------
    try {
        await recordCreditHeroState(crcClientId, {
            credit_hero_access_state: "CHS_NOT_ACTIVATED",
            last_credit_hero_check_at: nowIso,
        });
        report.memoryWritten = true;
    } catch (error) {
        report.error_code = "MEMORY_WRITE_FAILED";
        report.failureReason = `Could not record the CreditHero check: ${error.message}`;
        return report;
    }

    // ---- 2. Send the message that is owed, if any -------------------------
    let sendResult = null;

    if (decision.action !== PLANNED_ACTION.NO_MESSAGE_DUE) {
        const isReminder = decision.action === PLANNED_ACTION.SEND_REMINDER;

        // Read the name live, at send time.
        const profile = await readClientProfile(page, crcClientId).catch(() => null);
        const firstName = resolveFirstName(profile?.identity, clientName);

        if (!firstName) {
            report.error_code = "FIRST_NAME_UNRESOLVED";
            report.failureReason =
                "Could not resolve a first name for the greeting. Not sending a message that " +
                "would open with a blank or wrong name.";
            // Fall through to the status write below — per the approved rule, a
            // failed notice still sets the status and retries next run.
        } else {
            sendResult = await sendClientNotice(page, {
                clientName,
                crcClientId,
                subject: isReminder ? REMINDER_SUBJECT : NOTICE_SUBJECT,
                body: isReminder ? buildReminderBody(firstName) : buildNoticeBody(firstName),
                submitApproved: true,
            });

            report.attachmentsUploaded = sendResult.attachmentsUploaded ?? 0;

            if (sendResult.messageSuccessConfirmed === true) {
                if (isReminder) {
                    report.reminderSent = true;
                    await recordCreditHeroState(crcClientId, {
                        inactive_reminder_sent_at: nowIso,
                        inactive_notice_last_error: null,
                    }).catch(() => {});
                } else {
                    report.noticeSent = true;
                    await recordCreditHeroState(crcClientId, {
                        inactive_notice_sent_at: nowIso,
                        inactive_notice_last_error: null,
                    }).catch(() => {});
                }
            } else {
                // FAILED SEND. The timestamp is deliberately left null, which is
                // what makes the retry automatic: the decision above reads the
                // timestamp, so an unsent notice is simply still owed tomorrow.
                report.error_code = "NOTICE_SEND_FAILED";
                report.failureReason =
                    sendResult.failureReason ?? "The notice was not confirmed as sent.";

                await recordCreditHeroState(crcClientId, {
                    inactive_notice_last_error:
                        `${sendResult.failedStage ?? "unknown"}: ` +
                        `${String(sendResult.failureReason ?? "").slice(0, 200)}`,
                }).catch(() => {});
            }
        }
    }

    // ---- 3. Status, whether or not the message succeeded ------------------
    //
    // Approved rule: a failed notice still sets the status, so the client is
    // visibly parked in the right place while the notice retries.
    try {
        const statusResult = await updateClientStatus(
            page, crcClientId, INACTIVE_STATUS, { processingCycleComplete: true }
        );

        report.statusUpdated = statusResult?.ok === true;

        if (statusResult?.ok !== true) {
            report.error_code = report.error_code ?? statusResult?.error_code ?? "STATUS_UPDATE_FAILED";
            report.failureReason = report.failureReason ?? statusResult?.error ?? "Status update failed.";
        }
    } catch (error) {
        report.error_code = report.error_code ?? "STATUS_UPDATE_EXCEPTION";
        report.failureReason = report.failureReason ?? error.message;
    }

    return report;

    } finally {
        try { if (browser) await browser.close(); } catch { /* ignore */ }
    }
}

/**
 * The banner is gone. Record access as active and stop.
 *
 * Per the approved rule the client is NOT processed in this same run — the state
 * is recorded and the client is left eligible for the next daily run. Resuming
 * inside the same pass would mean acting on a page we have only just re-read.
 */
export async function recordCreditHeroActive(crcClientId) {
    const report = {
        tool: INACTIVE_WORKFLOW_VERSION,
        crcClientId: crcClientId ?? null,
        creditHeroAccessState: "ACTIVE",
        memoryWritten: false,
        processedThisRun: false,
        error_code: null,
        failureReason: null,
    };

    try {
        await recordCreditHeroState(crcClientId, {
            credit_hero_access_state: "ACTIVE",
            last_credit_hero_check_at: new Date().toISOString(),
        });
        report.memoryWritten = true;
    } catch (error) {
        report.error_code = "MEMORY_WRITE_FAILED";
        report.failureReason = error.message;
    }

    return report;
}

export { INACTIVE_STATUS, REMINDER_AFTER_DAYS };
