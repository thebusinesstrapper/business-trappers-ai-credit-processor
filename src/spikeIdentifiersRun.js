import { successResponse, errorResponse } from "./response.js";
import { launchBrowser } from "./browserbase.js";
import { loginToCRC } from "./crcLogin.js";
import { openClient } from "./openClient.js";
import { openCreditHero } from "./openCreditHero.js";
import { openCreditReport } from "./openCreditReport.js";
import { extractTradelineRecords, analyzeIdentifiers } from "./spikeIdentifiers.js";

/**
 * IDENTIFIER COMPARISON SPIKE — DISPOSABLE SCAFFOLDING.
 *
 * Captures the Array.io report JSON for TWO existing report dates and tests each
 * vendor identifier for cross-time stability and cross-bureau correlation.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY, WITH ONE GUARDED EXCEPTION.
 *
 * Selecting an EXISTING historical report date from the date dropdown is the
 * only interaction this spike performs. It is explicitly approved.
 *
 * It must never order, refresh, purchase, or alter a report. So the date
 * selector is GUARDED (see isSafeHistoricalDateOption): an option is only ever
 * selected if its text parses as a date AND contains no ordering/refresh/
 * purchase language. Anything we cannot positively identify as an existing
 * historical date is skipped, not tried.
 *
 * The order page remains hard-blocked by openCreditReport.js throughout.
 * ---------------------------------------------------------------------------
 */

const ARRAY_REPORT_URL_PATTERN = /array\.io\/api\/report/i;

// Language that means an option would CREATE a report rather than show an old one.
const FORBIDDEN_OPTION_LANGUAGE = /order|new|refresh|purchase|buy|update|generate|pull|request/i;

const DATE_PATTERN = /\b(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})\b/;

/**
 * An option is safe to select ONLY if we can positively identify it as an
 * existing historical report date.
 *
 * Fail closed: anything ambiguous is skipped. We do not find out what an
 * unrecognised option does by clicking it.
 */
export function isSafeHistoricalDateOption(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    if (FORBIDDEN_OPTION_LANGUAGE.test(text)) return false;
    return DATE_PATTERN.test(text);
}

function buildReplayUrl(sessionId) {
    return `https://www.browserbase.com/sessions/${sessionId}`;
}

/** Capture Array.io report payloads as they arrive. Attach BEFORE navigating. */
function captureArrayReports(page) {
    const captured = [];

    page.on("response", async (response) => {
        try {
            const url = response.url();
            if (!ARRAY_REPORT_URL_PATTERN.test(url)) return;

            const body = await response.text().catch(() => null);
            if (!body) return;

            const json = JSON.parse(body);

            captured.push({ url, status: response.status(), json, at: Date.now() });

            console.log(`Array.io report captured (${body.length} bytes) from ${url}`);
        } catch {
            // Never let capture break the run.
        }
    });

    return captured;
}

/** Find the report-date <select> and enumerate its safe historical options. */
async function findDateSelector(page) {
    for (const frame of page.frames()) {
        try {
            const selects = await frame.evaluate(() => {
                const isVisible = (el) => {
                    const r = el.getBoundingClientRect();
                    const s = window.getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
                };

                return Array.from(document.querySelectorAll("select"))
                    .filter(isVisible)
                    .map((sel) => ({
                        id: sel.id || null,
                        name: sel.getAttribute("name"),
                        selected_value: sel.value,
                        options: Array.from(sel.options).map((o) => ({
                            value: o.value,
                            text: (o.text || "").trim(),
                            selected: o.selected,
                        })),
                    }));
            });

            for (const select of selects) {
                const dateOptions = select.options.filter((o) => isSafeHistoricalDateOption(o.text));

                if (dateOptions.length >= 2) {
                    return { frame, select, dateOptions };
                }
            }
        } catch {
            // detached / cross-origin frame
        }
    }

    return null;
}

export async function runIdentifierSpike(data = {}) {

    let browser;
    let sessionId = null;

    try {

        const clientName = data.clientName || "Elizabeth Kelley";

        console.log(`Starting identifier comparison spike for "${clientName}"`);

        const session = await launchBrowser();

        browser = session.browser;
        sessionId = session.session.id;

        const page = session.page;
        const context = session.context;

        await loginToCRC(page);

        const clientResult = await openClient(page, clientName);

        if (!clientResult.clientFound) {
            return successResponse({
                milestone: "SPIKE_IDENTIFIERS",
                client_found: false,
                message: `No matching client found for "${clientName}".`,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        const creditHeroResult = await openCreditHero(page, context);

        // Listeners BEFORE navigation, or we miss the first report's payload.
        const captured = captureArrayReports(creditHeroResult.page);

        const reportResult = await openCreditReport(creditHeroResult.page);
        const reportPage = reportResult.page;

        // Report 1: whatever loaded by default. Zero interaction so far.
        await reportPage.waitForTimeout(4000);

        const firstCaptureCount = captured.length;

        if (firstCaptureCount === 0) {
            return successResponse({
                milestone: "SPIKE_IDENTIFIERS",
                client_found: true,
                error: "No Array.io report payload captured on the default report load.",
                report_url: reportResult.reportUrl,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        // Find the date selector and pick a DIFFERENT historical date.
        const selector = await findDateSelector(reportPage);

        if (!selector) {
            return successResponse({
                milestone: "SPIKE_IDENTIFIERS",
                client_found: true,
                error:
                    "Could not find a report-date selector with 2+ options that positively " +
                    "parse as existing historical dates. Not guessing. Cross-time comparison " +
                    "requires two reports.",
                reports_captured: captured.length,
                report_url: reportResult.reportUrl,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        const currentValue = selector.select.selected_value;
        const target = selector.dateOptions.find((o) => o.value !== currentValue);

        if (!target) {
            return successResponse({
                milestone: "SPIKE_IDENTIFIERS",
                client_found: true,
                error: "Only one historical report date is available. Cross-time comparison needs two.",
                available_dates: selector.dateOptions.map((o) => o.text),
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        // ---- THE ONE INTERACTION ------------------------------------------
        //
        // Guarded: target.text has already passed isSafeHistoricalDateOption(),
        // so it parses as a date and carries no order/refresh/purchase language.
        console.log(`Selecting historical report date: "${target.text}" (value=${target.value})`);
        console.log("This selects an EXISTING report. It does not order, refresh, or purchase.");

        const selectLocator = selector.select.id
            ? selector.frame.locator(`#${CSS.escape(selector.select.id)}`)
            : selector.frame.locator(`select[name="${selector.select.name}"]`);

        await selectLocator.selectOption(target.value);

        // Wait for the second payload to arrive.
        const deadline = Date.now() + 30000;
        while (captured.length === firstCaptureCount && Date.now() < deadline) {
            await reportPage.waitForTimeout(500);
        }

        if (captured.length === firstCaptureCount) {
            return successResponse({
                milestone: "SPIKE_IDENTIFIERS",
                client_found: true,
                error: "Selecting a second report date produced no new Array.io payload.",
                reports_captured: captured.length,
                browserbase_session_id: sessionId,
                replay_url: buildReplayUrl(sessionId),
            });
        }

        // ---- Analysis (pure) ----------------------------------------------

        const reports = captured.map((c, i) => ({
            report_date: i < firstCaptureCount ? "report_1_default" : `report_2_${target.text}`,
            records: extractTradelineRecords(c.json),
        }));

        const analysis = analyzeIdentifiers(reports);

        // Per-account identifier values, for manual inspection.
        const identifier_values_by_account = reports.map((report) => ({
            report_date: report.report_date,
            records: report.records.map((r) => ({
                bureau: r.bureau,
                creditor: r.validation.creditor,
                account_number: r.validation.account_number,
                opened_date: r.validation.opened_date,
                identifiers: r.identifiers,
            })),
        }));

        return successResponse({
            milestone: "SPIKE_IDENTIFIERS",
            client_found: true,
            crc_client_id: clientResult.crcClientId,

            reports_captured: captured.length,
            selected_historical_date: target.text,
            available_dates: selector.dateOptions.map((o) => o.text),

            identifier_values_by_account,
            analysis,

            // Invariant.
            ordered_report: false,
            refreshed_report: false,
            purchased_report: false,

            browserbase_session_id: sessionId,
            replay_url: buildReplayUrl(sessionId),
        });

    } catch (error) {

        console.error("Identifier spike failed:", error.message);

        return errorResponse("SPIKE_IDENTIFIERS_ERROR", error.message);

    } finally {

        if (browser) {
            await browser.close();
        }

    }

}
