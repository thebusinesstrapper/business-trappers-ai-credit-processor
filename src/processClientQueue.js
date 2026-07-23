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
import { recordCreditHeroState } from "./clientMemory.js";

const jobs = new Map();

const SYSTEM_FAILURE_CODES = new Set([
    "CRC_LOGIN_FAILED",
    "BROWSERBASE_SESSION_FAILED",
    "SUPABASE_UNAVAILABLE",
]);
const MAX_RETAINED_RESULTS = 500;

/**
 * ===========================================================================
 * ELIGIBILITY IS A DENYLIST, NOT AN ALLOWLIST.
 *
 * This was previously an allowlist of three statuses, which silently excluded
 * "Waiting For Bureau", "Manual Review Required", "AI Processing" and anything
 * else from daily evaluation. A client parked in Manual Review Required was
 * never looked at again by the processor.
 *
 * APPROVED RULE: every active client is evaluated every day. Exactly two
 * statuses are terminal or paused, and only those two are excluded:
 *
 *   Complete   — terminal. The dispute lifecycle finished.
 *   Suspended  — a REVERSIBLE manual pause. Excluded from processing, but its
 *                round, dates, memory and history are left completely intact
 *                and it is never converted to Complete.
 *
 * Both labels are exact, confirmed against the live CRC Status dropdown.
 *
 * Everything else — including Waiting For Bureau — stays eligible. Waiting For
 * Bureau clients are cheap to evaluate because processProductionClient's daily
 * preflight reads next_eligible_date from Supabase and short-circuits BEFORE
 * launching a browser when a verified future date has not arrived.
 * ===========================================================================
 */
const DEFAULT_EXCLUDED_STATUSES = Object.freeze([
    "Complete",
    "Suspended",
]);

const KNOWN_STATUSES = Object.freeze([
    "Client",
    "Credit Monitoring Inactive",
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
        inactiveWorkflowApproved: job.inactiveWorkflowApproved === true,
        operationalRoutingApproved: job.operationalRoutingApproved === true,
        excludedStatuses: job.excludedStatuses,
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

// CRC's MUI DataGrid, confirmed against the live DOM.
//
// Two things here are not what a generic DataGrid reader would assume:
//
//   1. Cells carry role="cell", NOT role="gridcell". Waiting on gridcell waits
//      forever on a fully-populated page.
//   2. ONE client is rendered as TWO row fragments — the pinned left/name
//      section and the center/status section — each a separate role="row"
//      element carrying the SAME data-id. Name and status therefore do not
//      co-exist inside one row element, and counting row elements counts every
//      client twice.
//
// So rows are grouped by data-id and one logical client is emitted per id.
const GRID_ROW_SELECTOR = '[role="row"][data-id]';
const NAME_CELL_SELECTOR = '[role="cell"][data-field="name"]';
const STATUS_CELL_SELECTOR = '[role="cell"][data-field="status_name"]';
const STATUS_VALUE_SELECTOR = ".clientStatusValue";

const ROWS_READY_TIMEOUT_MS = 15000;
const ROWS_POLL_MS = 250;

/**
 * Wait for real client cells to exist.
 *
 * The scan previously ran after a flat 1200ms sleep, so a grid that painted
 * slightly later reported scannedRows: 0 on a page about to be full of clients.
 * A fixed sleep cannot tell "empty" from "not painted yet".
 *
 * Waits on the NAME cell specifically: it is the field we cannot proceed
 * without, and header rows do not have one.
 */
async function waitForGridRows(page, timeoutMs = ROWS_READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const cells = await page.locator(NAME_CELL_SELECTOR).count().catch(() => 0);
        if (cells > 0) return true;
        await page.waitForTimeout(ROWS_POLL_MS);
    }

    return false;
}

async function visibleRows(page) {
    return page.locator(GRID_ROW_SELECTOR);
}

/** Read the client name from a row fragment, or "" if this fragment lacks it. */
async function readNameFromFragment(row) {
    const cell = row.locator(NAME_CELL_SELECTOR).first();

    if (!(await cell.count().catch(() => 0))) return "";

    const anchor = cell.locator("a").first();

    if (await anchor.count().catch(() => 0)) {
        const viaAnchor = normalize(await anchor.innerText().catch(() => ""));
        if (viaAnchor) return viaAnchor;
    }

    // Fallback: the cell text, for a name rendered without an anchor.
    return normalize(await cell.innerText().catch(() => ""));
}

/** Read the status from a row fragment, or null if this fragment lacks it. */
async function readStatusFromFragment(row) {
    const cell = row.locator(STATUS_CELL_SELECTOR).first();

    if (!(await cell.count().catch(() => 0))) return null;

    const value = cell.locator(STATUS_VALUE_SELECTOR).first();

    if (await value.count().catch(() => 0)) {
        const text = normalize(await value.innerText().catch(() => ""));
        if (text) return text;

        // Fallback: the title attribute carries the same label.
        const title = normalize(await value.getAttribute("title").catch(() => ""));
        if (title) return title;
    }

    const cellText = normalize(await cell.innerText().catch(() => ""));
    return cellText || null;
}

/**
 * Return ONE entry per logical client, joined across pinned/center fragments.
 * Header rows are excluded structurally: they carry no data-id, so the selector
 * never returns them.
 */
async function extractVisibleClientRows(page) {
    await waitForGridRows(page);

    const rows = await visibleRows(page);
    const count = await rows.count();

    // data-id -> merged client. A Map both joins fragments and de-duplicates.
    const byId = new Map();

    for (let i = 0; i < count; i += 1) {
        const row = rows.nth(i);

        const dataId = normalize(await row.getAttribute("data-id").catch(() => ""));
        if (!dataId) continue; // header/spacer row

        const entry = byId.get(dataId) ?? {
            crcClientId: dataId,
            clientName: "",
            status: null,
            rowText: "",
        };

        if (!entry.clientName) {
            const name = await readNameFromFragment(row);
            if (name) entry.clientName = name;
        }

        if (!entry.status) {
            const status = await readStatusFromFragment(row);
            if (status) entry.status = status;
        }

        const fragmentText = normalize(await row.innerText().catch(() => ""));
        if (fragmentText) {
            entry.rowText = entry.rowText ? `${entry.rowText} ${fragmentText}` : fragmentText;
        }

        byId.set(dataId, entry);
    }

    // A client we cannot name cannot be opened, so it is not a queue candidate.
    return [...byId.values()].filter((entry) => entry.clientName);
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

async function readEligibleQueue(excludedStatuses) {
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

        // DENYLIST. A row is eligible unless its status is explicitly excluded.
        // A row whose status could not be read is NOT eligible — we do not
        // process a client whose CRC status we could not positively observe.
        const excludedSet = new Set(excludedStatuses.map(normalizedKey));
        const eligible = allRows.filter(
            (row) => row.status && !excludedSet.has(normalizedKey(row.status))
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
                queue.push({
                    clientName: row.clientName,
                    status: row.status,
                    // Carried so processProductionClient can run its Supabase
                    // preflight BEFORE launching a browser.
                    crcClientId: row.crcClientId ?? null,
                });
            }
        }

        // Every positively observed logical client, taken from allRows BEFORE
        // eligibility filtering. This is what lets an excluded status (e.g.
        // "Waiting For Bureau") reach the observation-memory sync in runJob()
        // without ever being placed into `queue` or `eligible` above — those
        // two arrays are unrelated to how `observations` is built.
        //
        // "Positively observed" means the scanner actually read a status for
        // that row; a row whose status cell never resolved (row.status is
        // null) contributes no observation.
        const observations = allRows
            .filter((row) => row.status)
            .map((row) => ({
                crcClientId: row.crcClientId ?? null,
                clientName: row.clientName,
                crcClientStatus: row.status,
            }));

        return {
            queue,
            ambiguous,
            scannedRows: allRows.length,
            eligibleRows: eligible.length,
            observations,
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
 * Reduce an engine failure sentence to a safe, comparable phrase.
 *
 * The CreditHero attempt reasons are the only thing that distinguishes "the
 * link is not present" from "the click did not navigate" — the difference
 * between an account that may be inactive and a page that was merely slow. They
 * are static sentences with runtime values interpolated in, so the sentence is
 * kept and the interpolations are stripped: URLs, angle brackets, and long digit
 * runs go, then the result is collapsed and truncated.
 */
function escapeForRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove the client's own name from engine text.
 *
 * M6 phrases CLIENT_NOT_OPENED as: Could not open client "<n>". The queue
 * already knows the name it dispatched, so we redact that exact string and its
 * name parts rather than trying to guess which quoted text is a person and which
 * is a UI label — "View CreditHeroScore Account" is quoted too, and is not PII.
 */
function redactClientName(value, clientName) {
    if (typeof value !== "string" || !value) return value;
    if (typeof clientName !== "string" || !clientName.trim()) return value;

    let out = value;
    const full = clientName.trim().replace(/\s+/g, " ");

    out = out.replace(new RegExp(escapeForRegex(full), "gi"), "[client]");

    // Individual name parts, in case the engine echoes only part of it.
    for (const part of full.split(" ")) {
        if (part.length >= 4 && /^[A-Za-z'-]+$/.test(part)) {
            out = out.replace(new RegExp(`\\b${escapeForRegex(part)}\\b`, "gi"), "[client]");
        }
    }

    return out;
}

function safeReason(value) {
    if (typeof value !== "string") return null;

    const cleaned = value
        .replace(/Current URL:.*$/i, "")     // trailing URL clause
        .replace(/https?:\/\/\S+/gi, "[url]")  // any other URL
        .replace(/[<>]/g, "")                // never raw markup
        .replace(/\d{9,}/g, "[redacted]")    // never a long identifier
        .replace(/\s+/g, " ")
        .trim();

    return cleaned ? cleaned.slice(0, 160) : null;
}

/** A finite number or null. */
function safeNumber(value) {
    return value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

/** Strict boolean or null — preserves the "not observed" (null) case. */
function safeBool(value) {
    return value === true ? true : value === false ? false : null;
}

/** ISO date YYYY-MM-DD or null. Rejects anything else rather than guessing. */
function safeIsoDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * Sanitize extraction text (an error or a warning) from the normalizer.
 *
 * WHY safeMessage() IS NOT ENOUGH HERE. It redacts runs of 9+ digits, which is
 * right for account numbers but blind to what these strings actually carry:
 * reportNormalize.js warns with `... masked account "****1234" ...`, and a
 * four-digit last-4 sails straight through a nine-digit rule.
 *
 * So the masked-account clause is redacted by NAME first, then any run of 4+
 * digits. Counts are not lost by this — they are reported separately as real
 * numbers in `counts` below.
 */
function safeExtractionText(value) {
    if (typeof value !== "string") return null;

    const cleaned = value
        .replace(/masked account\s*"[^"]*"/gi, 'masked account "[redacted]"')
        .replace(/\d{4,}/g, "[redacted]")
        .replace(/\s+/g, " ")
        .trim();

    return cleaned ? cleaned.slice(0, 240) : null;
}

/**
 * ---------------------------------------------------------------------------
 * EXTRACTION DIAGNOSTICS — the fields that identify WHICH normalization failure
 * occurred, sanitized for a job result.
 *
 * THE PROBLEM THIS SOLVES. milestone6.js already returns extraction_errors,
 * counts, completeness and key_resolution on its EXTRACTION_FAILED response.
 * buildM7Diagnostic()'s whitelist did not project any of them, so every
 * normalization failure arrived in the queue result as one indistinguishable
 * sentence: "The report was captured but could not be normalized with
 * confidence."
 *
 * There are FOUR distinct ways reportNormalize.js can set extraction_ok false,
 * and they need opposite fixes:
 *
 *   1. fail("NO_CREDIT_RESPONSE")  -> counts === null
 *   2. fail("NO_LIABILITIES")      -> counts === null
 *   3. (account,bureau) identity conflict -> counts set, tradelinesAmbiguous > 0
 *   4. required field never found  -> counts set, ambiguous 0, "REQUIRED FIELD"
 *
 * `countsPresent` alone separates {1,2} from {3,4}; the ambiguity counts
 * separate 3 from 4. That is the whole purpose of this projection.
 *
 * WHAT IS DELIBERATELY EXCLUDED. `payload` — the entire raw credit report — is
 * present on the M6 failure response by design (Extraction §8 requires the raw
 * capture to survive a failure) and is NEVER projected here. Neither are the
 * ambiguity entries' existing_identity / conflicting_identity objects, which
 * carry masked_account and furnisher. Only the bureau NAME leaves.
 * ---------------------------------------------------------------------------
 */
function buildExtractionDiagnostic(capture) {
    if (!capture || typeof capture !== "object") return null;

    const errors = Array.isArray(capture.extraction_errors) ? capture.extraction_errors : [];
    const counts = capture.counts ?? null;
    const keyResolution = capture.key_resolution ?? null;
    const completeness = capture.completeness ?? null;

    // Nothing extraction-related on this result: stay null rather than emit an
    // empty shell on every non-extraction failure.
    if (errors.length === 0 && !counts && !keyResolution && !completeness) return null;

    const ambiguousTradelines = Array.isArray(keyResolution?.tradelines?.ambiguous)
        ? keyResolution.tradelines.ambiguous
        : [];
    const ambiguousAccounts = Array.isArray(keyResolution?.accounts?.ambiguous)
        ? keyResolution.accounts.ambiguous
        : [];
    const warnings = Array.isArray(completeness?.warnings) ? completeness.warnings : [];

    return {
        // THE DISCRIMINATOR between the fail() paths and the late paths.
        countsPresent: counts !== null && counts !== undefined,

        counts: counts
            ? {
                raw_liability_rows: safeNumber(counts.raw_liability_rows),
                unique_accounts: safeNumber(counts.unique_accounts),
                account_bureau_tradelines: safeNumber(counts.account_bureau_tradelines),
                inquiries: safeNumber(counts.inquiries),
            }
            : null,

        keyResolution: keyResolution
            ? {
                accountsMatched: safeNumber(keyResolution.accounts?.matched),
                accountsMinted: safeNumber(keyResolution.accounts?.minted),
                accountsAmbiguous: ambiguousAccounts.length,
                tradelinesMatched: safeNumber(keyResolution.tradelines?.matched),
                tradelinesMinted: safeNumber(keyResolution.tradelines?.minted),
                tradelinesAmbiguous: ambiguousTradelines.length,
                // Bureau NAMES only. Never the identity objects beside them.
                ambiguityBureaus: [
                    ...new Set(ambiguousTradelines.map((a) => safeCode(a?.bureau)).filter(Boolean)),
                ].slice(0, 6),

                // ---- THE SHAPE OF EACH IDENTITY CONFLICT, WITHOUT ITS CONTENT --
                //
                // A tradeline identity conflict is a legitimate manual-review
                // outcome, but "1 conflict on experian" does not tell an operator
                // WHICH kind it is, and the fields that would — masked_account and
                // furnisher — are exactly the ones this projection must not emit.
                //
                // So the SHAPE is derived and the VALUES are dropped. Whether the
                // last-4 was readable, whether the masked accounts differ, whether
                // the furnishers differ: all booleans. None of them is PII, and
                // together they classify the conflict:
                //
                //   last4Readable [false,false] + furnisherDiffers false
                //       -> same furnisher, unreadable account numbers, differing
                //          masks. Almost certainly one tradeline described twice.
                //   last4Readable [false,false] + furnisherDiffers true
                //       -> two different furnishers on one Array account id.
                //          Either genuinely separate tradelines, or upstream
                //          account grouping is wrong.
                //
                // Either way a human decides. This only removes the need to open
                // the raw report to find out which question they are answering.
                conflicts: ambiguousTradelines.slice(0, 5).map((entry) => {
                    const existing = entry?.existing_identity ?? {};
                    const conflicting = entry?.conflicting_identity ?? {};

                    // Same canonicalisation reportNormalize uses, applied only to
                    // COMPARE. Neither canonical form is returned.
                    const canon = (v) =>
                        typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;

                    return {
                        rows: Array.isArray(entry?.rows) ? entry.rows.slice(0, 2) : null,
                        bureau: safeCode(existing.bureau) ?? safeCode(conflicting.bureau),
                        // Was a trailing 4 digits readable on each masked account?
                        last4Readable: [existing.last4 != null, conflicting.last4 != null],
                        maskedAccountPresent: [
                            existing.masked_account != null,
                            conflicting.masked_account != null,
                        ],
                        maskedAccountDiffers:
                            canon(existing.masked_account) !== canon(conflicting.masked_account),
                        furnisherDiffers:
                            (existing.furnisher_norm ?? null) !== (conflicting.furnisher_norm ?? null),
                    };
                }),
            }
            : null,

        // Field NAMES — schema, not data.
        fieldsNeverFound: Array.isArray(completeness?.fields_never_found)
            ? completeness.fields_never_found.map(safeCode).filter(Boolean).slice(0, 20)
            : [],
        fieldsPresentButNull: Array.isArray(completeness?.fields_present_but_null)
            ? completeness.fields_present_but_null.map(safeCode).filter(Boolean).slice(0, 20)
            : [],

        errorCount: errors.length,
        errors: errors.map(safeExtractionText).filter(Boolean).slice(0, 8),

        warningCount: warnings.length,
        warnings: warnings.map(safeExtractionText).filter(Boolean).slice(0, 8),
    };
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
function buildM7Diagnostic(m7, clientName = null) {
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

    // M7 names this object DIFFERENTLY per path: capture_result on its failure
    // branches, capture on the success branch. Read both so the eligibility
    // metadata surfaces whether the client processed or was blocked.
    const capture = m7.capture_result ?? m7.capture ?? null;

    const attemptLog = Array.isArray(capture?.attemptLog)
        ? capture.attemptLog.slice(0, 10)
        : [];

    const attemptReasons = {};

    for (const entry of attemptLog) {
        const reason = redactClientName(safeReason(entry?.reason), clientName);
        if (reason) attemptReasons[reason] = (attemptReasons[reason] ?? 0) + 1;
    }

    return {
        success: m7.success !== false,
        milestone: safeCode(m7.milestone),
        errorCode: safeCode(m7.error_code) ?? safeCode(m7.code),
        errorMessage: redactClientName(
            safeMessage(m7.error_message) ?? safeMessage(m7.message), clientName),
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
                // response.js emits error_code / error_message, NOT code / message.
                // Reading only the short names left these null on every real result.
                code: safeCode(capture.code) ?? safeCode(capture.error_code),
                stage: safeCode(capture.stage),
                message: redactClientName(
                    safeMessage(capture.message) ?? safeMessage(capture.error_message), clientName),
                importAuditState:
                    safeCode(capture.importAuditState) ?? safeCode(capture.import_audit_state) ?? null,
                creditHeroAccessState:
                    safeCode(capture.creditHeroAccessState) ??
                    safeCode(capture.credit_hero_access_state) ?? null,
                // CreditHero retries three times and reports WHY each failed.
                // Attempt number and sanitized reason only — never the URL,
                // page title, client name, or markup those attempts saw.
                attempts: Number.isFinite(Number(capture.attempts))
                    ? Number(capture.attempts)
                    : null,
                attemptLog: attemptLog.map((entry) => ({
                    attempt: Number.isFinite(Number(entry?.attempt)) ? Number(entry.attempt) : null,
                    reason: redactClientName(safeReason(entry?.reason), clientName),
                })),
            }
            : null,
        // Distinct sanitized reasons with counts, so a 106-client run can be read
        // without opening every result.
        attemptReasons,

        // WHICH normalization failure occurred. Sanitized; never the payload.
        extraction: buildExtractionDiagnostic(capture),

        // ---- STAGE 1 (READ-ONLY): TEMPORARY ROLLOUT ELIGIBILITY METADATA -----
        //
        // Set by milestone6 on the order-page path AND the successful-M7 path
        // (both under capture.*). Whitelisted explicitly so the strict projection
        // preserves them. Diagnostic only — no routing, count, or grouping depends
        // on them. null is a real value here (a field the path did not observe).
        classification: safeCode(capture?.classification) ?? safeCode(m7.classification),
        lastReportDate: safeIsoDate(capture?.lastReportDate) ?? safeIsoDate(m7.lastReportDate),
        eligibilityHint: safeCode(capture?.eligibilityHint) ?? safeCode(m7.eligibilityHint),
        temporaryOverrideApplied:
            safeBool(capture?.temporaryOverrideApplied) ?? safeBool(m7.temporaryOverrideApplied),
        freeReportEnabled: safeBool(capture?.freeReportEnabled) ?? safeBool(m7.freeReportEnabled),
        nextFreeReportAvailableAt:
            safeIsoDate(capture?.nextFreeReportAvailableAt) ?? safeIsoDate(m7.nextFreeReportAvailableAt),
        paidReportPresent: safeBool(capture?.paidReportPresent) ?? safeBool(m7.paidReportPresent),
        paidReportPrice: safeNumber(capture?.paidReportPrice) ?? safeNumber(m7.paidReportPrice),
    };
}

/**
 * Diagnostic runs never produce an M8 result, so "sent" is unreachable. System
 * failures are still detected so a dead session stops the run instead of
 * grinding through the whole allow-list.
 */
function diagnosticClassification(result) {
    // response.js emits error_code. Reading only `code` meant this check was
    // comparing undefined and could never escalate a dead session.
    const code = safeCode(result?.m7?.error_code) ?? safeCode(result?.m7?.code);

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

    // Successful WAITING_FOR_FREE_REPORT routing: CRC was set to "Waiting For
    // Bureau" via the existing status-only helper, and no delivery was
    // attempted (m8 stays null on this path by construction — see
    // processProductionClient.js, which never calls runMilestone8() for
    // stage "waiting_for_free_report"). This is a genuine successful
    // operational-routing outcome, not a manual-review condition, and it must
    // not fall into the generic manualReview bucket below. It is also not
    // "sent" (no message was submitted) and not "fatal" (no system failure
    // occurred), so it needs its own classification.
    if (result?.ok === true && result?.stage === "waiting_for_free_report" && result?.m8 == null) {
        return "routedWaiting";
    }

    // Successful NO_ACTIONABLE_DISPUTE_ITEMS outcome: M7 succeeded but found
    // nothing currently within processing scope to dispute (letterCount:0,
    // withheldCount:0 — e.g. no negative accounts, or the only negative item
    // present is intentionally out of scope such as a bankruptcy). No CRC
    // status change occurs on this path, and m8 stays null by construction —
    // see processProductionClient.js, which never calls runMilestone8() for
    // stage "no_actionable_dispute_items". This is a genuine successful
    // outcome, not a manual-review condition, and must not fall into the
    // generic manualReview bucket below — mirrors the routedWaiting
    // classification immediately above.
    if (result?.ok === true && result?.stage === "no_actionable_dispute_items" && result?.m8 == null) {
        return "noActionableItems";
    }

    // Successful CHS_NOT_ACTIVATED inactive-routing outcome: CRC was CONFIRMED
    // updated to "Credit Monitoring Inactive" by runInactiveWorkflow(). This is
    // a successful operational-routing outcome, not a manual-review condition,
    // and must not fall into the generic manualReview bucket below — mirroring
    // routedWaiting / noActionableItems above.
    //
    // Deliberately gated on result.inactive.statusUpdated, NOT on result.ok
    // alone: processProductionClient.js sets
    //   ok = inactive.noticeSent || inactive.reminderSent || inactive.statusUpdated
    // so `ok` can be true from a notice alone even when the CRC status write
    // failed. Requiring statusUpdated === true reserves this classification for
    // a CONFIRMED CRC status change specifically.
    //
    // A FAILED NOTICE DOES NOT HIDE HERE. recipient_prefill_mismatch /
    // NOTICE_SEND_FAILED live on result.inactive (noticeSent, error_code,
    // failureReason) and are still returned in full on every job.results entry
    // below — this classification describes the CRC status change, and erases
    // nothing about the notice.
    if (
        result?.ok === true &&
        // BOTH stages route through runInactiveWorkflow() and both set CRC to
        // "Credit Monitoring Inactive". Matching only "credit_hero_inactive"
        // meant every PAYMENT_REQUIRED client — Brittney Jones among them — was
        // counted as generic manual review despite its CRC status having been
        // confirmed written. The stage string differed; the outcome did not.
        (result?.stage === "credit_hero_inactive" || result?.stage === "payment_required") &&
        result?.inactive?.statusUpdated === true
    ) {
        return "creditMonitoringInactive";
    }

    // Preflight short-circuit: a verified future eligibility date had not
    // arrived, so no browser was opened. A successful waiting outcome, not a
    // manual-review condition.
    if (result?.ok === true && result?.stage === "waiting_not_yet_eligible") {
        return "routedWaiting";
    }

    // Terminal. Reported so a Complete client appearing in a supplied-name run
    // is visibly skipped rather than silently counted as manual review.
    if (result?.ok === true && result?.stage === "complete_terminal") {
        return "alreadyComplete";
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

/**
 * Persist every positively observed CRC status into client_state, using the
 * existing narrow writer (recordCreditHeroState).
 *
 * OBSERVATION-ONLY, BY CONSTRUCTION:
 *   - no browser, no CRC navigation, no client open — this function receives
 *     already-scanned data and touches Supabase only
 *   - no M6/M7/M8, no notices, no messages, no CRC status write
 *   - current_round / processing_state are structurally unwritable through
 *     recordCreditHeroState() (they are simply absent from its whitelist)
 *   - each observation gets its OWN try/catch, so one bad write can never
 *     stop the sync, and the sync can never stop the queue that follows it
 *
 * @param {Array<{crcClientId, clientName, crcClientStatus}>} observations
 * @returns {Promise<{attempted:number, written:number, skipped:number, failed:number, failures:object[]}>}
 */
async function syncObservations(observations) {
    const result = {
        attempted: 0,
        written: 0,
        skipped: 0,
        failed: 0,
        failures: [],
    };

    for (const observation of observations ?? []) {
        result.attempted += 1;

        const crcClientId = observation?.crcClientId;

        // No usable identifier -> cannot write, but this is not a write
        // FAILURE (nothing was attempted against Supabase), so it is
        // counted as skipped rather than failed.
        if (!crcClientId || !/^\d+$/.test(String(crcClientId))) {
            result.skipped += 1;
            continue;
        }

        try {
            const write = await recordCreditHeroState(String(crcClientId), {
                crc_client_status: observation?.crcClientStatus,
            });

            if (write?.ok) {
                result.written += 1;
            } else {
                // e.g. client_state_row_not_found, or the status text was
                // rejected by validCrcClientStatus() inside the writer.
                result.skipped += 1;
            }
        } catch (error) {
            result.failed += 1;
            result.failures.push({
                crcClientId: crcClientId ?? null,
                clientName: observation?.clientName ?? null,
                error: error.message,
            });
        }
    }

    return result;
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
            const scan = await readEligibleQueue(job.excludedStatuses);

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

            // ---- OBSERVATION-MEMORY SYNC ---------------------------------
            //
            // scan.observations already holds every positively observed
            // logical client, BEFORE eligibility filtering — including
            // clients whose status excludes them from job.queue above (e.g.
            // "Waiting For Bureau"). Persisting them here is what lets such
            // a client be recorded in memory without ever being queued or
            // processed.
            //
            // Runs ONLY when both gates hold. Diagnostic runs are already
            // routed through the supplied-clientNames branch above and never
            // reach this scan, but the explicit check is kept so this block
            // stays safe on its own regardless of that routing.
            if (job.operationalRoutingApproved === true && job.diagnosticOnly !== true) {
                job.summary.observationSync = await syncObservations(scan.observations);
            } else {
                job.summary.observationSync = {
                    attempted: 0,
                    written: 0,
                    skipped: 0,
                    failed: 0,
                    failures: [],
                    skippedReason: "operational_routing_not_approved_or_diagnostic",
                };
            }
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
                        // Enables the Supabase preflight to run BEFORE a browser
                        // is launched. Null on a supplied-name run, where the
                        // preflight simply does not apply.
                        crcClientId: item.crcClientId ?? null,
                        processingApproved: true,
                        submitApproved: job.submitApproved,
                        inactiveWorkflowApproved: job.inactiveWorkflowApproved === true,
                        operationalRoutingApproved: job.operationalRoutingApproved === true,
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
            if (classification === "alreadyComplete") job.summary.alreadyComplete += 1;

            // Aggregate by the values the engines ACTUALLY returned. No category
            // is invented: whatever code/stage arrives becomes the key, and
            // results carrying neither are grouped as "unclassified".
            const m7Diagnostic = buildM7Diagnostic(result?.m7, item.clientName);

            if (job.diagnosticOnly) {
                // MOST SPECIFIC SAFE CODE FIRST. The broad M7 code says only that
                // the pipeline halted at capture; capture.code says what actually
                // happened. Grouping by the broad code made 106 different outcomes
                // look like one.
                const specificKey =
                    m7Diagnostic?.capture?.code ??
                    m7Diagnostic?.importAuditState ??
                    m7Diagnostic?.capture?.importAuditState ??
                    m7Diagnostic?.creditHeroAccessState ??
                    m7Diagnostic?.capture?.creditHeroAccessState ??
                    m7Diagnostic?.errorCode ??
                    m7Diagnostic?.stage ??
                    m7Diagnostic?.capture?.stage ??
                    (m7Diagnostic?.lettersOk === true ? "letters_ready" : null) ??
                    "unclassified";

                job.summary.diagnosticGroups[specificKey] =
                    (job.summary.diagnosticGroups[specificKey] ?? 0) + 1;

                // The broad M7 view, kept separately rather than discarded.
                const topLevelKey =
                    m7Diagnostic?.errorCode ??
                    m7Diagnostic?.stage ??
                    (m7Diagnostic?.lettersOk === true ? "letters_ready" : null) ??
                    "unclassified";

                job.summary.diagnosticTopLevelGroups[topLevelKey] =
                    (job.summary.diagnosticTopLevelGroups[topLevelKey] ?? 0) + 1;

                // Distinct CreditHero attempt reasons across the whole run. This is
                // what separates "link not present" from "click did not navigate".
                for (const [reason, count] of Object.entries(m7Diagnostic?.attemptReasons ?? {})) {
                    job.summary.diagnosticAttemptReasons[reason] =
                        (job.summary.diagnosticAttemptReasons[reason] ?? 0) + count;
                }
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
                creditHeroAccessState: result?.creditHeroAccessState ?? null,
                inactive: result?.inactive ?? null,

                // ---- STAGE 2: OPERATIONAL ROUTING METADATA -------------------
                //
                // Approval-gated branches return these; the projection must carry
                // them or an approval-false run looks like a silent no-op. `false`
                // and `null` are REAL values here (gate held, nothing written) —
                // preserved with ?? so they are never collapsed to "missing".
                classification: result?.classification ?? null,
                proposedAction: result?.proposedAction ?? null,
                statusUpdated:
                    result?.statusUpdated ??
                    result?.status?.statusUpdated ??
                    result?.inactive?.statusUpdated ??
                    false,
                memoryWritten:
                    result?.memoryWritten ??
                    result?.inactive?.memoryWritten ??
                    false,
                operationalRoutingApproved: job.operationalRoutingApproved === true,
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

/**
 * Statuses a job holds while it is still doing work. A job in any of these has
 * a live browser session, or is about to open one.
 */
const ACTIVE_JOB_STATUSES = Object.freeze([
    "queued",
    "scanning_crc",
    "loading_supplied_queue",
    "processing",
]);

/** The currently running job, if any. */
function findActiveJob() {
    for (const job of jobs.values()) {
        if (ACTIVE_JOB_STATUSES.includes(job.status)) return job;
    }

    return null;
}

export function startClientQueue(data = {}) {
    // ---- OVERLAPPING-RUN PROTECTION --------------------------------------
    //
    // Every call previously created a new background job unconditionally. Two
    // concurrent runs — an n8n retry, a double-fired schedule, a manual kick
    // during the daily window — would process the same 160 clients twice at the
    // same time.
    //
    // The delivery lock would still prevent duplicate LETTERS, and that
    // protection is untouched. But it does not prevent two sessions racing to
    // write the same CRC status, two inactive notices reaching one client, or
    // two acquisition attempts against one entitlement. Concurrency has to be
    // stopped here, not absorbed downstream.
    //
    // CHECKED FIRST, before approval or any other validation, so the answer is
    // the same regardless of what else the request contains.
    const active = findActiveJob();

    if (active) {
        return {
            ok: false,
            blockedReason: "queue_already_running",
            activeJobId: active.jobId,
            activeStatus: active.status,
            activeStartedAt: active.startedAt ?? active.createdAt,
            statusPath: `/process-client-queue/${active.jobId}`,
            note:
                "A queue run is already in progress. Poll statusPath for it rather than " +
                "starting a second run. Nothing was started.",
        };
    }

    if (data.processingApproved !== true) {
        return {
            ok: false,
            blockedReason: "processing_not_approved",
        };
    }

    // Diagnostic mode runs M7 only and cannot reach M8, so submit approval is
    // not merely unnecessary — there is nothing for it to approve.
    const diagnosticOnly = data.diagnosticOnly === true;

    // A production run must make its sending intent EXPLICIT — silence is still
    // rejected, exactly as before. What changed is that an explicit `false` is now
    // a valid answer rather than being treated as "unapproved".
    //
    // That enables production-path/no-submit mode: the real processProductionClient
    // path runs (so routing, the eligibility guard, and classification are all
    // exercised against a live client) while submitApproved stays false end to end,
    // so M8 cannot submit, no delivery lock is taken, and no round advances.
    const submitDecisionSupplied =
        data.submitApproved === true || data.submitApproved === false;

    if (!diagnosticOnly && !submitDecisionSupplied) {
        return {
            ok: false,
            blockedReason: "submit_approval_required_for_production_queue",
        };
    }

    // Denylist. A caller may extend it; the two defaults are always applied so
    // a malformed request can never make Complete or Suspended eligible.
    const suppliedExclusions = Array.isArray(data.excludedStatuses)
        ? data.excludedStatuses.map(normalize).filter(Boolean)
        : [];

    const excludedStatuses = [
        ...new Set([...DEFAULT_EXCLUDED_STATUSES, ...suppliedExclusions]),
    ];

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
        // A diagnostic run never sends, unconditionally.
        //
        // Otherwise the production DEFAULT stays true, but an explicitly supplied
        // `submitApproved: false` is now preserved instead of being overwritten.
        // Previously it was impossible to run the real production wrapper with
        // sending disabled, which left the eligibility guard as the single thing
        // standing between a stale report and delivered letters. This restores a
        // second, independent layer without changing the default.
        //
        // Strict === false, so only an explicit false disables sending; omitted,
        // null, undefined, or any other value keeps the production default.
        submitApproved: diagnosticOnly ? false : data.submitApproved !== false,
        diagnosticOnly,
        // A diagnostic run is read-only without exception, so neither the
        // inactive workflow nor operational routing can be armed inside one.
        inactiveWorkflowApproved: diagnosticOnly ? false : data.inactiveWorkflowApproved === true,
        operationalRoutingApproved: diagnosticOnly ? false : data.operationalRoutingApproved === true,
        excludedStatuses,
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
            alreadyComplete: 0,
            diagnosticGroups: {},
            diagnosticTopLevelGroups: {},
            diagnosticAttemptReasons: {},
            // Populated only when the CRC-scan branch runs (job.clientNames
            // was empty). Stays null on a supplied-name run, where there is
            // no scan and therefore nothing to observe.
            observationSync: null,
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
