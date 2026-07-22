/**
 * freeReportAcquisition.js — order the FREE three-bureau membership refresh.
 *
 * THIS IS THE ONLY MODULE IN THE SYSTEM PERMITTED TO SELECT AN ORDER OPTION OR
 * PRESS SUBMIT. It exists as one isolated file so the entire money-adjacent
 * action surface is auditable in one place.
 *
 * GOVERNING RULE (amended standing rule):
 *   The processor may order a new CreditHeroScore report ONLY when it has
 *   positively verified that the client's active membership includes an ENABLED
 *   three-bureau refresh with a total cost of exactly $0.00. It must never
 *   select, order, or submit a paid report, enter payment information,
 *   reactivate monitoring, purchase an add-on, or proceed when the cost cannot
 *   be positively verified.
 *
 * WHAT IT WILL NOT DO. It contains no payment-field entry, no reactivation, no
 * add-on selection, and no invite. It never selects a row that carries a dollar
 * amount. It requires EXACTLY ONE row to satisfy every free-row signal — zero
 * matches or two matches both fail closed, because ambiguity on this page is
 * indistinguishable from danger.
 *
 * TWO GATES.
 *   freeReportAcquisitionApproved  — permits this workflow to run at all.
 *   submitOrderApproved            — false: DRY-SELECT REHEARSAL. Selects the
 *                                    free row, verifies every precondition,
 *                                    captures evidence, and STOPS before Submit.
 *                                    true:  permits Submit, and only after every
 *                                    precondition has positively verified.
 * Neither authorizes M8 dispute delivery; that remains submitApproved.
 */

import { isFreeRowText } from "./orderPageReader.js";

export const ACQUISITION_VERSION = "BT-FREE-ACQ-1.0";

export const ACQUISITION_STATE = Object.freeze({
    FREE_REPORT_ACQUIRED: "FREE_REPORT_ACQUIRED",
    FREE_REPORT_PENDING: "FREE_REPORT_PENDING",
    FREE_REPORT_ACQUISITION_BLOCKED: "FREE_REPORT_ACQUISITION_BLOCKED",
    FREE_REPORT_REHEARSAL_OK: "FREE_REPORT_REHEARSAL_OK",
});

// Confirmed live DOM: BOTH controls point at the SAME destination —
//   <a id="reportActionBtn" href="mcc_order_select_v2.asp">REFRESH REPORT</a>
//   <a                      href="mcc_order_select_v2.asp">ORDER NEW REPORT</a>
//
// Because the destination is identical, there is nothing to gain from locating
// and clicking the visible text, and text matching has already proven brittle on
// these pages. We reuse the navigation pattern openCreditReport.js already uses
// successfully: resolve the confirmed relative path against the current page URL
// and navigate the real page. Clicking would also execute whatever handler the
// anchor carries; a verified goto() does not.
const ORDER_PAGE_FILE = "mcc_order_select_v2.asp";

// The CreditHero report page we must already be on before navigating.
const REPORT_PAGE_FILE = "mcc_creditreports_v2.asp";

// Positive proof we are on the client's report page: this element holds the
// LAST REPORT DATE value.
const LAST_REPORT_DATE_ID = "#lastReportDate";
const ORDER_HEADING_RE = /order\s+a\s+new\s+credit\s+report\s+and\s+score/i;
const PRICE_RE = /\$\s*\d/;
const ZERO_TOTAL_RE = /\$\s*0(\.00)?\b/;
const TOTAL_HINT_RE = /total/i;

const NAV_TIMEOUT = 20000;
const READ_TIMEOUT = 10000;

/** Payment inputs must not be present on a $0.00 order. */
const PAYMENT_SELECTORS = [
    'input[name*="card" i]',
    'input[name*="cvv" i]',
    'input[name*="exp" i]',
    'input[autocomplete*="cc-" i]',
];

function normalizeName(value) {
    return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Resolve the real Playwright Page from whatever the caller hands us.
 *
 * openCreditReport() returns a PLAIN OBJECT — { reportOpened, reportUrl,
 * pageTitle, page } — not a Page. Calling page methods on that wrapper throws
 * "getByRole is not a function", which is exactly how this failed. Accept either
 * shape and fail closed if neither is usable.
 */
function resolvePage(candidate) {
    if (!candidate || typeof candidate !== "object") return null;

    if (typeof candidate.locator === "function" && typeof candidate.frames === "function") {
        return candidate;
    }

    const inner = candidate.page;

    if (inner && typeof inner.locator === "function" && typeof inner.frames === "function") {
        return inner;
    }

    return null;
}

/**
 * Resolve the order-page URL from the CURRENT page URL, with same-origin and
 * pathname proof. Returns null if anything cannot be positively verified.
 */
function resolveOrderUrl(currentUrl) {
    try {
        const current = new URL(currentUrl);
        const target = new URL(ORDER_PAGE_FILE, currentUrl);

        // Must not leave the active CreditHero origin.
        if (target.origin !== current.origin) return null;

        // Must resolve to exactly the order page, not something merely containing
        // that name.
        if (!target.pathname.toLowerCase().endsWith(`/${ORDER_PAGE_FILE.toLowerCase()}`)) {
            return null;
        }

        return target.href;
    } catch {
        return null;
    }
}

/**
 * Prove we are on the client's CreditHero report page before navigating anywhere.
 * Returns { ok, lastReportDate, reason }.
 */
async function verifyOnReportPage(page) {
    const url = page.url() || "";

    if (!url.toLowerCase().includes(REPORT_PAGE_FILE.toLowerCase())) {
        return { ok: false, reason: "current_url_is_not_the_report_page" };
    }

    // LAST REPORT DATE is rendered on the report page and nowhere else in this
    // flow, so its presence is positive identification.
    for (const frame of page.frames()) {
        const el = frame.locator(LAST_REPORT_DATE_ID).first();

        if ((await el.count().catch(() => 0)) > 0) {
            const text = ((await el.textContent().catch(() => "")) || "").trim();
            if (text) return { ok: true, lastReportDate: text };
        }
    }

    return { ok: false, reason: "last_report_date_not_present" };
}

/**
 * Acquire the free three-bureau refresh.
 *
 * @param {object} reportPage  page already on the CreditHero report dashboard
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string} opts.priorReportDate           ISO; the new report must beat this
 * @param {boolean} opts.freeReportAcquisitionApproved
 * @param {boolean} opts.submitOrderApproved
 */
export async function acquireFreeReport(reportPage, opts = {}) {
    const {
        clientName,
        priorReportDate = null,
        freeReportAcquisitionApproved,
        submitOrderApproved,
    } = opts;

    const report = {
        tool: ACQUISITION_VERSION,
        classification: ACQUISITION_STATE.FREE_REPORT_ACQUISITION_BLOCKED,
        clientName: clientName ?? null,
        priorReportDate,
        // Preconditions, each proven true or the run stops.
        orderPageReached: false,
        headingVerified: false,
        freeRowFound: false,
        freeRowEnabled: false,
        freeRowHasNoPrice: false,
        exactlyOneFreeRow: false,
        paymentFieldsAbsent: false,
        zeroCostVerified: false,
        freeRowSelected: false,
        noOtherRadioSelected: false,
        // Actions.
        submitClicked: false,
        rehearsalOnly: false,
        // Attestations.
        paidOptionSelected: false,
        paymentEntered: false,
        monitoringReactivated: false,
        addOnSelected: false,
        rowsObserved: [],
        error_code: null,
        failureReason: null,
    };

    if (freeReportAcquisitionApproved !== true) {
        report.error_code = "ACQUISITION_NOT_APPROVED";
        report.failureReason =
            "freeReportAcquisitionApproved was not true. Nothing was opened, selected, or submitted.";
        return report;
    }

    // ---- 1. Navigate via the confirmed ORDER NEW REPORT link ---------------
    //
    // CreditHero does not redirect here when a usable report exists, so the link
    // must be used deliberately. This is navigation, not ordering.
    const page = resolvePage(reportPage);

    if (!page) {
        report.error_code = "REPORT_PAGE_UNUSABLE";
        report.failureReason =
            "The object passed in exposes no Playwright page interface. Nothing was clicked.";
        return report;
    }

    // Prove we are on the client's report page BEFORE navigating anywhere.
    const onReport = await verifyOnReportPage(page).catch(() => ({ ok: false, reason: "probe_failed" }));

    if (!onReport.ok) {
        report.error_code = "ORDER_PAGE_NAVIGATION_NOT_PROVEN";
        report.failureReason =
            `Not positively on the CreditHero report page (${onReport.reason}). Nothing was navigated.`;
        return report;
    }

    report.observedLastReportDate = onReport.lastReportDate ?? null;

    const orderUrl = resolveOrderUrl(page.url());

    if (!orderUrl) {
        report.error_code = "ORDER_PAGE_NAVIGATION_NOT_PROVEN";
        report.failureReason =
            "The order-page URL did not resolve to the same origin and the expected pathname. " +
            "Nothing was navigated.";
        return report;
    }

    report.resolvedOrderUrl = orderUrl;

    await page.goto(orderUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});

    // ---- 2. Positively identify the order page -----------------------------
    const frame = await findOrderFrame(page).catch(() => null);

    if (!frame) {
        report.error_code = "ORDER_PAGE_NOT_IDENTIFIED";
        report.failureReason = "No order form was found after clicking. Nothing was selected.";
        return report;
    }

    report.orderPageReached = true;

    const bodyText =
        (await frame.locator("body").innerText({ timeout: READ_TIMEOUT }).catch(() => "")) || "";

    report.headingVerified = ORDER_HEADING_RE.test(bodyText);

    if (!report.headingVerified) {
        report.error_code = "ORDER_HEADING_NOT_VERIFIED";
        report.failureReason =
            'The page did not present "Order a New Credit Report and Score". Failing closed.';
        return report;
    }

    // ---- 3. Survey every row; require EXACTLY ONE free row ----------------
    const rows = await surveyRows(frame).catch(() => []);

    report.rowsObserved = rows.map((r) => ({
        id: r.id, name: r.name, checked: r.checked, disabled: r.disabled,
        isFree: r.isFree, hasPrice: r.hasPrice, text: r.text,
    }));

    const freeRows = rows.filter((r) => r.isFree && !r.hasPrice);

    report.freeRowFound = freeRows.length > 0;
    report.exactlyOneFreeRow = freeRows.length === 1;

    if (!report.exactlyOneFreeRow) {
        report.error_code = freeRows.length === 0 ? "FREE_ROW_NOT_FOUND" : "FREE_ROW_AMBIGUOUS";
        report.failureReason =
            `Expected exactly one free three-bureau row, found ${freeRows.length}. ` +
            `Ambiguity here is indistinguishable from danger, so nothing was selected.`;
        return report;
    }

    const free = freeRows[0];

    report.freeRowEnabled = !free.disabled;
    report.freeRowHasNoPrice = !free.hasPrice;

    if (!report.freeRowEnabled) {
        report.classification = ACQUISITION_STATE.FREE_REPORT_ACQUISITION_BLOCKED;
        report.error_code = "FREE_ROW_DISABLED";
        report.failureReason =
            "The free three-bureau option is present but disabled. No paid option was selected.";
        return report;
    }

    // ---- 4. No payment surface may be present -----------------------------
    let paymentCount = 0;

    for (const sel of PAYMENT_SELECTORS) {
        paymentCount += await frame.locator(sel).count().catch(() => 0);
    }

    report.paymentFieldsAbsent = paymentCount === 0;

    if (!report.paymentFieldsAbsent) {
        report.error_code = "PAYMENT_FIELDS_PRESENT";
        report.failureReason =
            "Payment fields are present on this order page. A $0.00 order requires none. Failing closed.";
        return report;
    }

    // ---- 5. Select ONLY the free row --------------------------------------
    await free.radio.check({ timeout: READ_TIMEOUT }).catch(() => {});

    const after = await surveyRows(frame).catch(() => []);
    const selected = after.filter((r) => r.checked);

    report.freeRowSelected =
        selected.length === 1 && selected[0].isFree && !selected[0].hasPrice;
    report.noOtherRadioSelected = selected.length === 1;
    report.paidOptionSelected = selected.some((r) => r.hasPrice);

    if (!report.freeRowSelected || report.paidOptionSelected) {
        report.error_code = "SELECTION_VERIFICATION_FAILED";
        report.failureReason =
            `After selecting, ${selected.length} option(s) were checked and paidSelected=` +
            `${report.paidOptionSelected}. Not submitting.`;
        return report;
    }

    // ---- 6. Affirmative zero-cost verification ----------------------------
    //
    // If the page provides a total, it must read exactly $0.00. If it provides
    // none, the approved fallback applies: an enabled selected FREE row with no
    // dollar amount, no payment fields, and no paid option selected.
    const totalLoc = frame.locator('[class*="total" i], [id*="total" i]').first();
    const hasTotal = (await totalLoc.count().catch(() => 0)) > 0;

    if (hasTotal) {
        const totalText =
            (await totalLoc.textContent({ timeout: READ_TIMEOUT }).catch(() => "")) || "";

        const looksLikeTotal = TOTAL_HINT_RE.test(totalText) || PRICE_RE.test(totalText);

        if (looksLikeTotal && PRICE_RE.test(totalText) && !ZERO_TOTAL_RE.test(totalText)) {
            report.error_code = "NONZERO_TOTAL";
            report.failureReason =
                "An order total was present and was not $0.00. Not submitting.";
            return report;
        }

        report.zeroCostVerified = true;
    } else {
        // Approved fallback — do not require a total element the page lacks.
        report.zeroCostVerified =
            report.freeRowSelected &&
            report.freeRowHasNoPrice &&
            report.paymentFieldsAbsent &&
            !report.paidOptionSelected;
    }

    if (!report.zeroCostVerified) {
        report.error_code = "ZERO_COST_NOT_VERIFIED";
        report.failureReason = "Cost could not be positively verified as $0.00. Not submitting.";
        return report;
    }

    // ---- 7. SUBMIT BOUNDARY -----------------------------------------------
    if (submitOrderApproved !== true) {
        report.rehearsalOnly = true;
        report.classification = ACQUISITION_STATE.FREE_REPORT_REHEARSAL_OK;
        report.failureReason =
            "DRY-SELECT REHEARSAL — every precondition verified and the free option is selected, " +
            "but submitOrderApproved was not true, so Submit was not clicked and no order was placed.";
        return report;
    }

    const submit = frame
        .getByRole("button", { name: /^submit$/i })
        .or(frame.locator('input[type="submit"], button[type="submit"], #SubmitButton'))
        .first();

    if (!(await submit.count().catch(() => 0))) {
        report.error_code = "SUBMIT_NOT_FOUND";
        report.failureReason = "Submit control was not found. No order was placed.";
        return report;
    }

    await submit.click({ timeout: NAV_TIMEOUT }).catch(() => {});
    report.submitClicked = true;

    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // ---- 8. Observe the result; never assume the report exists ------------
    const afterText =
        (await page.locator("body").innerText({ timeout: READ_TIMEOUT }).catch(() => "")) || "";

    report.postSubmitText = afterText.replace(/\s+/g, " ").trim().slice(0, 300);
    report.classification = ACQUISITION_STATE.FREE_REPORT_PENDING;
    report.failureReason = null;

    return report;
}
