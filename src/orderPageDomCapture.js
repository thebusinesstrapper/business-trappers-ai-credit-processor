/**
 * orderPageDomCapture.js — READ-ONLY DOM evidence capture for the CreditHero
 * order page (mcc_order_select_v2.asp).
 *
 * PURPOSE. Free-report acquisition cannot be built without the real markup for
 * the radio options, the order total, and the Submit control. Rather than
 * transcribe selectors by hand, this module reads them off the live page and
 * returns sanitized evidence.
 *
 * IT ONLY READS. The Playwright verbs used are locator, count, getAttribute,
 * textContent, innerText, evaluate (property inspection only), title, and url.
 * There is no click, check, selectOption, fill, type, press, setInputFiles, form
 * submit, or navigation-to-order anywhere in this file. It cannot select a radio
 * and it cannot press Submit — it locates the Submit button only to DESCRIBE it,
 * never as an actionable target.
 *
 * IT WRITES NOTHING. No Supabase import, no status import, no milestone import,
 * no message import. Those are unreachable, not merely un-called.
 *
 * FAILS CLOSED. If the page cannot be positively identified as the order page,
 * it returns ORDER_PAGE_NOT_IDENTIFIED and captures nothing.
 *
 * REDACTION. Values that can carry tokens or identifiers (hidden inputs, hrefs,
 * epGUID/tGUID/payment_token, long digit runs) are redacted before return.
 */

export const CAPTURE_VERSION = "BT-ORDER-DOM-CAPTURE-1.0";

const ORDER_PAGE_MARKER = "mcc_order_select_v2.asp";
const READ_TIMEOUT = 10000;
const MAX_HTML = 4000;

/** Strip tokens, long identifiers, and query strings from any captured text. */
function sanitize(value) {
    if (typeof value !== "string") return null;

    return value
        .replace(/(epGUID|tGUID|payment_token|token|sessionid|PHPSESSID)=[^&"'\s]*/gi, "$1=[redacted]")
        .replace(/https?:\/\/[^\s"']+/gi, "[url]")
        .replace(/\d{9,}/g, "[redacted]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_HTML);
}

/** Sanitize an element's outerHTML, dropping value attributes that may hold tokens. */
async function safeOuterHtml(locator) {
    const html = await locator
        .evaluate((el) => el.outerHTML)
        .catch(() => null);

    if (!html) return null;

    // Hidden inputs can carry order/session tokens — redact their values entirely.
    const scrubbed = html.replace(
        /(<input[^>]*type=["']hidden["'][^>]*value=["'])([^"']*)(["'])/gi,
        "$1[redacted]$3"
    );

    return sanitize(scrubbed);
}

/** Locate the frame that actually contains the order form. */
async function findOrderFrame(page) {
    for (const frame of page.frames()) {
        const url = frame.url() || "";
        if (url.includes(ORDER_PAGE_MARKER)) return frame;

        const hasRadios = await frame
            .locator('input[type="radio"][name="productBuyNew"]')
            .count()
            .catch(() => 0);

        if (hasRadios > 0) return frame;
    }
    return null;
}

/**
 * Describe every product radio: id, name, value, checked, disabled, label text,
 * and the sanitized outerHTML of its containing row.
 */
async function captureRadios(frame) {
    const radios = frame.locator('input[type="radio"]');
    const count = await radios.count().catch(() => 0);
    const out = [];

    for (let i = 0; i < count; i += 1) {
        const radio = radios.nth(i);

        const props = await radio
            .evaluate((el) => ({
                id: el.id || null,
                name: el.name || null,
                value: el.value || null,
                checked: el.checked === true,
                disabled: el.disabled === true,
                ariaDisabled: el.getAttribute("aria-disabled"),
            }))
            .catch(() => null);

        if (!props) continue;

        // The enclosing row carries the disabled class and the availability text.
        const row = radio
            .locator("xpath=ancestor-or-self::*[contains(@class,'order-item')][1]")
            .first();

        const hasRow = (await row.count().catch(() => 0)) > 0;
        const target = hasRow ? row : radio;

        out.push({
            index: i,
            id: sanitize(props.id),
            name: sanitize(props.name),
            value: sanitize(props.value),
            checked: props.checked,
            disabled: props.disabled,
            ariaDisabled: sanitize(props.ariaDisabled),
            containerClass: sanitize(await target.getAttribute("class").catch(() => null)),
            labelText: sanitize(await target.textContent({ timeout: READ_TIMEOUT }).catch(() => null)),
            rowOuterHtml: await safeOuterHtml(target),
        });
    }

    return out;
}

/** Capture any region that looks like an order total / price summary. */
async function captureTotals(frame) {
    const candidates = [
        'text=/total/i',
        '[class*="total" i]',
        '[class*="summary" i]',
        '[id*="total" i]',
    ];

    const found = [];

    for (const sel of candidates) {
        const loc = frame.locator(sel).first();

        if ((await loc.count().catch(() => 0)) > 0) {
            found.push({
                selector: sel,
                text: sanitize(await loc.textContent({ timeout: READ_TIMEOUT }).catch(() => null)),
                outerHtml: await safeOuterHtml(loc),
            });
        }
    }

    return found;
}

/**
 * DESCRIBE the Submit control. Located for description only — this module has no
 * click, so possessing a handle here cannot submit an order.
 */
async function captureSubmit(frame) {
    const candidates = [
        'input[type="submit"]',
        'button[type="submit"]',
        '#SubmitButton',
        'button:has-text("Submit")',
    ];

    const found = [];

    for (const sel of candidates) {
        const loc = frame.locator(sel).first();

        if ((await loc.count().catch(() => 0)) > 0) {
            const props = await loc
                .evaluate((el) => ({
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    name: el.getAttribute("name"),
                    type: el.getAttribute("type"),
                    disabled: el.disabled === true,
                    text: (el.textContent || el.value || "").trim(),
                }))
                .catch(() => null);

            if (props) {
                found.push({
                    selector: sel,
                    tag: props.tag,
                    id: sanitize(props.id),
                    name: sanitize(props.name),
                    type: sanitize(props.type),
                    disabled: props.disabled,
                    text: sanitize(props.text),
                    outerHtml: await safeOuterHtml(loc),
                });
            }
        }
    }

    return found;
}

/** Detect any payment-related fields or sections, without reading their values. */
async function capturePaymentSurface(frame) {
    const selectors = [
        'input[name*="card" i]',
        'input[name*="cvv" i]',
        'input[name*="exp" i]',
        'input[autocomplete*="cc-" i]',
        'form[action*="payment_update.asp" i]',
        '[class*="payment" i]',
    ];

    const present = [];

    for (const sel of selectors) {
        const n = await frame.locator(sel).count().catch(() => 0);
        if (n > 0) present.push({ selector: sel, count: n });
    }

    return present;
}

/** The member/client identity visible on the CreditHero page (name text only). */
async function captureIdentity(frame) {
    const candidates = ['[class*="member" i]', '[class*="client" i]', "h1", "h2"];
    const seen = [];

    for (const sel of candidates) {
        const loc = frame.locator(sel).first();
        if ((await loc.count().catch(() => 0)) > 0) {
            const text = sanitize(await loc.textContent({ timeout: READ_TIMEOUT }).catch(() => null));
            if (text) seen.push({ selector: sel, text: text.slice(0, 120) });
        }
    }

    return seen;
}

/**
 * Capture sanitized DOM evidence from an ALREADY-LANDED order page.
 *
 * @param {import('playwright').Page} page
 */
export async function captureOrderPageDom(page) {
    const report = {
        tool: CAPTURE_VERSION,
        identified: false,
        pageUrl: null,
        pageTitle: null,
        radios: [],
        totals: [],
        submitControls: [],
        paymentSurface: [],
        identity: [],
        // Structural attestations.
        radioSelected: false,
        submitClicked: false,
        reportOrdered: false,
        supabaseWritten: false,
        statusChanged: false,
        error_code: null,
        failureReason: null,
    };

    report.pageUrl = sanitize(page.url());
    report.pageTitle = sanitize(await page.title().catch(() => null));

    const frame = await findOrderFrame(page).catch(() => null);

    if (!frame) {
        report.error_code = "ORDER_PAGE_NOT_IDENTIFIED";
        report.failureReason =
            "No frame on this page could be positively identified as the order page. " +
            "Nothing was captured.";
        return report;
    }

    report.identified = true;

    report.radios = await captureRadios(frame).catch(() => []);
    report.totals = await captureTotals(frame).catch(() => []);
    report.submitControls = await captureSubmit(frame).catch(() => []);
    report.paymentSurface = await capturePaymentSurface(frame).catch(() => []);
    report.identity = await captureIdentity(frame).catch(() => []);

    return report;
}
