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
 * ===========================================================================
 * DIAGNOSTIC ONLY. THIS MUST NEVER GATE ANYTHING.
 *
 * It reports what was FOUND. It expresses no view on whether the report is
 * trustworthy, whether a dispute is warranted, or whether extraction may proceed.
 * Per Extraction System §5.2: COMPLETENESS IS NOT CONFIDENCE.
 *
 * `looks_like_complete_report` is precisely the field a future caller would be
 * tempted to branch on — and a heuristic that becomes load-bearing is a heuristic
 * that will one day silently drop a real report. If a gate is ever needed, it goes
 * in the Normalization Engine, against the parsed model, not against a regex over
 * a JSON string.
 *
 * ---------------------------------------------------------------------------
 * WHY IT REPORTED FALSE ON A PERFECTLY GOOD REPORT
 *
 * Every pattern anchored on a quote followed by a generic English word —
 * `"tradelines"`, `"inquiry"`, `"scores"`. MISMO 2.4 names its containers
 * `"CREDIT_LIABILITY"`, `"CREDIT_INQUIRY"`, `"CREDIT_SCORE"`. The quote is
 * followed by `CREDIT_`, so every pattern missed, and the analyzer declared a
 * complete tri-bureau MISMO report to be "not a report".
 *
 * The analyzer was written against an imagined schema. The payload is real.
 * ===========================================================================
 */

/**
 * MISMO 2.4 container names, as emitted by Array.io.
 *
 * These are the names CONFIRMED present in the captured payload. Anything not
 * confirmed is detected but never assumed.
 */
const MISMO_SECTIONS = Object.freeze({
    tradelines:           ['"CREDIT_LIABILITY"'],
    inquiries:            ['"CREDIT_INQUIRY"'],
    scores:               ['"CREDIT_SCORE"'],
    credit_files:         ['"CREDIT_FILE"'],
    summary:              ['"CREDIT_SUMMARY"'],
    public_records:       ['"CREDIT_PUBLIC_RECORD"'],
    personal_information: ['"CREDIT_BORROWER"', '"BORROWER"', '"_RESIDENCE"'],
    payment_history:      ['"_PAYMENT_PATTERN"', '"CREDIT_LIABILITY_PAYMENT_PATTERN"'],
    repositories:         ['"CREDIT_REPOSITORY"', '"CREDIT_REPOSITORY_INCLUDED"'],
});

/**
 * Generic (non-MISMO) shape. Retained so the analyzer still says something useful
 * if Credit Hero ever serves a different payload.
 */
const GENERIC_SECTIONS = Object.freeze({
    tradelines:           ['"trade"', '"tradeline"', '"tradelines"', '"accounts"'],
    collections:          ['"collection"', '"collections"'],
    inquiries:            ['"inquiry"', '"inquiries"'],
    personal_information: ['"personal"', '"consumer"', '"identity"', '"names"', '"addresses"'],
    public_records:       ['"public_records"', '"publicRecords"'],
    payment_history:      ['"payment_history"', '"paymentHistory"'],
    scores:               ['"score"', '"scores"'],
});

/**
 * COLLECTIONS ARE NOT A SEPARATE MISMO SECTION.
 *
 * In MISMO 2.4 a collection is a CREDIT_LIABILITY carrying a collection marker —
 * not a container of its own. Looking for a "collections" section and finding
 * none does not mean the report has no collections; it means the schema does not
 * work that way.
 *
 * The old analyzer would have reported `collections: false` on a report full of
 * them, which is worse than reporting nothing at all.
 */
const MISMO_COLLECTION_MARKERS = [
    '"IsCollectionIndicator"',
    '"CollectionIndicator"',
    '"_ACCOUNT_TYPE":"Collection"',
    'Collection',
];

/** CREDIT_LIABILITY may be a single object or an array. Normalise to an array. */
function asArray(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

/**
 * THE §10.1 QUESTION — answered from STRUCTURE, not from a string match.
 *
 * Are the three bureaus nested BENEATH one tradeline (merged), or is there one
 * tradeline per bureau (separate)?
 *
 * This determines whether the stable_account_key matching cascade (Extraction
 * §7.5A) is load-bearing in full, or largely collapses because Array hands us the
 * grouping already done.
 *
 * WE DO NOT GUESS. If the liabilities do not clearly show one shape or the other,
 * this returns "unknown" and a human reads the skeleton. An analyzer that
 * confidently reports the wrong nesting would send the entire identity-key design
 * down the wrong path — and we would not find out until two bureaus' worth of one
 * account were being treated as two unrelated accounts, or vice versa.
 */
function detectBureauNesting(json) {
    const response = json?.CREDIT_RESPONSE ?? json;

    const liabilities = asArray(response?.CREDIT_LIABILITY);

    if (liabilities.length === 0) {
        return "unknown — no CREDIT_LIABILITY entries to inspect";
    }

    let merged = 0;
    let separate = 0;

    for (const liability of liabilities) {
        // MERGED: the liability owns CREDIT_REPOSITORY children, one per bureau.
        const repositories = asArray(liability?.CREDIT_REPOSITORY);

        // SEPARATE: the liability itself is stamped with exactly ONE bureau.
        const ownSource =
            liability?.CreditRepositorySourceType ??
            liability?._CreditRepositorySourceType ??
            null;

        if (repositories.length > 0) merged++;
        else if (ownSource) separate++;
    }

    if (merged > 0 && separate === 0) {
        return `MERGED — CREDIT_REPOSITORY nested beneath CREDIT_LIABILITY (${merged}/${liabilities.length} liabilities)`;
    }

    if (separate > 0 && merged === 0) {
        return `SEPARATE — each CREDIT_LIABILITY stamped with one bureau (${separate}/${liabilities.length} liabilities)`;
    }

    if (merged > 0 && separate > 0) {
        return `MIXED — ${merged} merged, ${separate} separate. Inspect the skeleton; do not assume either.`;
    }

    return "unknown — liabilities carry neither CREDIT_REPOSITORY children nor a bureau source type";
}

export function analyzeReportShape(json) {
    const flat = JSON.stringify(json);

    const hasAny = (needles) => needles.some((n) => flat.toLowerCase().includes(n.toLowerCase()));

    // ---- WHICH SCHEMA ARE WE LOOKING AT? -----------------------------------
    //
    // Detected, not assumed. A payload that is neither is reported as "unknown"
    // rather than forced into whichever map happens to match a stray key.
    const isMismo =
        flat.includes('"CREDIT_RESPONSE"') ||
        flat.includes('"CREDIT_LIABILITY"') ||
        flat.includes('"CREDIT_FILE"');

    const schema = isMismo ? "MISMO_2_4" : "UNKNOWN";

    const map = isMismo ? MISMO_SECTIONS : GENERIC_SECTIONS;

    const sections = {};

    for (const [name, needles] of Object.entries(map)) {
        sections[name] = hasAny(needles);
    }

    // Collections, handled per schema (see above).
    if (isMismo) {
        sections.collections = hasAny(MISMO_COLLECTION_MARKERS);
        sections.collections_note =
            "In MISMO 2.4 a collection is a CREDIT_LIABILITY with a collection marker, not a separate section.";
    }

    // ---- BUREAUS ------------------------------------------------------------
    const bureauNames = ["TransUnion", "Experian", "Equifax"];

    const bureausFound = bureauNames.filter((b) =>
        new RegExp(`\\b${b}\\b`, "i").test(flat)
    );

    // ---- THE §10.1 QUESTION -------------------------------------------------
    //
    // Are the three bureaus nested BENEATH one tradeline (merged), or are there
    // three parallel per-bureau lists (separate)? This determines whether the
    // stable_account_key matching cascade (Extraction §7.5A) is load-bearing in
    // full, or largely collapses because Credit Hero hands us the grouping.
    //
    // WE DO NOT GUESS THE ANSWER. The regexes below detect each shape; if neither
    // or both match, we say "unknown" and the skeleton gets read by a human. An
    // analyzer that confidently reports the wrong nesting would send the entire
    // identity-key design down the wrong path.
    // A regex over the flattened string CANNOT answer this. "CreditRepositorySourceType"
    // appears all over a real payload — CREDIT_FILE carries one per bureau (there are
    // three files), and so does CREDIT_SCORE. Matching it anywhere would report
    // "separate" on every report ever captured, including merged ones.
    //
    // The question is specifically about how a CREDIT_LIABILITY carries its bureaus,
    // so we inspect the liabilities themselves.
    const bureau_nesting = isMismo ? detectBureauNesting(json) : "unknown — not a MISMO payload";

    // ---- IS THIS A COMPLETE REPORT? -----------------------------------------
    //
    // A report needs tradelines, and it needs to name a bureau. Inquiries are NOT
    // required: a consumer with no recent hard inquiries has a complete report
    // with zero inquiries, and requiring them (as the old heuristic did) would
    // classify her perfectly good report as incomplete.
    const looks_like_complete_report = isMismo
        ? sections.tradelines && bureausFound.length > 0
        : sections.tradelines && bureausFound.length > 0;

    return {
        schema,
        sections_present: sections,
        bureaus_found: bureausFound,
        bureau_nesting,
        payload_bytes: flat.length,
        looks_like_complete_report,

        // Say it in the payload, not just in a comment.
        note:
            "DIAGNOSTIC ONLY. Reports what was found. Never gates extraction — " +
            "completeness is not confidence (Extraction System §5.2).",
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
