/**
 * processClientQueue.js
 *
 * Production queue:
 *   CRC Clients grid -> eligible client names -> proven M7/M8 processor.
 *
 * The queue runs in the background so one long HTTP request does not time out.
 * Processing is strictly sequential. Supabase's existing M8 lock remains the
 * durable duplicate-send protection if the queue is restarted.
 */

import crypto from "node:crypto";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { runProductionClient } from "./processProductionClient.js";
// Diagnostic mode calls M7 DIRECTLY. runProductionClient() invokes M8 whenever
// M7 succeeds, so routing diagnostics through it would deliver letters to any
// client whose CreditHero access has since been restored.
import { runMilestone7 } from "./milestone7.js";

const jobs = new Map();

const SYSTEM_FAILURE_CODES = new Set([
    "CRC_LOGIN_FAILED",
    "BROWSERBASE_SESSION_FAILED",
    "SUPABASE_UNAVAILABLE",
]);
const MAX_RETAINED_RESULTS = 500;

const DEFAULT_ELIGIBLE_STATUSES = Object.freeze([
    "Client",
    "Ready for Processing",
]);

const KNOWN_STATUSES = Object.freeze([
    "Client",
    "Ready for Processing",
    "AI Processing",
    "Waiting for Bureau",
    "Waiting For Bureau",
    "Manual Review Required",
    "Inactive",
    "Cancelled",
    "Canceled",
]);

function normalize(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizedKey(value) {
    return normalize(value).toLocaleLowerCase("en-US");
}

function publicJob(job) {
    return {
        jobId: job.jobId,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        submitApproved: job.submitApproved,
        diagnosticOnly: job.diagnosticOnly === true,
        eligibleStatuses: job.eligibleStatuses,
        maxClients: job.maxClients,
        delayMs: job.delayMs,
        suppliedClientCount: job.clientNames.length,
        summary: { ...job.summary },
        currentClient: job.currentClient,
        queuePreview: job.queue.slice(0, 20),
        results: job.results.slice(-MAX_RETAINED_RESULTS),
        fatalError: job.fatalError,
    };
}

async function visibleRows(page) {
    return page.locator('[role="row"]:visible, table tr:visible');
}

async function extractVisibleClientRows(page) {
    const rows = await visibleRows(page);
    const count = await rows.count();
    const found = [];

    for (let i = 0; i < count; i += 1) {
        const row = rows.nth(i);
        const cells = row.locator('[role="gridcell"], td');
        const cellCount = await cells.count();

        if (cellCount === 0) continue; // header row

        const cellTexts = [];
        for (let c = 0; c < cellCount; c += 1) {
            const text = normalize(await cells.nth(c).innerText().catch(() => ""));
            if (text) cellTexts.push(text);
        }

        const anchors = row.locator("a:visible");
        let clientName = "";

        for (let a = 0; a < await anchors.count(); a += 1) {
            const text = normalize(await anchors.nth(a).innerText().catch(() => ""));
            if (text) {
                clientName = text;
                break;
            }
        }

        // CRC sometimes renders the name as a clickable styled span/div.
        if (!clientName && cellTexts.length > 0) {
            clientName = cellTexts[0];
        }

        if (!clientName) continue;

        const status =
            cellTexts.find((text) =>
                KNOWN_STATUSES.some((known) => normalizedKey(text) === normalizedKey(known))
            ) ?? null;

        found.push({
            clientName,
            status,
            rowText: normalize(await row.innerText().catch(() => "")),
        });
    }

    return found;
}

async function nextPageButton(page) {
    const candidates = [
        page.getByRole("button", { name: /go to next page/i }),
        page.locator('button[aria-label*="next page" i]'),
        page.locator('button[title*="next page" i]'),
    ];

    for (const candidate of candidates) {
        if (await candidate.count()) return candidate.first();
    }

    return null;
}

async function readEligibleQueue(eligibleStatuses) {
    const { browser, page } = await launchBrowser();

    try {
        await loginToCRC(page);

        const allRows = [];
        const seenPageSignatures = new Set();

        for (let pageNumber = 1; pageNumber <= 200; pageNumber += 1) {
            await page.waitForTimeout(1200);

            const rows = await extractVisibleClientRows(page);
            const signature = rows
                .map((row) => `${normalizedKey(row.clientName)}|${normalizedKey(row.status)}`)
                .join("||");

            if (seenPageSignatures.has(signature)) break;
            seenPageSignatures.add(signature);
            allRows.push(...rows);

            const next = await nextPageButton(page);
            if (!next) break;

            const disabled =
                (await next.isDisabled().catch(() => false)) ||
                (await next.getAttribute("aria-disabled")) === "true" ||
                (await next.getAttribute("disabled")) != null;

            if (disabled) break;

            await next.click();
            await page.waitForTimeout(1500);
        }

        const eligibleSet = new Set(eligibleStatuses.map(normalizedKey));
        const eligible = allRows.filter(
            (row) => row.status && eligibleSet.has(normalizedKey(row.status))
        );

        // Duplicate names cannot be safely processed by name search. Withhold all
        // ambiguous names rather than risk opening the wrong consumer.
        const nameCounts = new Map();
        for (const row of eligible) {
            const key = normalizedKey(row.clientName);
            nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
        }

        const queue = [];
        const ambiguous = [];

        for (const row of eligible) {
            if ((nameCounts.get(normalizedKey(row.clientName)) ?? 0) > 1) {
                ambiguous.push({
                    clientName: row.clientName,
                    status: row.status,
                    reason: "duplicate_client_name_requires_manual_review",
                });
            } else {
                queue.push({ clientName: row.clientName, status: row.status });
            }
        }

        return {
            queue,
            ambiguous,
            scannedRows: allRows.length,
            eligibleRows: eligible.length,
        };
    } finally {
        await browser.close().catch(() => {});
    }
}

/** Short identifier-ish strings only. Never free text, never objects. */
function safeCode(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 120) : null;
}

/**
 * Engine messages are static strings, but the M7 catch-all returns
 * error.message, which we do not control. Long digit runs are redacted so an
 * account or SSN fragment cannot ride out in a diagnostic field.
 */
function safeMessage(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.trim().replace(/\d{9,}/g, "[redacted]");
    return cleaned ? cleaned.slice(0, 300) : null;
}

/**
 * SAFE DIAGNOSTIC PROJECTION of an M7 result.
 *
 * WHITELIST ONLY. Every field is named explicitly; nothing is spread, and the
 * M7 object is never passed through. capture_result in particular is reduced to
 * its success flag, stage and code — it carries the whole M6 payload, including
 * the report model.
 *
 * Excluded by construction: report payloads, letter bodies, addresses, DOB,
 * SSN, identity objects, bureau data, PDF contents.
 */
function buildM7Diagnostic(m7) {
    if (!m7 || typeof m7 !== "object") return null;

    const lettersOk = m7.lettersOk === true || m7.letters_ok === true;
    const letters = Array.isArray(m7.letters) ? m7.letters : [];
    const withheld = Array.isArray(m7.withheld) ? m7.withheld : [];

    // Reason CODES and counts only — never the item, furnisher, or wording.
    const withheldReasons = {};

    for (const entry of withheld) {
        const code =
            safeCode(entry?.reasonCode) ??
            safeCode(entry?.code) ??
            safeCode(entry?.reason) ??
            "unspecified";
        withheldReasons[code] = (withheldReasons[code] ?? 0) + 1;
    }

    const capture = m7.capture_result ?? null;

    return {
        success: m7.success !== false,
        milestone: safeCode(m7.milestone),
        errorCode: safeCode(m7.code) ?? safeCode(m7.error_code),
        errorMessage: safeMessage(m7.message) ?? safeMessage(m7.error_message),
        stage: safeCode(m7.stage),
        lettersOk,
        letterCount: letters.length,
        withheldCount: withheld.length,
        withheldReasons,
        // Import-audit / CreditHero state IF the engines already emit one. Read
        // from several spellings because we do not yet know which is populated;
        // absent everywhere, this stays null rather than inventing a category.
        importAuditState:
            safeCode(m7.importAuditState) ?? safeCode(m7.import_audit_state) ?? null,
        creditHeroAccessState:
            safeCode(m7.creditHeroAccessState) ?? safeCode(m7.credit_hero_access_state) ?? null,
        capture: capture && typeof capture === "object"
            ? {
                success: capture.success !== false,
                code: safeCode(capture.code) ?? safeCode(capture.error_code),
                stage: safeCode(capture.stage),
                message: safeMessage(capture.message),
                importAuditState:
                    safeCode(capture.importAuditState) ?? safeCode(capture.import_audit_state) ?? null,
                creditHeroAccessState:
                    safeCode(capture.creditHeroAccessState) ??
                    safeCode(capture.credit_hero_access_state) ?? null,
            }
            : null,
    };
}

/**
 * Diagnostic runs never produce an M8 result, so "sent" is unreachable. System
 * failures are still detected so a dead session stops the run instead of
 * grinding through the whole allow-list.
 */
function diagnosticClassification(result) {
    const code = safeCode(result?.m7?.code);

    if (code && SYSTEM_FAILURE_CODES.has(code)) return "fatal";

    return result?.ok === true ? "diagnosticReady" : "diagnosticBlocked";
}

function classifyResult(result) {
    if (result?.duplicatePrevented === true || result?.m8?.duplicatePrevented === true) {
        return "duplicatePrevented";
    }

    if (
        result?.ok === true &&
        result?.m8?.messageSuccessConfirmed === true &&
        result?.m8?.deliveryMarkerPersisted === true
    ) {
        return "sent";
    }

    const systemFailureCodes = SYSTEM_FAILURE_CODES;

    const code =
        result?.failureReason ??
        result?.blockedReason ??
        result?.m8?.failureReason ??
        result?.m8?.blockedReason ??
        result?.m7?.code ??
        null;

    if (systemFailureCodes.has(code)) return "fatal";

    return "manualReview";
}

async function runJob(job) {
    job.status = "scanning_crc";
    job.startedAt = new Date().toISOString();

    try {
        if (job.clientNames.length > 0) {
            // Urgent production path: use the explicit exported client-name queue.
            // Each name is still opened in CRC by the proven M7 flow, and the
            // authoritative CRC Client ID is derived from the opened dashboard
            // before Supabase or M8 delivery is touched.
            job.status = "loading_supplied_queue";

            const counts = new Map();
            for (const clientName of job.clientNames) {
                const key = normalizedKey(clientName);
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }

            const uniqueQueue = [];
            for (const clientName of job.clientNames) {
                if ((counts.get(normalizedKey(clientName)) ?? 0) > 1) {
                    job.results.push({
                        clientName,
                        status: "manual_review",
                        reason: "duplicate_client_name_requires_manual_review",
                    });
                    job.summary.manualReview += 1;
                    job.summary.ambiguousNames += 1;
                } else {
                    uniqueQueue.push({ clientName, status: "supplied" });
                }
            }

            job.summary.scannedRows = job.clientNames.length;
            job.summary.eligibleRows = job.clientNames.length;
            job.queue = uniqueQueue.slice(0, job.maxClients);
        } else {
            const scan = await readEligibleQueue(job.eligibleStatuses);

            job.summary.scannedRows = scan.scannedRows;
            job.summary.eligibleRows = scan.eligibleRows;
            job.summary.ambiguousNames = scan.ambiguous.length;

            for (const item of scan.ambiguous) {
                job.results.push({
                    clientName: item.clientName,
                    status: "manual_review",
                    reason: item.reason,
                });
                job.summary.manualReview += 1;
            }

            job.queue = scan.queue.slice(0, job.maxClients);
        }

        job.summary.queued = job.queue.length;
        job.status = "processing";

        for (let index = 0; index < job.queue.length; index += 1) {
            const item = job.queue[index];
            job.currentClient = {
                index: index + 1,
                total: job.queue.length,
                clientName: item.clientName,
                startedAt: new Date().toISOString(),
            };

            let result;

            try {
                if (job.diagnosticOnly) {
                    // M8 IS UNREACHABLE FROM HERE. This branch calls
                    // runMilestone7() directly; runProductionClient() — the only
                    // module in the queue's reach that calls runMilestone8() — is
                    // never invoked. There is no composer, no upload, no submit,
                    // no CRC status write, no delivery lock, no completion
                    // marker, and no round change on this path, because none of
                    // that code is called at all.
                    const m7 = await runMilestone7({ clientName: item.clientName });
                    const lettersOk = m7?.lettersOk === true || m7?.letters_ok === true;

                    result = {
                        clientName: item.clientName,
                        diagnosticOnly: true,
                        ok: m7?.success !== false && lettersOk,
                        stage: "m7_diagnostic",
                        m7,
                    };
                } else {
                    result = await runProductionClient({
                        clientName: item.clientName,
                        processingApproved: true,
                        submitApproved: job.submitApproved,
                    });
                }
            } catch (error) {
                result = {
                    ok: false,
                    clientName: item.clientName,
                    failureReason: "UNHANDLED_CLIENT_ERROR",
                    error: error.message,
                };
            }

            const classification = job.diagnosticOnly
                ? diagnosticClassification(result)
                : classifyResult(result);

            job.summary.processed += 1;

            if (classification === "sent") job.summary.sent += 1;
            if (classification === "duplicatePrevented") job.summary.duplicatePrevented += 1;
            if (classification === "manualReview") job.summary.manualReview += 1;
            if (classification === "fatal") job.summary.failed += 1;
            if (classification === "diagnosticReady") job.summary.diagnosticReady += 1;
            if (classification === "diagnosticBlocked") job.summary.diagnosticBlocked += 1;

            // Aggregate by the values the engines ACTUALLY returned. No category
            // is invented: whatever code/stage arrives becomes the key, and
            // results carrying neither are grouped as "unclassified".
            const m7Diagnostic = buildM7Diagnostic(result?.m7);

            if (job.diagnosticOnly) {
                const groupKey =
                    m7Diagnostic?.errorCode ??
                    m7Diagnostic?.capture?.code ??
                    m7Diagnostic?.stage ??
                    m7Diagnostic?.capture?.stage ??
                    (m7Diagnostic?.lettersOk === true ? "letters_ready" : null) ??
                    "unclassified";

                job.summary.diagnosticGroups[groupKey] =
                    (job.summary.diagnosticGroups[groupKey] ?? 0) + 1;
            }

            job.results.push({
                clientName: item.clientName,
                crcClientId: result?.crcClientId ?? null,
                status: classification,
                ok: result?.ok === true,
                stage: result?.stage ?? null,
                // THE FIX. The m7-blocked branch of runProductionClient() returns
                // the full M7 object as `m7` and never sets `m7Summary`, so this
                // key coalesced to null and the reason was discarded. Fall back
                // to a safe projection of what was there all along.
                m7Summary: result?.m7Summary ?? m7Diagnostic ?? null,
                m7Diagnostic,
                m8: result?.m8
                    ? {
                        finalStatus: result.m8.finalStatus ?? null,
                        messageSubmitted: result.m8.messageSubmitted ?? false,
                        messageSuccessConfirmed: result.m8.messageSuccessConfirmed ?? false,
                        duplicatePrevented: result.m8.duplicatePrevented ?? false,
                        deliveryMarkerPersisted: result.m8.deliveryMarkerPersisted ?? false,
                        statusUpdateOk: result.m8.statusUpdateResult?.ok ?? false,
                        blockedReason: result.m8.blockedReason ?? null,
                        failureReason: result.m8.failureReason ?? null,
                    }
                    : null,
                blockedReason: result?.blockedReason ?? null,
                failureReason: result?.failureReason ?? null,
                error: result?.error ?? null,
            });

            if (classification === "fatal") {
                job.status = "stopped_system_failure";
                job.fatalError = {
                    clientName: item.clientName,
                    result: job.results[job.results.length - 1],
                };
                break;
            }

            if (index < job.queue.length - 1 && job.delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, job.delayMs));
            }
        }

        if (job.status !== "stopped_system_failure") {
            job.status = "complete";
        }
    } catch (error) {
        job.status = "failed";
        job.fatalError = {
            message: error.message,
            stack: error.stack,
        };
    } finally {
        job.currentClient = null;
        job.completedAt = new Date().toISOString();
    }
}

export function startClientQueue(data = {}) {
    if (data.processingApproved !== true) {
        return {
            ok: false,
            blockedReason: "processing_not_approved",
        };
    }

    // Diagnostic mode runs M7 only and cannot reach M8, so submit approval is
    // not merely unnecessary — there is nothing for it to approve.
    const diagnosticOnly = data.diagnosticOnly === true;

    if (!diagnosticOnly && data.submitApproved !== true) {
        return {
            ok: false,
            blockedReason: "submit_approval_required_for_production_queue",
        };
    }

    const eligibleStatuses = Array.isArray(data.eligibleStatuses)
        ? data.eligibleStatuses.map(normalize).filter(Boolean)
        : [...DEFAULT_ELIGIBLE_STATUSES];

    const maxClients =
        Number.isInteger(Number(data.maxClients)) && Number(data.maxClients) > 0
            ? Math.min(Number(data.maxClients), 1000)
            : 1000;

    const delayMs =
        Number.isFinite(Number(data.delayMs)) && Number(data.delayMs) >= 0
            ? Math.min(Number(data.delayMs), 60000)
            : 3000;

    const clientNames = Array.isArray(data.clientNames)
        ? data.clientNames
            .map(normalize)
            .filter(Boolean)
        : [];

    // A diagnostic pass targets a known list. Requiring names here also keeps
    // readEligibleQueue() — the only CRC scan, and the only browser launch in
    // this module — structurally out of reach.
    if (diagnosticOnly && clientNames.length === 0) {
        return {
            ok: false,
            blockedReason: "diagnostic_mode_requires_explicit_client_names",
        };
    }

    const jobId = crypto.randomUUID();
    const job = {
        jobId,
        status: "queued",
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        submitApproved: diagnosticOnly ? false : true,
        diagnosticOnly,
        eligibleStatuses,
        maxClients,
        delayMs,
        clientNames,
        queue: [],
        currentClient: null,
        results: [],
        fatalError: null,
        summary: {
            scannedRows: 0,
            eligibleRows: 0,
            ambiguousNames: 0,
            queued: 0,
            processed: 0,
            sent: 0,
            duplicatePrevented: 0,
            manualReview: 0,
            failed: 0,
            diagnosticReady: 0,
            diagnosticBlocked: 0,
            diagnosticGroups: {},
        },
    };

    jobs.set(jobId, job);
    void runJob(job);

    return {
        ok: true,
        jobId,
        status: job.status,
        statusPath: `/process-client-queue/${jobId}`,
        diagnosticOnly,
        note: diagnosticOnly
            ? "DIAGNOSTIC ONLY: M7 analysis, no delivery. Nothing is sent, no status " +
              "is changed, no lock is taken, no round advances. Poll statusPath for progress. " +
              "Do not redeploy Railway while this job is running."
            : "Production queue started in the background. Poll statusPath for progress. " +
              "Do not redeploy Railway while this job is running.",
    };
}

export function getClientQueueJob(jobId) {
    const job = jobs.get(jobId);
    return job ? publicJob(job) : null;
}
