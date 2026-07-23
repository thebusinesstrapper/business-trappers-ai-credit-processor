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

// The free option's wording VARIES BY ACCOUNT. Two confirmed live forms:
//   "3 Bureau Report & Score FREE"
//   "3 Bureau Experian, Equifax and Transunion Report & Score FREE"
// A fixed string anchored on the first would silently fail to find the second,
// so identification is multi-signal: the row must mention a 3-bureau product AND
// FREE, and must NOT carry a dollar amount.
const FREE_BUREAU_RE = /3\s*[-\s]?bureau/i;
const FREE_WORD_RE = /\bFREE\b/i;

/** A row is the FREE row only if it says 3-Bureau, says FREE, and shows no price. */
export function isFreeRowText(text) {
    const t = (text ?? "").replace(/\s+/g, " ");
    return FREE_BUREAU_RE.test(t) && FREE_WORD_RE.test(t) && !PRICE_RE.test(t);
}

/**
 * THE TWO PURCHASE OPTION IDS, OBSERVED LIVE (Discovery Spike, 2026-07-12).
 *
 * These were ALREADY IMPORTED by acquisitionDecision.js and were never exported
 * here, which made that module impossible to load at all:
 *
 *   SyntaxError: The requested module './orderPageReader.js' does not provide
 *                an export named 'FREE_OPTION_ID'
 *
 * The module was dormant (nothing imported it), so the fault was invisible until
 * the acquisition path was wired up. Defining them here — beside the reader that
 * observes them — keeps ONE source of truth for the option identity.
 *
 * NOTE WHAT THESE ARE NOT. They are not sufficient on their own to identify the
 * free option. readOrderPageOptions() below requires the id AND the row's own
 * FREE/3-bureau text AND the absence of a price before it will report cost 0.
 * An id that drifts therefore causes a REFUSAL (via unaccounted_option_ids ->
 * manual review), never a wrong click.
 */
export const FREE_OPTION_ID = "productBuyNew_01";
export const PAID_OPTION_ID = "productBuyNew_03";

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
export const ROLLOUT_CUTOFF_ISO = "2026-07-01";

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
export function computeEligibilityHint(lastReportDateIso, freeReportEnabled) {
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
        const radios = frame.locator('input[type="radio"]');
        const count = await radios.count().catch(() => 0);

        for (let i = 0; i < count; i += 1) {
            const radio = radios.nth(i);

            const row = radio
                .locator("xpath=ancestor-or-self::*[contains(@class,'order-item')][1]")
                .first();

            const hasRow = (await row.count().catch(() => 0)) > 0;
            const node = hasRow ? row : radio;

            const text = await node.textContent({ timeout: READ_TIMEOUT }).catch(() => "");

            if (isFreeRowText(text)) {
                return { frame, node };
            }
        }
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

/**
 * ---------------------------------------------------------------------------
 * OrderPageState ADAPTER — for the Report Acquisition Decision Engine.
 *
 * WHY THIS IS SEPARATE FROM readOrderPage().
 *
 * readOrderPage() answers a CLASSIFICATION question ("is this client waiting, or
 * is a free report available?") and its output shape is consumed by milestone6's
 * existing WAITING_FOR_FREE_REPORT / FREE_REPORT_AVAILABLE branches. It is
 * untouched, because changing it would change those proven branches.
 *
 * decideAcquisition() asks a completely different question — "may we spend this
 * client's entitlement?" — and requires a per-option structure that
 * readOrderPage() does not produce and never did: it locates the free row by
 * TEXT and never reads an option id at all.
 *
 * So this is a second reader over the same page, emitting the shape the decision
 * engine's preconditions are written against. Two readers, same page, different
 * questions.
 *
 * READ-ONLY, exactly like readOrderPage(): locator, count, getAttribute,
 * textContent, innerText, isDisabled, isVisible. No click, check, selectOption,
 * fill, press, or goto appears anywhere in this function.
 *
 * COST IS AFFIRMATIVE OR NULL. A row is priced 0 ONLY when it positively reads
 * as the free 3-bureau row AND carries no dollar amount. A row with a dollar
 * amount is priced at that amount. Anything else is null — "we could not tell" —
 * which decideAcquisition() treats as unpriced and routes to manual review.
 * Absence of evidence of cost is never evidence of no cost.
 * ---------------------------------------------------------------------------
 *
 * @param {import('playwright').Page} page  a page already on the order page
 * @returns {Promise<{page_read: boolean, options: object[],
 *   unaccounted_option_ids: string[], evidence: string[]}>}
 */

/** Escape an id for an attribute selector. Node-safe (CSS.escape is browser-only). */
function attrEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * ---------------------------------------------------------------------------
 * IS THIS OPTION ACTUALLY PRESENTED TO THE USER?
 *
 * THE DEFECT THIS SOLVES. Visibility was measured on the native
 * <input type="radio">. CreditHero renders a STYLED control: the native input is
 * hidden by CSS (display:none / zero-size / visibility:hidden) and a label or
 * container is what is actually drawn, clicked, and seen.
 *
 * Playwright's isVisible() is therefore FALSE for an input that is present,
 * enabled, and perfectly usable — because the thing the user sees is not the
 * thing we were measuring. Marcos Lopez's live order page showed the free
 * 3-bureau option plainly visible and unselected, and the reader reported
 * `not visible`, which decideAcquisition() correctly refused to act on.
 *
 * The question "is this option presented?" is answered by the PRESENTED
 * element, so all three candidates are consulted:
 *
 *   1. the native input itself      — true when CreditHero does not restyle it
 *   2. label[for="<option id>"]     — the canonical HTML association
 *   3. the .order-item container    — the row that owns the control
 *
 * ANY ONE being visible proves the option is on screen. This does NOT relax the
 * separate `disabled` determination, and it does NOT touch cost verification —
 * an option can be visible and still be rejected as disabled, unpriced, or not
 * positively identified as the free row.
 *
 * FAIL CLOSED IS PRESERVED. If the input is hidden AND no label is bound to it
 * AND the container is hidden (or absent), nothing proves the option is
 * presented and visible stays false. A row CreditHero has hidden outright is
 * still unusable, exactly as before.
 * ---------------------------------------------------------------------------
 *
 * @returns {Promise<{visible: boolean, evidence: string|null}>}
 */
async function determineOptionVisibility(frame, radio, container, hasContainer, optionId) {
    // 1. The native control, when it is genuinely rendered.
    if (await radio.isVisible().catch(() => false)) {
        return { visible: true, evidence: "radio_input_visible" };
    }

    // 2. The label explicitly bound to this input by id. This is the canonical
    //    association and the element a user actually clicks on a styled control.
    if (optionId) {
        const label = frame.locator(`label[for="${attrEscape(optionId)}"]`).first();

        if ((await label.count().catch(() => 0)) > 0) {
            if (await label.isVisible().catch(() => false)) {
                return { visible: true, evidence: "bound_label_visible" };
            }
        }
    }

    // 3. The order-item row that owns the control.
    if (hasContainer && (await container.isVisible().catch(() => false))) {
        return { visible: true, evidence: "order_item_container_visible" };
    }

    // Nothing proved it is presented. Fail closed.
    return { visible: false, evidence: null };
}

export async function readOrderPageOptions(page) {
    const state = {
        page_read: false,
        options: [],
        unaccounted_option_ids: [],
        evidence: [],
    };

    const known = new Set([FREE_OPTION_ID, PAID_OPTION_ID]);

    for (const frame of page.frames()) {
        const radios = frame.locator('input[type="radio"]');
        const count = await radios.count().catch(() => 0);

        if (count === 0) continue;

        for (let i = 0; i < count; i += 1) {
            const radio = radios.nth(i);

            // Identity: prefer the id attribute, fall back to value. Either may
            // be null on a control we do not recognise — which is itself the
            // finding, not an error.
            const id =
                (await radio.getAttribute("id").catch(() => null)) ??
                (await radio.getAttribute("value").catch(() => null));

            // The row that owns this radio, for text/price/availability.
            const row = radio
                .locator("xpath=ancestor-or-self::*[contains(@class,'order-item')][1]")
                .first();

            const hasRow = (await row.count().catch(() => 0)) > 0;
            const node = hasRow ? row : radio;
            const rowText =
                (await node.textContent({ timeout: READ_TIMEOUT }).catch(() => "")) || "";

            // ---- Disabled: ANY signal counts. Enabled must be positive. ----
            const disabledAttr = await radio.getAttribute("disabled").catch(() => null);
            const isDisabled = await radio.isDisabled().catch(() => true);
            const containerClass = (await node.getAttribute("class").catch(() => "")) || "";
            const disabled =
                disabledAttr !== null || isDisabled === true || /\bdisabled\b/.test(containerClass);

            // Measured on the PRESENTED control, not the CSS-replaced native
            // input. See determineOptionVisibility() above.
            const presentation = await determineOptionVisibility(
                frame, radio, node, hasRow, id
            );
            const visible = presentation.visible;

            // ---- Cost: affirmative, or null. -------------------------------
            const price = parsePrice(rowText);
            let cost = null;
            let costEvidence = null;

            if (price !== null) {
                cost = price;
                costEvidence = `dollar amount ${price} read from the option row`;
            } else if (isFreeRowText(rowText)) {
                cost = 0;
                costEvidence =
                    "row positively reads as the 3-bureau FREE option and carries no dollar amount";
            } else {
                costEvidence = "no dollar amount and no positive FREE identification";
            }

            state.options.push({
                id: id ?? null,
                cost,
                cost_evidence: costEvidence,
                disabled,
                visible,
                // WHICH signal proved the option is on screen. Diagnostic only —
                // decideAcquisition() reads `visible`, not this. It records
                // whether the native input is genuinely rendered or is a hidden,
                // CSS-replaced control, which is the difference between a radio
                // that can be checked directly and one that cannot.
                visibility_evidence: presentation.evidence,
                available_from: parseAvailableDate(rowText),
            });

            if (!id || !known.has(id)) {
                state.unaccounted_option_ids.push(id ?? "(no id attribute)");
            }
        }

        // Radios found in this frame: this is the order form. Stop here rather
        // than merging controls across frames into one option set.
        if (state.options.length > 0) {
            state.page_read = true;
            state.evidence.push(`options_read:${state.options.length}`);
            break;
        }
    }

    if (!state.page_read) state.evidence.push("no_radio_options_found");
    if (state.unaccounted_option_ids.length > 0) {
        state.evidence.push(`unaccounted:${state.unaccounted_option_ids.length}`);
    }

    return state;
}
