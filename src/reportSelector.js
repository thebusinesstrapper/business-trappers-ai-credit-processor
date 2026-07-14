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
const ACTIVE_VERIFY_TIMEOUT = 15000;

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

// How long CreditHero may take to POPULATE the report dropdown over XHR.
// Deliberately NOT the same constant as SELECTOR_TIMEOUT (line 37), which bounds
// how long an ACTION may take. A discovery window and an action timeout are
// different things, and sharing a name would couple them by accident.
const SELECTOR_DISCOVERY_TIMEOUT = 20000;

/**
 * Read the selector's current state. Pure read; touches nothing.
 *
 * ===========================================================================
 * THE SELECTOR EXISTING IS NOT THE SELECTOR BEING POPULATED.
 *
 * findReportSelector() takes a SINGLE SNAPSHOT of document.querySelectorAll
 * ("select"). It has no wait of any kind. CreditHero fetches the report history
 * over XHR after the page load event, so a snapshot taken the moment the page
 * settles sees either no <select> at all, or one with no options yet — and we
 * report REPORT_SELECTOR_UNREADABLE on a page whose selector is perfectly fine
 * and arrives half a second later.
 *
 * This is the SAME bug as the Edit Profile modal: we queried for state that
 * arrives asynchronously, exactly once, with no wait. It passes when we win the
 * race and fails when we lose it — which is precisely why the standalone spike
 * found the dates and this run did not.
 *
 * We poll for the real end-state rather than sleeping. The reader stays the
 * single authoritative implementation; only its patience changes.
 * ===========================================================================
 */
export async function readReportSelector(page) {
    const deadline = Date.now() + SELECTOR_DISCOVERY_TIMEOUT;

    let found = null;

    while (Date.now() < deadline) {
        found = await findReportSelector(page);

        if (found) break;

        await page.waitForTimeout(500);
    }

    if (!found) {
        // ---- REPORT WHAT WE ACTUALLY SAW -----------------------------------
        //
        // "Could not locate a report selector" cannot distinguish TWO completely
        // different failures:
        //
        //   ZERO selects on the page        -> we are on the wrong page, or it
        //                                      never loaded.
        //   Selects present, but their
        //   options are not report dates    -> we are on the right page but the
        //                                      dropdown is empty, or CreditHero
        //                                      changed its markup.
        //
        // Those need opposite fixes, and the old message pointed at neither.
        const seen = await snapshotSelects(page);

        return {
            ok: false,
            error:
                `Could not locate a report selector containing recognisable report dates after ` +
                `${SELECTOR_DISCOVERY_TIMEOUT / 1000}s. No selector is guessed — processing stops rather than ` +
                `reading an unidentified control. ` +
                (seen.length === 0
                    ? `NO <select> elements were visible on this page at all, which suggests we are ` +
                      `not on the report page, or it never finished loading.`
                    : `${seen.length} visible <select> element(s) were found, but none carried options ` +
                      `that parse as report dates. See selectsSeen.`),
            selector: null,
            selectsSeen: seen,
            currentUrl: page.url(),
        };
    }

    return { ok: true, selector: found.parsed, raw: found.select };
}

/**
 * Every visible <select> on the page, with its options. Diagnostic only.
 *
 * Read-only. Touches nothing. Exists so a failed read produces EVIDENCE rather
 * than another round of guessing at what CreditHero rendered.
 */
async function snapshotSelects(page) {
    const seen = [];

    for (const frame of page.frames()) {
        try {
            const selects = await frame.evaluate(() => {
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
                        optionCount: sel.options.length,
                        options: Array.from(sel.options).slice(0, 12).map((o) => (o.text || "").trim()),
                    }));
            });

            seen.push(...selects);
        } catch {
            // detached or cross-origin frame
        }
    }

    return seen;
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

    // ---- VERIFY THE SELECTION IS ACTUALLY ACTIVE --------------------------
    //
    // selectOption() succeeding proves ONE thing: Playwright set the <select>'s
    // value. It does NOT prove the application reacted — that the change event
    // fired, that the app re-fetched, or that the page now shows the report we
    // asked for.
    //
    // If we assume it did, and it did not, we extract the OLD report while
    // believing we have the new one. That is the worst possible failure of this
    // module: it is silent, it is invisible in the logs, and it produces a
    // dispute package built on stale facts that we would swear was current.
    //
    // So we read the page BACK and confirm.
    const verification = await verifyActiveReport(page, option);

    if (!verification.ok) {
        return {
            ok: false,
            error:
                `Selected "${option.text}", but could not verify it became the ACTIVE report: ` +
                `${verification.error} Failing closed — we do not extract a report we cannot confirm ` +
                `is the one we chose.`,
            selectionAttempted: { value: option.value, text: option.text },
        };
    }

    console.log(`Verified active report: "${option.text}"`);

    return {
        ok: true,
        selected: { value: option.value, text: option.text },
        verifiedActive: true,
    };
}

/**
 * Confirm the selector now reports our chosen option as the ACTIVE one.
 *
 * Polls rather than assuming: the app may re-render asynchronously after the
 * change event. Fails closed on timeout.
 */
export async function verifyActiveReport(page, expected, options = {}) {
    const timeoutMs = options.timeoutMs ?? ACTIVE_VERIFY_TIMEOUT;
    const intervalMs = options.intervalMs ?? 500;

    const started = Date.now();
    let lastSeen = null;

    while (Date.now() - started < timeoutMs) {
        const found = await findReportSelector(page);

        if (found) {
            const active = found.select.options.find((o) => o.selected) ?? null;
            lastSeen = active?.text ?? found.select.selectedValue ?? null;

            const valueMatches = found.select.selectedValue === expected.value;
            const optionMatches = active?.value === expected.value;

            if (valueMatches || optionMatches) {
                return { ok: true, activeReport: expected.text };
            }
        }

        await page.waitForTimeout(intervalMs);
    }

    return {
        ok: false,
        error:
            `After ${Math.round((Date.now() - started) / 1000)}s the active report still reads ` +
            `"${lastSeen ?? "(unreadable)"}", not "${expected.text}".`,
        expected: expected.text,
        lastSeen,
    };
}
