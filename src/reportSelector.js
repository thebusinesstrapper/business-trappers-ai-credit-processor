/**
 * reportSelector.js
 *
 * Browser-bound. Reads the Credit Hero report selector and selects a report.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE MAY DO
 *
 *   READ  the report selector's options.
 *   SELECT an EXISTING report from it.
 *
 * WHAT IT MAY NEVER DO
 *
 *   Click anything that orders, refreshes, purchases, or regenerates a report.
 *   Navigate to the order page.
 *   Touch the subscription.
 *
 * Every option is checked against isSelectableReportOption() before it is
 * touched: it must parse as a date AND carry no order/refresh/purchase language.
 * An option we cannot positively identify is an option we do not click. We do
 * not discover what a control does by using it — on this site, some of them
 * spend the client's money.
 *
 * ---------------------------------------------------------------------------
 * SELECTOR MARKUP IS NOT YET CONFIRMED.
 *
 * The candidate strategies below are derived from the identifier spike, which
 * found a visible <select> carrying report dates. That was a spike, not a
 * frozen contract. Per project rules, NO SELECTOR IS GUESSED — so this module
 * TRIES candidates and FAILS CLOSED with a diagnostic if none match, rather
 * than silently picking whatever <select> happens to be first on the page.
 * ---------------------------------------------------------------------------
 */

import { readSelector, isSelectableReportOption } from "./reportFreshness.js";

const SELECTOR_TIMEOUT = 20000;

function cssAttrValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Find the report-date selector across all frames.
 *
 * Returns { frame, select, parsed } or null.
 */
export async function findReportSelector(page) {
    for (const frame of page.frames()) {
        let selects;

        try {
            selects = await frame.evaluate(() => {
                const visible = (el) => {
                    const r = el.getBoundingClientRect();
                    const s = window.getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
                };

                return Array.from(document.querySelectorAll("select"))
                    .filter(visible)
                    .map((sel) => ({
                        id: sel.id || null,
                        name: sel.getAttribute("name"),
                        selectedValue: sel.value,
                        options: Array.from(sel.options).map((o) => ({
                            value: o.value,
                            text: (o.text || "").trim(),
                            selected: o.selected,
                        })),
                    }));
            });
        } catch {
            continue; // detached or cross-origin frame
        }

        for (const select of selects) {
            const parsed = readSelector(select.options);

            // A report selector is one whose options are REPORT DATES. Not a
            // <select> that merely exists. This is what stops us grabbing a
            // "sort by" or "bureau" dropdown and treating it as report history.
            if (parsed.count >= 1) {
                return { frame, select, parsed };
            }
        }
    }

    return null;
}

/** Read the selector's current state. Pure read; touches nothing. */
export async function readReportSelector(page) {
    const found = await findReportSelector(page);

    if (!found) {
        return {
            ok: false,
            error:
                "Could not locate a report selector containing recognisable report dates. No selector " +
                "is guessed. Processing stops rather than reading an unidentified control.",
            selector: null,
        };
    }

    return { ok: true, selector: found.parsed, raw: found.select };
}

/**
 * Select a specific report by its option value.
 *
 * GUARDED: the option's own text is re-verified against
 * isSelectableReportOption() immediately before selection — we do not trust a
 * decision made from a stale read of a page that may have changed underneath us.
 */
export async function selectReport(page, target) {
    const found = await findReportSelector(page);

    if (!found) {
        return { ok: false, error: "Report selector disappeared before selection." };
    }

    const option = found.select.options.find((o) => o.value === target.value);

    if (!option) {
        return {
            ok: false,
            error: `Report option "${target.text}" is no longer present in the selector.`,
        };
    }

    // RE-VERIFY against the LIVE page, not the earlier read.
    if (!isSelectableReportOption(option.text)) {
        return {
            ok: false,
            error:
                `Refusing to select option "${option.text}": it does not positively parse as an ` +
                `existing report date, or it carries order/refresh/purchase language. This control is ` +
                `not touched.`,
        };
    }

    const locator = found.select.id
        ? found.frame.locator(`select[id="${cssAttrValue(found.select.id)}"]`)
        : found.frame.locator(`select[name="${cssAttrValue(found.select.name)}"]`);

    console.log(`Selecting report: "${option.text}"`);
    console.log("This selects an EXISTING report. It does not order, refresh, or purchase.");

    await locator.selectOption(option.value, { timeout: SELECTOR_TIMEOUT });

    return { ok: true, selected: { value: option.value, text: option.text } };
}
