/**
 * crcClientStatus.js
 *
 * CRC CLIENT STATUS WRITER — WRITE MODE.
 * The only client field this module may change is Status.
 * Identity fields are snapshotted before a real write and verified unchanged
 * afterward. A status that is already equivalent after case/whitespace
 * normalization is a verified no-op and is never saved again.
 */

import { readClientProfile } from "./crcClientProfile.js";

const PROFILE_LINK_TEXT = "View/Edit Profile";
const STATUS_LABEL = "Status";
const TIMEOUT = 15000;

const WRITABLE_FIELDS = Object.freeze(["status"]);

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

function normalizeText(value) {
    return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

async function describeStatusControl(statusField) {
    return statusField.evaluate((element) => {
        const tagName = element.tagName?.toLowerCase() ?? null;
        const role = element.getAttribute?.("role") ?? null;
        const value = "value" in element ? element.value : null;
        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? null;
        const options = tagName === "select"
            ? Array.from(element.options ?? []).map((option) => ({
                  label: option.textContent?.replace(/\s+/g, " ").trim() ?? "",
                  value: option.value,
                  selected: option.selected,
              }))
            : [];

        return {
            tagName,
            role,
            id: element.id || null,
            name: element.getAttribute?.("name") ?? null,
            value,
            text,
            options,
        };
    });
}

async function readStatusLabel(statusField) {
    const details = await describeStatusControl(statusField);
    if (details.tagName === "select") {
        const selected = details.options.find((option) => option.selected);
        return selected?.label ?? details.value ?? null;
    }
    return details.value || details.text || null;
}

async function selectStatus(page, modal, statusField, newStatus) {
    const target = normalizeText(newStatus);
    const details = await describeStatusControl(statusField);

    console.log(`Status control diagnostics: ${JSON.stringify(details)}`);

    if (details.tagName === "select") {
        const matchingOption = details.options.find(
            (option) => normalizeText(option.label) === target
        );
        if (!matchingOption) {
            throw new Error(
                `No native select option matched "${newStatus}". Available options: ` +
                details.options.map((option) => `${option.label} [${option.value}]`).join(" | ")
            );
        }
        await statusField.selectOption({ value: matchingOption.value }, { timeout: TIMEOUT });
        const selected = normalizeText(await readStatusLabel(statusField));
        if (selected !== target) {
            throw new Error(
                `Native select did not retain "${newStatus}" after selection. ` +
                `Observed "${await readStatusLabel(statusField)}".`
            );
        }
        return {
            method: "native_select_value",
            selectedValue: matchingOption.value,
            selectedLabel: matchingOption.label,
            control: details,
        };
    }

    await statusField.click({ timeout: TIMEOUT });
    const roots = [modal, page, ...page.frames()];
    const seen = new Set();
    const available = [];

    for (const root of roots) {
        if (!root || seen.has(root)) continue;
        seen.add(root);
        let options;
        try {
            options = root.getByRole("option");
        } catch {
            continue;
        }
        const count = await options.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
            const option = options.nth(index);
            const label = (await option.textContent().catch(() => ""))
                ?.replace(/\s+/g, " ").trim();
            if (!label) continue;
            available.push(label);
            if (normalizeText(label) === target) {
                await option.click({ timeout: TIMEOUT });
                const selected = normalizeText(await readStatusLabel(statusField));
                if (selected && selected !== target) {
                    throw new Error(
                        `Custom status control clicked "${newStatus}", but now reads ` +
                        `"${await readStatusLabel(statusField)}".`
                    );
                }
                return {
                    method: "custom_role_option",
                    selectedLabel: label,
                    control: details,
                };
            }
        }
    }

    throw new Error(
        `No custom dropdown option matched "${newStatus}". Available visible options: ` +
        (available.join(" | ") || "none found")
    );
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

async function readPersistedStatus(page) {
    const profileLink = page.getByText(PROFILE_LINK_TEXT, { exact: false }).first();
    if (!(await profileLink.count())) {
        return { ok: false, error_code: "PROFILE_LINK_NOT_FOUND_DURING_STATUS_VERIFY", status: null };
    }

    await profileLink.click({ timeout: TIMEOUT });
    const modal = await waitForModal(page);
    if (!modal) {
        return { ok: false, error_code: "MODAL_NOT_VISIBLE_DURING_STATUS_VERIFY", status: null };
    }

    const statusField = modal.getByLabel(STATUS_LABEL, { exact: false }).first();
    if (!(await statusField.count())) {
        return { ok: false, error_code: "STATUS_FIELD_NOT_FOUND_DURING_VERIFY", status: null };
    }

    return {
        ok: true,
        status: await readStatusLabel(statusField),
        diagnostics: await describeStatusControl(statusField),
    };
}

async function restoreFreshClientDashboard(page, crcClientId) {
    const dashboardUrl = `https://app.creditrepaircloud.com/app/clients/${crcClientId}/dashboard`;
    try {
        await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(750);
        return page.url().includes(`/app/clients/${crcClientId}/dashboard`);
    } catch {
        return false;
    }
}

export async function updateClientStatus(page, crcClientId, newStatus, preconditions = {}) {
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

    const before = await readClientProfile(page, crcClientId);
    if (!before.ok) {
        return {
            ok: false,
            error_code: "PRE_WRITE_SNAPSHOT_FAILED",
            error:
                `Could not read the profile before writing (${before.error_code}). We do not modify a ` +
                `record we cannot first verify. No field was modified.`,
            fieldsModified: 0,
        };
    }

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

    let previousStatus = null;
    try {
        const statusField = modal.getByLabel(STATUS_LABEL, { exact: false }).first();
        if (!(await statusField.count())) {
            return {
                ok: false,
                error_code: "STATUS_FIELD_NOT_FOUND",
                error:
                    `Could not find a field labelled "${STATUS_LABEL}" in the Edit Profile modal. ` +
                    "No field was modified.",
                fieldsModified: 0,
            };
        }

        previousStatus = await readStatusLabel(statusField);
        console.log(`Status: "${previousStatus}" -> "${newStatus}"`);

        // Case and whitespace variants are the same CRC status. Re-saving an
        // already-correct status creates risk and caused false partial failures.
        if (normalizeText(previousStatus) === normalizeText(newStatus)) {
            console.log(`Status already equivalent to target; no write required.`);
            return {
                ok: true,
                statusWritten: previousStatus,
                previousStatus,
                verified: true,
                noOp: true,
                fieldsModified: 0,
                modifiedFields: [],
                protectedFieldsVerifiedUnchanged: PROTECTED_FIELDS.length,
            };
        }

        const selection = await selectStatus(page, modal, statusField, newStatus);
        console.log(`Status selection method: ${selection.method}`);
    } catch (error) {
        return {
            ok: false,
            error_code: "STATUS_SELECT_FAILED",
            error: `Could not set Status to "${newStatus}": ${error.message}. No Save was clicked.`,
            fieldsModified: 0,
        };
    }

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
        console.log("Saved. Verifying from a fresh dashboard...");
    } catch (error) {
        return {
            ok: false,
            error_code: "SAVE_FAILED",
            error: `Save failed: ${error.message}`,
            fieldsModified: 0,
        };
    }

    await page.waitForTimeout(1000);

    const freshDashboard = await restoreFreshClientDashboard(page, crcClientId);
    if (!freshDashboard) {
        return {
            ok: false,
            error_code: "POST_WRITE_DASHBOARD_RESTORE_FAILED",
            error:
                "The status was saved, but a fresh client dashboard could not be restored for " +
                "verification. Do not repeat the write; route to manual review.",
            statusWritten: newStatus,
            verified: false,
        };
    }

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
                `field(s): ${violations.map((v) => v.field).join(", ")}.`,
            violations,
            statusWritten: newStatus,
            verified: false,
            requiresHumanReview: true,
        };
    }

    // readClientProfile closes the modal, so verify persisted Status from a
    // newly-opened modal on the fresh dashboard.
    const persisted = await readPersistedStatus(page);
    if (!persisted.ok) {
        return {
            ok: false,
            error_code: persisted.error_code,
            error:
                "Protected fields were unchanged, but CRC could not be re-opened to verify the stored " +
                "Status value. Do not repeat the write; verify the status manually.",
            statusWritten: newStatus,
            verified: false,
        };
    }

    if (normalizeText(persisted.status) !== normalizeText(newStatus)) {
        return {
            ok: false,
            error_code: "STATUS_PERSISTENCE_MISMATCH",
            error:
                `CRC saved the profile, but the stored Status is "${persisted.status}" instead of ` +
                `"${newStatus}".`,
            statusWritten: persisted.status,
            expectedStatus: newStatus,
            verified: false,
            statusDiagnostics: persisted.diagnostics,
        };
    }

    console.log(
        `Verified: Status is now "${persisted.status}". ` +
        `All ${PROTECTED_FIELDS.length} protected fields unchanged.`
    );

    return {
        ok: true,
        statusWritten: persisted.status,
        previousStatus,
        verified: true,
        fieldsModified: 1,
        modifiedFields: ["status"],
        protectedFieldsVerifiedUnchanged: PROTECTED_FIELDS.length,
        modalClosed: after.modalClosed,
        statusDiagnostics: persisted.diagnostics,
    };
}

export { WRITABLE_FIELDS, PROTECTED_FIELDS, STATUS_LABEL, normalizeText };