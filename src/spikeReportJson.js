/**
 * spikeReportJson.js
 *
 * VIEW JSON DISCOVERY SPIKE — DISPOSABLE SCAFFOLDING.
 *
 * Determines whether the Credit Hero report page's "View JSON" capability can
 * become the primary Capture Engine input, replacing DOM parsing.
 *
 * If it can, this is a large win: the Capture Engine stops being a fragile
 * scraper and becomes a parser, and Extraction System §10.1 (are tri-bureau
 * tradelines merged or separate?) answers itself — a JSON structure either
 * nests bureaus beneath a tradeline or it does not.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY BY DEFAULT.
 *
 * Strategy 1 (always): PASSIVE NETWORK CAPTURE. Listeners are attached BEFORE
 * navigation, so if the report page already fetches its data as JSON, we
 * capture it having touched nothing at all. This also answers "client-side or
 * server-returned" for free:
 *
 *     caught on the wire  -> SERVER-RETURNED
 *     not caught          -> CLIENT-SIDE generated from the DOM, and therefore
 *                            strictly less useful than the DOM itself
 *
 * Strategy 2 (opt-in only): a SINGLE, NAMED click of the View JSON control,
 * enabled only by passing clickViewJson: true. Per Extraction System §4.1:
 * "If a click is required to reveal a section, that click is approved
 * individually and named in code — never inferred at runtime."
 *
 * No other control on the page is ever touched.
 * ---------------------------------------------------------------------------
 *
 * PII HANDLING. A credit report contains SSN fragments, dates of birth, and
 * addresses. This spike emits a KEY SKELETON — paths, types, array lengths —
 * and redacted samples. We need the SHAPE of the data, not the client's data.
 * Raw values are never returned in full and never logged.
 */

const MAX_BODY_CAPTURE = 2_000_000; // 2MB per response; a tri-merge report is large
const MAX_SAMPLE_CHARS = 120;
const MAX_SKELETON_NODES = 400;

/** Field names whose VALUES must never be emitted, even as samples. */
const PII_KEY_PATTERN = /ssn|social|dob|birth|tax.?id|account.?number|phone|email|address|street/i;

/**
 * Redact a value for safe inclusion in the spike output.
 *
 * We report the TYPE and SHAPE of every value. We report the CONTENT of almost
 * none of it.
 */
function redact(key, value) {
    if (value === null) return null;

    if (PII_KEY_PATTERN.test(key)) {
        return `[REDACTED ${typeof value}]`;
    }

    if (typeof value === "string") {
        // Even non-PII strings get truncated — a "remarks" field can carry a lot.
        return value.length > MAX_SAMPLE_CHARS
            ? value.slice(0, MAX_SAMPLE_CHARS) + "…"
            : value;
    }

    return value;
}

/**
 * Build a structural skeleton of a JSON object.
 *
 * This is the deliverable. It tells us whether the payload contains tradelines,
 * collections, inquiries, personal information, public records, payment
 * history, and bureau attribution — and crucially, HOW THEY ARE NESTED.
 */
export function buildSkeleton(value, path = "$", depth = 0, nodes = { count: 0 }) {
    if (nodes.count++ > MAX_SKELETON_NODES || depth > 8) {
        return { path, type: "…truncated" };
    }

    if (value === null) return { path, type: "null" };

    if (Array.isArray(value)) {
        return {
            path,
            type: "array",
            length: value.length,
            // One representative element. Arrays of 300 tradelines all share a shape.
            element: value.length
                ? buildSkeleton(value[0], `${path}[0]`, depth + 1, nodes)
                : null,
        };
    }

    if (typeof value === "object") {
        const children = {};

        for (const [key, child] of Object.entries(value)) {
            if (nodes.count > MAX_SKELETON_NODES) break;

            children[key] =
                child !== null && typeof child === "object"
                    ? buildSkeleton(child, `${path}.${key}`, depth + 1, nodes)
                    : { path: `${path}.${key}`, type: typeof child, sample: redact(key, child) };
        }

        return { path, type: "object", keys: Object.keys(value), children };
    }

    return { path, type: typeof value, sample: redact(path, value) };
}

/**
 * Does this payload look like a complete credit report, and how is it shaped?
 *
 * Directly answers the Extraction System's open questions.
 */
export function analyzeReportShape(json) {
    const flat = JSON.stringify(json);

    const has = (pattern) => new RegExp(pattern, "i").test(flat);

    const sections = {
        tradelines: has('"(trade|tradelines?|accounts?)"'),
        collections: has('"collections?"'),
        inquiries: has('"inquir(y|ies)"'),
        personal_information: has('"(personal|consumer|identity|names?|addresses)"'),
        public_records: has('"public.?records?"'),
        payment_history: has('"payment.?(history|pattern|grid)"'),
        scores: has('"scores?"'),
    };

    // ---- THE §10.1 QUESTION -------------------------------------------------
    //
    // Are the three bureaus nested BENEATH a tradeline (merged), or are there
    // three parallel per-bureau lists (separate)?
    //
    // This single question determines whether the stable_item_key matching
    // cascade (Extraction §7.4) is load-bearing in full, or largely collapses
    // because Credit Hero hands us the grouping.

    const bureauKeys = ["transunion", "experian", "equifax", "tui", "exp", "eqf"];

    const bureauKeyHits = bureauKeys.filter((b) =>
        new RegExp(`"${b}"\\s*:`, "i").test(flat)
    );

    // A merged shape looks like: tradelines[0].{transunion,experian,equifax}
    // A separate shape looks like: {transunion:{tradelines:[]}, experian:{...}}
    let bureau_nesting = "unknown";

    const merged = /"(trade|tradelines?|accounts?)"\s*:\s*\[[^\]]{0,4000}?"(transunion|experian|equifax)"\s*:/i.test(flat);
    const separate = /"(transunion|experian|equifax)"\s*:\s*\{[^}]{0,4000}?"(trade|tradelines?|accounts?)"\s*:/i.test(flat);

    if (merged && !separate) bureau_nesting = "MERGED — bureaus nested beneath each tradeline";
    else if (separate && !merged) bureau_nesting = "SEPARATE — parallel per-bureau lists";
    else if (merged && separate) bureau_nesting = "BOTH patterns detected — inspect skeleton manually";

    return {
        sections_present: sections,
        bureau_keys_found: bureauKeyHits,
        bureau_nesting,
        payload_bytes: flat.length,
        looks_like_complete_report:
            sections.tradelines && sections.inquiries && bureauKeyHits.length > 0,
    };
}

/**
 * Attach network listeners. MUST be called BEFORE navigating to the report page,
 * or we miss the very requests we are trying to catch.
 *
 * Returns a live array that fills as responses arrive.
 */
export function captureJsonResponses(page) {
    const captured = [];

    page.on("response", async (response) => {
        try {
            const request = response.request();
            const url = response.url();
            const contentType = (response.headers()["content-type"] || "").toLowerCase();

            const looksJson =
                contentType.includes("json") ||
                /\.json(\?|$)/i.test(url) ||
                /json/i.test(url);

            if (!looksJson) return;

            const record = {
                url,
                method: request.method(),
                status: response.status(),
                content_type: contentType,
                resource_type: request.resourceType(),
                is_xhr: ["xhr", "fetch"].includes(request.resourceType()),
                post_data: request.postData()?.slice(0, 500) ?? null,
            };

            const body = await response.text().catch(() => null);

            if (body && body.length < MAX_BODY_CAPTURE) {
                try {
                    const parsed = JSON.parse(body);
                    record.parsed_ok = true;
                    record.analysis = analyzeReportShape(parsed);
                    record.skeleton = buildSkeleton(parsed);
                } catch {
                    record.parsed_ok = false;
                    record.body_preview = body.slice(0, 300);
                }
            } else if (body) {
                record.parsed_ok = false;
                record.note = `Body too large to capture (${body.length} bytes).`;
            }

            captured.push(record);

            console.log(
                `JSON response captured: ${record.method} ${record.status} ` +
                `${url.slice(0, 120)} (xhr=${record.is_xhr})`
            );
        } catch {
            // A response can be gone before we read it. Never let capture break the run.
        }
    });

    return captured;
}

/**
 * Inventory the report page's controls WITHOUT touching them.
 *
 * Covers the View JSON control plus the bureau tabs and report-date dropdown
 * found during manual review — all of which the Capture Engine will eventually
 * need to understand.
 */
export async function inventoryReportControls(page) {
    const results = [];

    for (const frame of page.frames()) {
        try {
            const found = await frame.evaluate(() => {
                const isVisible = (el) => {
                    const r = el.getBoundingClientRect();
                    const s = window.getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
                };

                const describe = (el) => ({
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    type: el.getAttribute("type"),
                    name: el.getAttribute("name"),
                    href: el.getAttribute("href"),
                    onclick: el.getAttribute("onclick"),
                    text: (el.innerText || el.value || "").trim().slice(0, 80),
                    visible: isVisible(el),
                    disabled: Boolean(el.disabled),
                });

                const controls = Array.from(
                    document.querySelectorAll('a, button, input, select, [role="button"], [role="tab"]')
                ).filter(isVisible);

                const JSON_PATTERN = /view\s*json|json/i;
                const BUREAU_PATTERN = /transunion|equifax|experian|all\s*bureaus/i;

                return {
                    view_json_controls: controls
                        .filter((el) => JSON_PATTERN.test((el.innerText || el.value || el.id || "")))
                        .map(describe),

                    bureau_controls: controls
                        .filter((el) => BUREAU_PATTERN.test((el.innerText || el.value || "")))
                        .map(describe),

                    selects: Array.from(document.querySelectorAll("select"))
                        .filter(isVisible)
                        .map((sel) => ({
                            ...describe(sel),
                            options: Array.from(sel.options)
                                .slice(0, 30)
                                .map((o) => ({ value: o.value, text: (o.text || "").trim().slice(0, 60) })),
                        })),
                };
            });

            results.push({ frame_url: frame.url(), ...found });
        } catch {
            // detached / cross-origin
        }
    }

    return results;
}

const VIEW_JSON_LABEL = /view\s*json/i;

/**
 * OPT-IN ONLY. Click the View JSON control — and nothing else, ever.
 *
 * This is the single, individually-named click permitted by Extraction §4.1.
 * It runs only when the caller explicitly passes clickViewJson: true.
 *
 * Before clicking, we verify the control is what we think it is: its text must
 * match "View JSON", and if it carries an href, that href must not point
 * anywhere forbidden. We do not click controls we cannot identify.
 */
export async function clickViewJson(page) {
    console.log("clickViewJson: ENABLED by explicit request. Clicking ONE named control.");

    for (const frame of page.frames()) {
        const control = frame
            .getByRole("button", { name: VIEW_JSON_LABEL })
            .or(frame.getByRole("link", { name: VIEW_JSON_LABEL }))
            .or(frame.locator("a", { hasText: VIEW_JSON_LABEL }))
            .or(frame.locator("button", { hasText: VIEW_JSON_LABEL }))
            .first();

        if (!(await control.count().catch(() => 0))) continue;

        // Verify before acting. An href into the order flow is a hard stop.
        const href = await control.getAttribute("href").catch(() => null);

        if (href && /mcc_order_select_v2\.asp/i.test(href)) {
            throw new Error(
                `BLOCKED: the control matching "View JSON" links to the order page. Refusing to click. href=${href}`
            );
        }

        await control.click();

        console.log("View JSON clicked. Waiting for any resulting response...");

        // Give the network a moment to produce whatever the click triggers. The
        // passive listener catches it; there is nothing more specific to wait on
        // because what the click does is precisely what we are trying to learn.
        await page.waitForTimeout(3000);

        return { clicked: true, frame_url: frame.url() };
    }

    return { clicked: false, reason: "No control matching /view\\s*json/i was found." };
}
