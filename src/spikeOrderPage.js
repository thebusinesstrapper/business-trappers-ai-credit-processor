/**
 * spikeOrderPage.js
 *
 * ORDER PAGE DISCOVERY SPIKE — DISPOSABLE SCAFFOLDING.
 *
 * Discovers the structure of the Credit Hero report ORDER page so that the
 * Report Acquisition Decision Engine can be designed against real markup rather
 * than guesses.
 *
 * DELETE THIS FILE once the acquisition decision table is frozen.
 *
 * ---------------------------------------------------------------------------
 * STRICTLY READ-ONLY. THIS PAGE CAN SPEND THE CLIENT'S MONEY.
 *
 * Every form control on this page is ENUMERATED and NEVER TOUCHED.
 *
 * Not clicked. Not checked. Not selected. Not focused. Not hovered. We read
 * the DOM's description of each control and nothing else. A radio button's
 * `checked` property is READ; it is never SET.
 *
 * This module contains no click(), fill(), check(), selectOption(), press(),
 * tap(), focus(), hover(), or form submission of any kind. That is verifiable
 * by grep, and it should be verified before this is ever run.
 *
 * We are trying to learn what the options are. We are not trying one to see
 * what happens.
 * ---------------------------------------------------------------------------
 */

const OUTER_HTML_LIMIT = 6000;
const TEXT_LIMIT = 3000;

/**
 * Runs INSIDE the browser via frame.evaluate(). Reads the DOM. Changes nothing.
 */
function discoverOrderPageInFrame(config) {
    const { outerHtmlLimit, textLimit } = config;

    const truncate = (s, n) =>
        typeof s === "string" && s.length > n
            ? s.slice(0, n) + `… [truncated, ${s.length} chars total]`
            : s;

    const domPath = (el) => {
        const parts = [];
        let node = el;

        while (node && node.nodeType === 1 && parts.length < 12) {
            let part = node.tagName.toLowerCase();

            if (node.id) {
                part += `#${node.id}`;
                parts.unshift(part);
                break;
            }

            const cls = (node.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
            if (cls.length) part += "." + cls.slice(0, 3).join(".");

            const parent = node.parentElement;
            if (parent) {
                const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
                if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
            }

            parts.unshift(part);
            node = node.parentElement;
        }

        return parts.join(" > ");
    };

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

    const attrsOf = (el) => {
        const out = {};
        for (const a of Array.from(el.attributes || [])) out[a.name] = a.value;
        return out;
    };

    /** The label text associated with a control, however Credit Hero wires it. */
    const labelFor = (el) => {
        const bits = [];

        if (el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) bits.push((lbl.innerText || "").trim());
        }

        const wrapping = el.closest("label");
        if (wrapping) bits.push((wrapping.innerText || "").trim());

        if (el.getAttribute("aria-label")) bits.push(el.getAttribute("aria-label"));

        // Nearest ancestor block, which usually carries the option's price.
        let node = el;
        for (let i = 0; i < 4 && node.parentElement; i++) {
            node = node.parentElement;
            const t = (node.innerText || "").trim();
            if (t && t.length < 400) {
                bits.push(t);
                break;
            }
        }

        return bits.filter(Boolean).map((s) => s.slice(0, 300));
    };

    // ---- Form controls: ENUMERATED, NEVER TOUCHED -------------------------
    //
    // This is the heart of the spike. The Acquisition Engine's decision table
    // will be built from exactly this evidence: what options exist, what each
    // one costs, and which control would select it.
    //
    // Note `checked` and `selected` are READ from the DOM. Nothing is SET.

    const controls = Array.from(
        document.querySelectorAll('input, select, textarea, button, [role="radio"], [role="button"], [type="submit"]')
    )
        .slice(0, 120)
        .map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type"),
            name: el.getAttribute("name"),
            id: el.id || null,
            value: el.getAttribute("value"),
            checked_state: el.checked === undefined ? null : el.checked, // READ ONLY
            disabled: el.disabled === undefined ? null : el.disabled,
            visible: isVisible(el),
            text: (el.innerText || "").trim().slice(0, 120),
            labels: labelFor(el),
            attributes: attrsOf(el),
            dom_path: domPath(el),
        }));

    // Any <select> options, listed without selecting.
    const selects = Array.from(document.querySelectorAll("select"))
        .slice(0, 20)
        .map((sel) => ({
            name: sel.getAttribute("name"),
            id: sel.id || null,
            dom_path: domPath(sel),
            options: Array.from(sel.options)
                .slice(0, 40)
                .map((o) => ({
                    value: o.value,
                    text: (o.text || "").trim().slice(0, 160),
                    selected_state: o.selected, // READ ONLY
                })),
        }));

    // ---- Forms and their submit targets -----------------------------------
    //
    // Recorded so the Acquisition Engine's authors know EXACTLY what a submit
    // would do — precisely so that Version 1 never does it.

    const forms = Array.from(document.querySelectorAll("form"))
        .slice(0, 10)
        .map((f) => ({
            action: f.getAttribute("action"),
            method: f.getAttribute("method"),
            id: f.id || null,
            name: f.getAttribute("name"),
            dom_path: domPath(f),
            control_names: Array.from(f.elements || [])
                .slice(0, 60)
                .map((e) => e.getAttribute("name"))
                .filter(Boolean),
        }));

    // ---- Cost signals -----------------------------------------------------
    //
    // The Positive Identification Standard (AI Memory Standard v1.1 Addendum)
    // requires a SPECIFIC option's cost to be affirmatively read as zero. The
    // mere presence of the word "free" on the page is NOT sufficient — that is
    // how a promotional banner gets you a $39.99 report.
    //
    // So we capture cost-bearing text WITH ITS LOCATION, never as a page-wide
    // flag. Association of a price to an option is a design decision for the
    // Acquisition Engine, made against this evidence — not guessed here.

    const COST_PATTERN = /(\$\s*\d+(?:\.\d{2})?|\bfree\b|\bno\s*cost\b|\bincluded\b|\b0\.00\b|\bcomplimentary\b)/i;

    const cost_signals = Array.from(document.querySelectorAll("body *"))
        .slice(0, 5000)
        .filter((el) => {
            const own = Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent)
                .join(" ")
                .trim();
            return own && COST_PATTERN.test(own) && isVisible(el);
        })
        .slice(0, 40)
        .map((el) => ({
            text: (el.innerText || "").trim().slice(0, 200),
            tag: el.tagName.toLowerCase(),
            dom_path: domPath(el),
            nearest_control_hint: (() => {
                // Which control, if any, sits in the same block as this price?
                let node = el;
                for (let i = 0; i < 5 && node.parentElement; i++) {
                    node = node.parentElement;
                    const ctrl = node.querySelector('input[type="radio"], input[type="checkbox"], button, [role="radio"]');
                    if (ctrl) {
                        return {
                            tag: ctrl.tagName.toLowerCase(),
                            type: ctrl.getAttribute("type"),
                            name: ctrl.getAttribute("name"),
                            value: ctrl.getAttribute("value"),
                            id: ctrl.id || null,
                        };
                    }
                }
                return null;
            })(),
        }));

    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
        .filter(isVisible)
        .slice(0, 40)
        .map((h) => ({
            tag: h.tagName.toLowerCase(),
            text: (h.innerText || "").trim().slice(0, 140),
            dom_path: domPath(h),
        }));

    return {
        page_metadata: {
            url: location.href,
            title: document.title,
            body_text_length: (document.body.innerText || "").length,
        },
        visible_text: truncate((document.body.innerText || "").trim(), textLimit),
        headings,
        forms,
        controls,
        selects,
        cost_signals,
        body_outer_html_sample: truncate(document.body.outerHTML, outerHtmlLimit),
    };
}

/**
 * Run the read-only order-page discovery spike.
 *
 * @param {import('playwright').Page} page - the ORDER page, already open
 */
export async function discoverOrderPage(page) {
    console.log("Running Order Page discovery spike (READ-ONLY — nothing will be selected or submitted)...");

    const config = { outerHtmlLimit: OUTER_HTML_LIMIT, textLimit: TEXT_LIMIT };

    const frames = page.frames();

    console.log(`Frames on order page: ${frames.length}`);

    const frameReports = [];

    for (const [index, frame] of frames.entries()) {
        const info = { index, url: frame.url(), name: frame.name() };

        console.log(`  [${index}] ${info.url}`);

        try {
            const discovery = await frame.evaluate(discoverOrderPageInFrame, config);
            frameReports.push({ ...info, ...discovery });
        } catch (error) {
            frameReports.push({ ...info, error: error.message, readable: false });
        }
    }

    const primary = frameReports
        .filter((f) => f.page_metadata)
        .sort(
            (a, b) =>
                (b.page_metadata.body_text_length || 0) - (a.page_metadata.body_text_length || 0)
        )[0];

    return {
        frame_count: frames.length,
        primary_frame_index: primary ? primary.index : null,
        frames: frameReports,

        // An explicit, machine-checkable statement of what this spike did.
        submitted: false,
        selected_any_option: false,
    };
}
