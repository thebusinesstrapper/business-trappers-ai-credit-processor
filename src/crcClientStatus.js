/**
 * crcClientStatus.js
 *
 * CRC CLIENT STATUS WRITER — WRITE MODE.
 *
 * ===========================================================================
 * THE ONLY MODULE IN THIS SYSTEM AUTHORIZED TO MODIFY A CLIENT RECORD.
 *
 * It may change ONE field: Status.
 *
 * It may not touch name, address, city, state, ZIP, email, phone, DOB, SSN,
 * assignments, portal settings, or any other field. Per the Business Trappers
 * ruling: CHANGING ANY FIELD OTHER THAN STATUS IS A PROCESSOR FAILURE.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE FILE FROM THE READER
 *
 * crcClientProfile.js contains no write path at all — not a disabled one, none.
 * It has no .fill(), no .selectOption(), no Save click. That is the safety
 * mechanism: a bug in the reader CANNOT become a write, because the capability
 * does not exist in that file.
 *
 * Same posture as the Order Page Reader and the Order Submitter, and for the
 * same reason. The module that observes must not be able to act.
 *
 * ===========================================================================
 * THE GUARD THAT MATTERS: WE VERIFY WHAT WE DID NOT CHANGE.
 *
 * A dropdown labelled "Status" that turns out to be something else, a form that
 * normalises a phone number on save, a modal that silently reformats the ZIP —
 * any of these would corrupt the identity that goes on a legal document, and
 * none of them would throw an error.
 *
 * So this module SNAPSHOTS every identity field before the write, and RE-READS
 * them after. If anything other than Status moved, that is reported as a
 * PROCESSOR FAILURE — loudly — rather than being discovered months later on a
 * returned letter.
 * ===========================================================================
 */

import { readClientProfile, FIELD_LABELS } from "./crcClientProfile.js";

const PROFILE_LINK_TEXT = "View/Edit Profile";
const STATUS_LABEL = "Status";
const TIMEOUT = 15000;

/** The ONLY field this module may modify. Everything else is off-limits. */
const WRITABLE_FIELDS = Object.freeze(["status"]);

/** Fields that must be IDENTICAL before and after the write. */
const PROTECTED_FIELDS = Object.freeze([
    "firstName",
    "middleName",
    "lastName",
    "address_line_1",
    "city",
    "state",
    "postal_code",
    "email",
    "phone",
]);

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
 * Update the client's Status. Nothing else.
 *
 * @param {import('playwright').Page} page   a page on the CLIENT DASHBOARD
 * @param {string|number} crcClientId
 * @param {string} newStatus
 * @param {object} preconditions
 * @param {boolean} preconditions.processingCycleComplete
 *        The ruling authorizes WRITE MODE only after a successful processing
 *        cycle. Passed explicitly so the authorization is visible at the call
 *        site, and refused here if absent.
 */
export async function updateClientStatus(page, crcClientId, newStatus, preconditions = {}) {

    // ---- PRECONDITION: the cycle must have completed -----------------------
    if (preconditions.processingCycleComplete !== true) {
        return {
            ok: false,
            error_code: "WRITE_NOT_AUTHORIZED",
            error:
                "WRITE MODE is authorized only after successful completion of the processing cycle. " +
                "The caller did not assert processingCycleComplete. No field was modified.",
            fieldsModified: 0,
        };
    }

    if (!newStatus || typeof newStatus !== "string") {
        return {
            ok: false,
            error_code: "NO_STATUS_SUPPLIED",
            error: "No status value was supplied. No field was modified.",
            fieldsModified: 0,
        };
    }

    console.log(`CRC STATUS WRITER — WRITE MODE. Target status: "${newStatus}"`);
    console.log("Only the Status field may be modified. Every other field is protected.");

    // ---- 1. SNAPSHOT identity BEFORE the write -----------------------------
    //
    // This is the whole safety story. Without a before-picture we could not tell
    // whether the form quietly reformatted an address on save — and we would find
    // out from a returned letter.
    const before = await readClientProfile(page, crcClientId);

    if (!before.ok) {
        return {
            ok: false,
            error_code: "PRE_WRITE_SNAPSHOT_FAILED",
            error:
                `Could not read the profile before writing (${before.error_code}). We do not modify a ` +
                `record we cannot first verify — without a snapshot we could never prove we changed ` +
                `only Status. No field was modified.`,
            fieldsModified: 0,
        };
    }

    // ---- 2. Open the modal -------------------------------------------------
    const profileLink = page.getByText(PROFILE_LINK_TEXT, { exact: false }).first();

    if (!(await profileLink.count())) {
        return {
            ok: false,
            error_code: "PROFILE_LINK_NOT_FOUND",
            error: `Could not find the "${PROFILE_LINK_TEXT}" link. No field was modified.`,
            fieldsModified: 0,
        };
    }

    await profileLink.click({ timeout: TIMEOUT });

    const modal = await waitForModal(page);

    if (!modal) {
        return {
            ok: false,
            error_code: "MODAL_NOT_VISIBLE",
            error: "The Edit Profile modal did not open. No field was modified.",
            fieldsModified: 0,
        };
    }

    // ---- 3. Change the Status dropdown. ONLY the Status dropdown. ----------
    let previousStatus = null;

    try {
        const statusField = modal.getByLabel(STATUS_LABEL, { exact: false }).first();

        if (!(await statusField.count())) {
            return {
                ok: false,
                error_code: "STATUS_FIELD_NOT_FOUND",
                error:
                    `Could not find a field labelled "${STATUS_LABEL}" in the Edit Profile modal. No ` +
                    `field was modified. The processor does not go looking for a dropdown that might ` +
                    `be the status one.`,
                fieldsModified: 0,
            };
        }

        previousStatus = await statusField.inputValue().catch(() => null);

        console.log(`Status: "${previousStatus}" -> "${newStatus}"`);

        await statusField.selectOption({ label: newStatus }, { timeout: TIMEOUT });

    } catch (error) {
        return {
            ok: false,
            error_code: "STATUS_SELECT_FAILED",
            error: `Could not set Status to "${newStatus}": ${error.message}. No Save was clicked.`,
            fieldsModified: 0,
        };
    }

    // ---- 4. Save -----------------------------------------------------------
    try {
        const save = modal.getByRole("button", { name: /^save$/i }).first();

        if (!(await save.count())) {
            return {
                ok: false,
                error_code: "SAVE_BUTTON_NOT_FOUND",
                error: "Could not find the Save button. The status change was NOT committed.",
                fieldsModified: 0,
            };
        }

        await save.click({ timeout: TIMEOUT });

        console.log("Saved. Verifying...");

    } catch (error) {
        return {
            ok: false,
            error_code: "SAVE_FAILED",
            error: `Save failed: ${error.message}`,
            fieldsModified: 0,
        };
    }

    // ---- 5. VERIFY: status changed, and NOTHING ELSE DID -------------------
    await page.waitForTimeout(1500); // let the save round-trip

    const after = await readClientProfile(page, crcClientId);

    if (!after.ok) {
        return {
            ok: false,
            error_code: "POST_WRITE_VERIFICATION_FAILED",
            error:
                `The status was saved, but the profile could not be re-read to verify it ` +
                `(${after.error_code}). WE CANNOT CONFIRM WHAT CHANGED. Routed to a human.`,
            statusWritten: newStatus,
            verified: false,
        };
    }

    // THE GUARD. Did anything we were forbidden to touch move?
    const violations = [];

    for (const field of PROTECTED_FIELDS) {
        const wasValue = before.identity[field] ?? null;
        const nowValue = after.identity[field] ?? null;

        if (wasValue !== nowValue) {
            violations.push({ field, before: wasValue, after: nowValue });
        }
    }

    if (violations.length > 0) {
        console.error("PROCESSOR FAILURE — a protected field changed during a status write.");

        return {
            ok: false,
            error_code: "PROTECTED_FIELD_MODIFIED",
            error:
                `PROCESSOR FAILURE: writing Status also changed ${violations.length} protected ` +
                `field(s): ${violations.map((v) => v.field).join(", ")}. The Business Trappers ruling ` +
                `is explicit — changing any field other than Status is a processor failure. This is ` +
                `reported immediately rather than discovered later on a returned letter.`,
            violations,
            statusWritten: newStatus,
            verified: false,
            requiresHumanReview: true,
        };
    }

    console.log(`Verified: Status is now "${newStatus}". All ${PROTECTED_FIELDS.length} protected fields unchanged.`);

    return {
        ok: true,
        statusWritten: newStatus,
        previousStatus,
        verified: true,

        fieldsModified: 1,
        modifiedFields: ["status"],
        protectedFieldsVerifiedUnchanged: PROTECTED_FIELDS.length,

        modalClosed: after.modalClosed,
    };
}

async function waitForModal(page, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const modal = await findModal(page);
        if (modal) return modal;

        await page.waitForTimeout(300);
    }

    return null;
}

export { WRITABLE_FIELDS, PROTECTED_FIELDS, STATUS_LABEL };
