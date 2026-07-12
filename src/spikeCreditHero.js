/**
 * spikeCreditHero.js
 *
 * CREDIT HERO DOM DISCOVERY SPIKE — DISPOSABLE SCAFFOLDING.
 *
 * This is not production code. It exists to answer the architectural questions
 * in §10 of the Credit Report Extraction System™ v1.0 document, so that the
 * Capture Engine can be designed against real markup instead of guesses.
 *
 * DELETE THIS FILE once the Capture Engine architecture is frozen.
 *
 * ---------------------------------------------------------------------------
 * SAFETY INVARIANT — STRICTLY READ-ONLY. NO CLICKS. NONE.
 *
 * This module does not click, submit, hover-to-trigger, or interact with ANY
 * control on the Credit Hero page. The only DOM access is reading.
 *
 * The Credit Hero page is expected to carry controls that ORDER REPORTS,
 * REACTIVATE MONITORING, or ALTER THE CLIENT'S SUBSCRIPTION. Those actions cost
 * the client money and are irreversible. Per the Project Constitution, the AI
 * must never perform them.
 *
 * Consequently, if the credit report itself sits behind a link, THIS SPIKE
 * WILL NOT NAVIGATE TO IT. Instead it INVENTORIES every candidate link it can
 * see (§ "navigation_candidates" below) so that a human can approve one
 * specific, named link. That approved click is then added explicitly. We do not
 * discover navigation by trying doors.
 * ---------------------------------------------------------------------------
 */

// Truncation limits. A tri-merge report is megabytes of HTML; we are answering
// architectural questions, not archiving the DOM.
const OUTER_HTML_LIMIT = 4000;
const TEXT_LIMIT = 1500;
const MAX_SAMPLES_PER_KIND = 2;

const BUREAUS = ["TransUnion", "Experian", "Equifax"];

/**
 * Everything below runs INSIDE the browser via frame.evaluate().
 *
 * It is written as a single self-contained function on purpose: one round trip
 * per frame instead of hundreds of Playwright locator calls, which on a report
 * this size would be unusably slow.
 *
 * It reads the DOM. It changes nothing.
 */
function discoverInFrame(config) {
    const { outerHtmlLimit, textLimit, maxSamples, bureaus } = config;

    const truncate = (s, n) =>
        typeof s === "string" && s.length > n ? s.slice(0, n) + `… [truncated, ${s.length} chars total]` : s;

    /** Build a readable DOM path so we can find this node again. */
    const domPath = (el) => {
        const parts = [];
        let node = el;

        while (node && node.nodeType === 1 && parts.length < 12) {
            let part = node.tagName.toLowerCase();

            if (node.id) {
                part += `#${node.id}`;
                parts.unshift(part);
                break; // an id is enough to anchor
            }

            const cls = (node.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
            if (cls.length) part += "." + cls.slice(0, 3).join(".");

            const parent = node.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
                if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
            }

            parts.unshift(part);
            node = node.parentElement;
        }

        return parts.join(" > ");
    };

    /**
     * Inventory the attributes on a node and its descendants.
     *
     * THIS IS THE HIGH-VALUE QUESTION. If Credit Hero already exposes a stable
     * per-account identifier, our entire stable_item_key matching cascade may
     * collapse into "read the identifier CRC already gave us."
     */
    const identifierScan = (el) => {
        const found = {
            data_attributes: {},
            ids: [],
            aria_attributes: {},
            react_keys: [],
            other_candidates: {},
        };

        const nodes = [el, ...el.querySelectorAll("*")].slice(0, 400);

        for (const node of nodes) {
            // React internals sometimes expose the element's key/props.
            for (const prop of Object.keys(node)) {
                if (prop.startsWith("__reactProps") || prop.startsWith("__reactFiber")) {
                    try {
                        const fiber = node[prop];
                        const key = fiber?.key ?? fiber?.return?.key;
                        if (key && found.react_keys.length < 20) {
                            found.react_keys.push({ path: node.tagName.toLowerCase(), key: String(key) });
                        }
                    } catch {
                        /* not exposed */
                    }
                }
            }

            for (const attr of Array.from(node.attributes || [])) {
                const name = attr.name;
                const value = attr.value;

                if (name === "id" && value) {
                    if (found.ids.length < 25) found.ids.push({ tag: node.tagName.toLowerCase(), id: value });
                } else if (name.startsWith("data-")) {
                    if (!found.data_attributes[name]) found.data_attributes[name] = [];
                    if (found.data_attributes[name].length < 5) found.data_attributes[name].push(value);
                } else if (name.startsWith("aria-")) {
                    if (!found.aria_attributes[name]) found.aria_attributes[name] = [];
                    if (found.aria_attributes[name].length < 5) found.aria_attributes[name].push(value);
                } else if (/(^|-)(key|uuid|guid|ref|account|tradeline|item)(-|$)/i.test(name)) {
                    if (!found.other_candidates[name]) found.other_candidates[name] = [];
                    if (found.other_candidates[name].length < 5) found.other_candidates[name].push(value);
                }
            }
        }

        return found;
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

    /**
     * Find a sensible CONTAINER for a matched keyword.
     *
     * A keyword like "Balance" lands on a tiny <span>. The useful unit is the
     * repeating block that holds the whole account. We climb until the element
     * looks like a real container — has enough text and enough children — but
     * stop before we swallow the entire page.
     */
    const containerFor = (el) => {
        let node = el;

        for (let i = 0; i < 8 && node?.parentElement; i++) {
            const parent = node.parentElement;
            const text = (parent.innerText || "").trim();

            if (text.length > 4000) break; // climbed too far
            if (parent.tagName === "BODY" || parent.tagName === "MAIN") break;

            node = parent;

            if ((node.innerText || "").trim().length > 120 && node.children.length >= 2) {
                // Looks like a block, but keep climbing a little to catch the
                // full repeating unit rather than a sub-row.
                if (i >= 2) break;
            }
        }

        return node;
    };

    const sampleFor = (el) => ({
        dom_path: domPath(el),
        tag: el.tagName.toLowerCase(),
        visible: isVisible(el),
        outer_html: truncate(el.outerHTML, outerHtmlLimit),
        visible_text: truncate((el.innerText || "").trim(), textLimit),
        identifiers: identifierScan(el),
    });

    // ---- Section layout ---------------------------------------------------

    const headings = Array.from(
        document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')
    )
        .filter(isVisible)
        .slice(0, 60)
        .map((h) => ({
            tag: h.tagName.toLowerCase(),
            text: (h.innerText || "").trim().slice(0, 120),
            dom_path: domPath(h),
        }));

    // ---- Sample hunting ---------------------------------------------------
    //
    // We do NOT know Credit Hero's markup — that is the whole point of the
    // spike. So we locate candidate blocks by the words a credit report must
    // contain, then capture the surrounding container.

    const KINDS = {
        tradeline: /\b(account\s*(number|type|status)|date\s*opened|credit\s*limit|high\s*balance|payment\s*history)\b/i,
        collection: /\b(collection|original\s*creditor|placed\s*for\s*collection)\b/i,
        inquiry: /\b(inquir(y|ies)|date\s*of\s*inquiry|hard\s*inquiry)\b/i,
        score: /\b(credit\s*score|score|vantage|fico)\b/i,
        public_record: /\b(public\s*record|bankruptcy|judgment|lien)\b/i,
    };

    const samples = {};
    const seenPaths = new Set();

    const allElements = Array.from(document.querySelectorAll("body *")).slice(0, 6000);

    for (const [kind, pattern] of Object.entries(KINDS)) {
        samples[kind] = [];

        for (const el of allElements) {
            if (samples[kind].length >= maxSamples) break;

            // Only consider elements whose OWN text matches, not inherited text
            // from a giant ancestor.
            const own = Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent)
                .join(" ")
                .trim();

            if (!own || !pattern.test(own)) continue;
            if (!isVisible(el)) continue;

            const container = containerFor(el);
            const path = domPath(container);

            if (seenPaths.has(path)) continue;
            seenPaths.add(path);

            samples[kind].push({ matched_on: own.slice(0, 120), ...sampleFor(container) });
        }
    }

    // ---- Bureau presentation: MERGED vs SEPARATE --------------------------
    //
    // THE §10.1 QUESTION. If one container holds all three bureau names, the
    // report is almost certainly presented as merged rows with per-bureau
    // columns — which means Credit Hero hands us the tri-bureau grouping and
    // our matching cascade largely collapses.
    //
    // If the three bureaus appear in separate, distant containers, we own the
    // entity resolution and the full cascade is load-bearing.

    const bureauCounts = {};
    for (const b of bureaus) {
        const re = new RegExp(b.replace(/\s+/g, "\\s*"), "gi");
        const matches = (document.body.innerText || "").match(re);
        bureauCounts[b] = matches ? matches.length : 0;
    }

    // Smallest element that contains ALL THREE bureau names.
    let smallestAllThree = null;

    for (const el of allElements) {
        const text = el.innerText || "";
        if (!bureaus.every((b) => new RegExp(b.replace(/\s+/g, "\\s*"), "i").test(text))) continue;
        if (!isVisible(el)) continue;

        if (!smallestAllThree || text.length < (smallestAllThree.innerText || "").length) {
            smallestAllThree = el;
        }
    }

    const bureau_presentation = {
        counts: bureauCounts,
        all_three_in_one_container: Boolean(smallestAllThree),
        smallest_container_with_all_three: smallestAllThree
            ? {
                  dom_path: domPath(smallestAllThree),
                  text_length: (smallestAllThree.innerText || "").length,
                  visible_text: truncate((smallestAllThree.innerText || "").trim(), textLimit),
                  outer_html: truncate(smallestAllThree.outerHTML, outerHtmlLimit),
              }
            : null,
        interpretation_hint: smallestAllThree
            ? "A single container holds all three bureaus — suggests MERGED per-bureau columns."
            : "No single container holds all three bureaus — suggests SEPARATE per-bureau presentation.",
    };

    // ---- Page-wide identifier inventory -----------------------------------

    const dataAttrNames = {};
    for (const el of allElements) {
        for (const attr of Array.from(el.attributes || [])) {
            if (attr.name.startsWith("data-")) {
                dataAttrNames[attr.name] = (dataAttrNames[attr.name] || 0) + 1;
            }
        }
    }

    // ---- Navigation candidates — LISTED, NEVER CLICKED --------------------
    //
    // If the report is behind a link, we surface it for human approval rather
    // than clicking our way there. Some of these controls may order a report or
    // reactivate monitoring. We do not find out by trying.

    const navigation_candidates = Array.from(
        document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"]')
    )
        .filter(isVisible)
        .slice(0, 80)
        .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            text: (el.innerText || "").trim().slice(0, 100),
            href: el.getAttribute("href"),
            dom_path: domPath(el),
        }))
        .filter((c) => c.text || c.href);

    return {
        page_metadata: {
            url: location.href,
            title: document.title,
            body_text_length: (document.body.innerText || "").length,
        },
        headings,
        samples,
        bureau_presentation,
        page_identifiers: {
            data_attribute_names: dataAttrNames,
            element_count: allElements.length,
        },
        navigation_candidates,
    };
}

/**
 * Run the discovery spike against an open Credit Hero page.
 *
 * Searches EVERY frame, because the report may well be inside an iframe — as we
 * now suspect the CRC Import/Audit panel may be. A main-frame-only scan would
 * come back empty and tell us nothing.
 *
 * @param {import('playwright').Page} page - Credit Hero page from openCreditHero.js
 */
export async function discoverCreditHero(page) {
    console.log("Running Credit Hero DOM discovery spike (READ-ONLY, no clicks)...");

    const config = {
        outerHtmlLimit: OUTER_HTML_LIMIT,
        textLimit: TEXT_LIMIT,
        maxSamples: MAX_SAMPLES_PER_KIND,
        bureaus: BUREAUS,
    };

    const frames = page.frames();

    console.log(`Frames on Credit Hero page: ${frames.length}`);

    const frameReports = [];

    for (const [index, frame] of frames.entries()) {
        const frameInfo = {
            index,
            url: frame.url(),
            name: frame.name(),
        };

        console.log(`  [${index}] ${frameInfo.url}`);

        try {
            const discovery = await frame.evaluate(discoverInFrame, config);
            frameReports.push({ ...frameInfo, ...discovery });
        } catch (error) {
            // A frame can be cross-origin or detached. Record and continue —
            // one unreadable frame must not sink the whole spike.
            frameReports.push({
                ...frameInfo,
                error: error.message,
                readable: false,
            });
        }
    }

    // Surface the frame that actually looks like the report, so the answer is
    // not buried behind an empty chrome frame.
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
    };
}
