/**
 * orderPageReader.js — READ-ONLY classification of the CreditHero order page
 * (mcc_order_select_v2.asp).
 *
 * WHY THIS MODULE IS ALLOWED TO TOUCH A FORBIDDEN PAGE.
 *
 * openCreditReport.js forbids mcc_order_select_v2.asp and refuses to navigate
 * there, because that page can order a report and charge the client. That rule
 * is not relaxed here. This module never navigates anywhere — it is handed a
 * page that has ALREADY landed on the order page (because CreditHero redirected
 * a client whose free report is not yet available), and it only reads.
 *
 * READ-ONLY BY CONSTRUCTION. The only Playwright verbs below are read verbs:
 * locator, textContent, innerText, getAttribute, isDisabled, count, and evaluate
 * used solely for property inspection. There is no click, check, selectOption,
 * fill, type, press, setInputFiles, form submit, or page.goto anywhere in this
 * file. The Submit button is never located as an actionable target — the reader
 * does not need it, so it holds no handle that could be clicked.
 *
 * FAIL CLOSED. If the free-report structure cannot be read, the answer is
 * ORDER_PAGE_UNREADABLE (manual review), never a guess in either direction.
 */

export const ORDER_STATE = Object.freeze({
    WAITING_FOR_FREE_REPORT: "WAITING_FOR_FREE_REPORT",
    FREE_REPORT_AVAILABLE: "FREE_REPORT_AVAILABLE",
    ORDER_PAGE_UNREADABLE: "ORDER_PAGE_UNREADABLE",
});

// The free option is identified by this visible label text. "&" not "&amp;":
// textContent decodes entities, so we match the decoded form.
const FREE_LABEL = "3 Bureau Report & Score FREE";

// Availability date, e.g. "Available 8/2/2026" -> "2026-08-02".
const AVAILABLE_DATE_RE = /Available\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i;

// A dollar amount in visible text, e.g. "$18.95" -> 18.95.
const PRICE_RE = /\$\s*(\d+(?:\.\d{2})?)/;

// "Last Report Date: 7/2/2026" -> "2026-07-02". The newest report the client
// currently has, read live from the order page.
const LAST_REPORT_RE = /Last\s+Report\s+Date\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i;

// TEMPORARY initial-rollout cutoff (inclusive). NOT the permanent rule — the
// permanent future-cycle rule is 31 days since confirmed delivery AND a free
// report, and is not built here.
const ROLLOUT_CUTOFF_ISO = "2026-07-01";

const READ_TIMEOUT = 8000;

/** MM/DD/YYYY (as captured on the page) -> ISO YYYY-MM-DD. Null if absent. */
function parseAvailableDate(text) {
    const m = (text || "").match(AVAILABLE_DATE_RE);
    if (!m) return null;
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** "Last Report Date: M/D/YYYY" -> ISO, or null. */
function parseLastReportDate(text) {
    const m = (text || "").match(LAST_REPORT_RE);
    if (!m) return null;
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * TEMPORARY rollout eligibility hint. Read-only and advisory — it changes no
 * status, triggers no processing. ISO date strings compare correctly with <,
 * >=, so no Date parsing is needed.
 */
function computeEligibilityHint(lastReportDateIso, freeReportEnabled) {
    if (!lastReportDateIso) return "ELIGIBILITY_UNKNOWN";

    if (lastReportDateIso >= ROLLOUT_CUTOFF_ISO) {
        return "ELIGIBLE_EXISTING_REPORT";
    }
    return freeReportEnabled ? "ELIGIBLE_FREE_REPORT" : "WAITING_FOR_FREE_REPORT";
}

/** First dollar amount in the given text as a number, or null. */
function parsePrice(text) {
    const m = (text || "").match(PRICE_RE);
    return m ? Number(m[1]) : null;
}

/**
 * Find the element that visibly contains the FREE label, searching every frame.
 * Returns the closest "order-item" ancestor when present, so disabled state and
 * the availability date (siblings of the radio) are read from one container.
 */
async function findFreeContainer(page) {
    for (const frame of page.frames()) {
        // getByText locates the label; we then walk up to the order-item wrapper.
        const label = frame.getByText(FREE_LABEL, { exact: false }).first();

        const count = await label.count().catch(() => 0);
        if (!count) continue;

        // Prefer the enclosing order-item container; fall back to the label node.
        const container = label
            .locator("xpath=ancestor-or-self::*[contains(@class,'order-item')][1]")
            .first();

        const hasContainer = (await container.count().catch(() => 0)) > 0;

        return { frame, node: hasContainer ? container : label };
    }

    return null;
}

/**
 * Classify the order page. Read-only.
 *
 * @param {import('playwright').Page} page  a page already on the order page
 * @returns {Promise<{classification: string, freeReportEnabled: boolean,
 *   nextFreeReportAvailableAt: string|null, paidReportPresent: boolean,
 *   paidReportPrice: number|null, evidence: string[]}>}
 */
export async function readOrderPage(page) {
    const result = {
        classification: ORDER_STATE.ORDER_PAGE_UNREADABLE,
        freeReportEnabled: false,
        nextFreeReportAvailableAt: null,
        paidReportPresent: false,
        paidReportPrice: null,
        // TEMPORARY rollout hint. Advisory only — no status/processing here.
        lastReportDate: null,
        eligibilityHint: "ELIGIBILITY_UNKNOWN",
        temporaryOverrideApplied: false,
        evidence: [],
    };

    const free = await findFreeContainer(page).catch(() => null);

    if (!free) {
        // The free option is the anchor. Without it we do not trust anything else
        // on the page — fail closed to unreadable.
        result.evidence.push("free_label_not_found");
        return result;
    }

    result.evidence.push("free_label_found");

    // ---- Free-option enabled/disabled -------------------------------------
    //
    // Disabled if ANY signal says so: the radio's disabled property, Playwright's
    // isDisabled(), or a "disabled" class on the container. Enabled must be
    // POSITIVELY proven — a radio that is present and not disabled by any signal.
    const containerText =
        (await free.node.textContent({ timeout: READ_TIMEOUT }).catch(() => "")) || "";

    result.nextFreeReportAvailableAt = parseAvailableDate(containerText);

    const radio = free.node.locator('input[type="radio"]').first();
    const radioCount = await radio.count().catch(() => 0);

    let disabledBySignal = false;
    let radioPresentAndReadable = false;

    if (radioCount > 0) {
        radioPresentAndReadable = true;

        // 1. disabled ATTRIBUTE/property (authoritative).
        const disabledAttr = await radio.getAttribute("disabled").catch(() => null);
        // 2. Playwright's own disabled determination.
        const isDisabled = await radio.isDisabled().catch(() => true);

        if (disabledAttr !== null || isDisabled === true) disabledBySignal = true;
    }

    // 3. "disabled" class on the container.
    const containerClass = (await free.node.getAttribute("class").catch(() => "")) || "";
    if (/\bdisabled\b/.test(containerClass)) disabledBySignal = true;

    // Positively enabled ONLY when the radio is present, readable, and no signal
    // marks it disabled.
    result.freeReportEnabled = radioPresentAndReadable && !disabledBySignal;

    result.evidence.push(
        `radio_present:${radioPresentAndReadable}`,
        `disabled_signal:${disabledBySignal}`
    );

    // ---- Paid option ------------------------------------------------------
    //
    // Anchored on visible currency text anywhere in the frame that owns the free
    // container. We do not assume the paid row's position relative to the free
    // one — only that a price is visibly present.
    let frameText = "";
    try {
        frameText = await free.frame.locator("body").innerText({ timeout: READ_TIMEOUT });
    } catch {
        frameText = "";
    }

    // Live newest report date, read from the order page. Reused source of truth
    // for the temporary rollout hint — NOT client_state.last_report_date_used.
    result.lastReportDate = parseLastReportDate(frameText);

    const price = parsePrice(frameText);

    if (price !== null) {
        result.paidReportPresent = true;
        result.paidReportPrice = price;
        result.evidence.push(`paid_price:${price}`);
    } else {
        result.evidence.push("paid_price_not_found");
    }

    // ---- Classification ---------------------------------------------------
    if (result.freeReportEnabled) {
        result.classification = ORDER_STATE.FREE_REPORT_AVAILABLE;
    } else if (radioPresentAndReadable) {
        // Free option is present but disabled — the client is waiting for the
        // next free refresh. This is the Dietrich case.
        result.classification = ORDER_STATE.WAITING_FOR_FREE_REPORT;
    } else {
        result.classification = ORDER_STATE.ORDER_PAGE_UNREADABLE;
    }

    // Temporary rollout hint. Fails closed to ELIGIBILITY_UNKNOWN when the live
    // report date is unreadable — never assumes eligibility.
    result.eligibilityHint = computeEligibilityHint(result.lastReportDate, result.freeReportEnabled);
    result.temporaryOverrideApplied =
        result.eligibilityHint === "ELIGIBLE_EXISTING_REPORT" && !result.freeReportEnabled;

    return result;
}
