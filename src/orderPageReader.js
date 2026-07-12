/**
 * orderPageReader.js
 *
 * READ-ONLY. Reads the Credit Hero Order New Report page and returns a
 * structured OrderPageState.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE MAKES NO DECISIONS AND TAKES NO ACTIONS.
 *
 * It does not decide whether to order. It does not select. It does not submit.
 * It reads the page and describes what it sees.
 *
 * The decision belongs to acquisitionDecision.js (a pure function). The action,
 * if ever authorized, belongs to a separate Order Submitter module.
 *
 * Per Report Acquisition Authority™ §7: "The Submitter never makes decisions.
 * The Decision Engine never acts. Neither can, alone, spend the client's money."
 *
 * VERIFIABLE INVARIANT: this file contains no click, fill, check, selectOption,
 * press, tap, focus, hover, or submit call. Grep it.
 * ---------------------------------------------------------------------------
 */

/**
 * Known option identifiers on the Order New Report page.
 *
 * These were supplied from discovery. Everything else with a productBuyNew_*
 * identifier is UNACCOUNTED FOR and is treated as a hard failure — see
 * Report Acquisition Authority™ §3.1:
 *
 *   "A page we cannot fully account for is a page we do not act on."
 *
 * The numbering (_01, _03) implies an _02 that we have never been shown. If it
 * exists, this reader will surface it and the decision engine will fail closed.
 */
export const FREE_OPTION_ID = "productBuyNew_01";
export const PAID_OPTION_ID = "productBuyNew_03";

const KNOWN_OPTION_IDS = [FREE_OPTION_ID, PAID_OPTION_ID];

// Any control whose id looks like a purchase option.
const OPTION_ID_PATTERN = /^productBuyNew_\d+$/i;

const READ_TIMEOUT = 20000;

/**
 * Parse an availability date from an option's label.
 *
 * Observed format: "(Available 8/10/2026) 3 Bureau Report & Score FREE."
 *
 * This matters because a disabled option is NOT necessarily an error. A free
 * report that becomes available on a future date is a NORMAL business state —
 * the client is simply waiting out their 30-day membership refresh. Treating
 * that as manual_review would escalate every waiting client to a human.
 *
 * Returns an ISO date string, or null if no date is stated.
 */
export function parseAvailableFrom(text) {
    if (typeof text !== "string") return null;

    const match = text.match(/\bavailable\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
    if (!match) return null;

    const [, month, day, year] = match;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    // Reject impossible dates rather than emitting garbage.
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return null;

    return iso;
}

/**
 * Parse a cost from text bound to a SPECIFIC option.
 *
 * Returns { cost, evidence } where cost is a number, or null if the cost could
 * not be affirmatively determined.
 *
 * CRITICAL — "null" is not "free". Per §3:
 *
 *   "Absence of evidence of cost is not evidence of no cost."
 *
 * A blank, missing, or unreadable price yields null, and null fails closed to
 * manual_review. It never becomes zero.
 *
 * Note also that this function is only ever applied to text read from a
 * specific option's own label/price region — never to the page at large. The
 * word "free" in a promotional banner elsewhere on the page must not be able to
 * price an option.
 */
export function parseCost(text) {
    if (typeof text !== "string" || !text.trim()) {
        return { cost: null, evidence: null };
    }

    const normalized = text.replace(/\s+/g, " ").trim();

    // Collect EVERY dollar amount in this option's bound text.
    //
    // Multiple distinct prices is AMBIGUITY, not a puzzle to solve. "Was $39.99,
    // now $0.00" — a strikethrough promo, a bundled price, a crossed-out list
    // price — we cannot tell from text alone which one this control actually
    // charges. Picking the lower one is how a client gets billed $39.99.
    //
    // Ambiguity never resolves toward spending. (§3)
    const amounts = [...normalized.matchAll(/\$\s*(\d{1,5}(?:\.\d{2})?)/g)].map((m) => ({
        value: Number(m[1]),
        evidence: m[0],
    }));

    const distinct = [...new Set(amounts.map((a) => a.value))];

    if (distinct.length > 1) {
        // Two or more different prices bound to one option. Refuse to price it.
        return { cost: null, evidence: null, ambiguous: true };
    }

    if (distinct.length === 1) {
        return { cost: amounts[0].value, evidence: amounts[0].evidence };
    }

    // No dollar amount at all. Fall back to explicit no-cost wording — but only
    // wording bound to THIS option, never the page at large.
    const freeMatch = normalized.match(/\b(free|no\s*cost|included|complimentary)\b/i);
    if (freeMatch) {
        return { cost: 0, evidence: freeMatch[0] };
    }

    return { cost: null, evidence: null };
}

/**
 * Runs INSIDE the browser. Reads. Changes nothing.
 */
function readOrderPageInFrame(optionPatternSource) {
    const optionPattern = new RegExp(optionPatternSource, "i");

    const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
        );
    };

    /**
     * The text bound to THIS option — its label, and the nearest block that
     * contains it. This is where a price must be found. We deliberately do NOT
     * fall back to page-wide text: a "FREE" banner elsewhere must never be able
     * to price this control.
     */
    const boundText = (el) => {
        const parts = [];

        if (el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) parts.push((lbl.innerText || "").trim());
        }

        const wrapping = el.closest("label");
        if (wrapping) parts.push((wrapping.innerText || "").trim());

        if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
        if (el.getAttribute("value")) parts.push(el.getAttribute("value"));
        if ((el.innerText || "").trim()) parts.push((el.innerText || "").trim());

        // Nearest containing block — where the price usually lives.
        let node = el;
        for (let i = 0; i < 4 && node.parentElement; i++) {
            node = node.parentElement;
            const t = (node.innerText || "").trim();
            if (t && t.length < 500) {
                parts.push(t);
                break;
            }
        }

        return parts.filter(Boolean);
    };

    // Every control that looks like a purchase option — known or not.
    const controls = Array.from(
        document.querySelectorAll('input, button, a, [role="radio"], [role="button"]')
    ).filter((el) => el.id && optionPattern.test(el.id));

    const options = controls.map((el) => ({
        id: el.id,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        value: el.getAttribute("value"),
        visible: isVisible(el),
        // READ. Never set.
        disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
        checked_state: el.checked === undefined ? null : el.checked,
        bound_text: boundText(el),
    }));

    return {
        url: location.href,
        title: document.title,
        options,
    };
}

/**
 * Read the Order New Report page.
 *
 * @param {import('playwright').Page} page - the ORDER page, already open
 * @returns {Promise<OrderPageState>}
 */
export async function readOrderPage(page) {
    console.log("Reading Order New Report page (READ-ONLY — nothing will be selected)...");

    const deadline = Date.now() + READ_TIMEOUT;

    let raw = null;

    // Poll for the options to render. The options themselves are the readiness
    // signal — the same approach used for Import/Audit, and for the same reason:
    // there is nothing more authoritative to wait on.
    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            try {
                const result = await frame.evaluate(
                    readOrderPageInFrame,
                    OPTION_ID_PATTERN.source
                );

                if (result.options.length > 0) {
                    raw = result;
                    break;
                }
            } catch {
                // detached / cross-origin frame
            }
        }

        if (raw) break;

        await page.waitForTimeout(250);
    }

    if (!raw) {
        console.error("No purchase options found on the Order New Report page.");

        return {
            page_read: false,
            url: page.url(),
            options: [],
            unaccounted_option_ids: [],
            errors: ["No productBuyNew_* options found on the page."],
        };
    }

    // Price each option from ITS OWN bound text.
    const options = raw.options.map((option) => {
        let cost = null;
        let evidence = null;
        let availableFrom = null;

        for (const text of option.bound_text) {
            const parsed = parseCost(text);

            if (cost === null && parsed.cost !== null) {
                cost = parsed.cost;
                evidence = parsed.evidence;
            }

            if (availableFrom === null) {
                availableFrom = parseAvailableFrom(text);
            }
        }

        return {
            ...option,
            cost,                         // null = COULD NOT DETERMINE. Not free.
            cost_evidence: evidence,
            available_from: availableFrom, // ISO date, or null if not stated
            is_known: KNOWN_OPTION_IDS.includes(option.id),
        };
    });

    // §3.1 — anything we cannot account for.
    const unaccounted = options.filter((o) => !o.is_known).map((o) => o.id);

    if (unaccounted.length) {
        console.error(
            `UNACCOUNTED purchase options on the order page: ${unaccounted.join(", ")}. ` +
            `We do not act on a page we cannot fully account for.`
        );
    }

    console.log("Order page options read:");
    for (const o of options) {
        console.log(
            `  ${o.id}: cost=${o.cost === null ? "UNKNOWN" : o.cost} ` +
            `(evidence: ${o.cost_evidence ?? "none"}) ` +
            `disabled=${o.disabled} visible=${o.visible} known=${o.is_known}`
        );
    }

    return {
        page_read: true,
        url: raw.url,
        title: raw.title,
        options,
        unaccounted_option_ids: unaccounted,
        errors: [],
    };
}
