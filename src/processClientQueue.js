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

const jobs = new Map();
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
        eligibleStatuses: job.eligibleStatuses,
        maxClients: job.maxClients,
        delayMs: job.delayMs,
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

    const systemFailureCodes = new Set([
        "CRC_LOGIN_FAILED",
        "BROWSERBASE_SESSION_FAILED",
        "SUPABASE_UNAVAILABLE",
    ]);

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
                result = await runProductionClient({
                    clientName: item.clientName,
                    processingApproved: true,
                    submitApproved: job.submitApproved,
                });
            } catch (error) {
                result = {
                    ok: false,
                    clientName: item.clientName,
                    failureReason: "UNHANDLED_CLIENT_ERROR",
                    error: error.message,
                };
            }

            const classification = classifyResult(result);
            job.summary.processed += 1;

            if (classification === "sent") job.summary.sent += 1;
            if (classification === "duplicatePrevented") job.summary.duplicatePrevented += 1;
            if (classification === "manualReview") job.summary.manualReview += 1;
            if (classification === "fatal") job.summary.failed += 1;

            job.results.push({
                clientName: item.clientName,
                crcClientId: result?.crcClientId ?? null,
                status: classification,
                ok: result?.ok === true,
                stage: result?.stage ?? null,
                m7Summary: result?.m7Summary ?? null,
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

    if (data.submitApproved !== true) {
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

    const jobId = crypto.randomUUID();
    const job = {
        jobId,
        status: "queued",
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        submitApproved: true,
        eligibleStatuses,
        maxClients,
        delayMs,
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
        },
    };

    jobs.set(jobId, job);
    void runJob(job);

    return {
        ok: true,
        jobId,
        status: job.status,
        statusPath: `/process-client-queue/${jobId}`,
        note:
            "Production queue started in the background. Poll statusPath for progress. " +
            "Do not redeploy Railway while this job is running.",
    };
}

export function getClientQueueJob(jobId) {
    const job = jobs.get(jobId);
    return job ? publicJob(job) : null;
}
