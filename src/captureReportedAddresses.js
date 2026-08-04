// captureReportedAddresses.js
//
// SLICE B — capture-stage extraction of bureau-reported CONSUMER addresses from
// the Credit Hero "Copy As HTML" report, for the incorrect-address dispute path.
//
// WHY THIS EXISTS SEPARATELY FROM reportNormalize.js
//   The bureau-reported addresses do NOT live in the JSON payload. They live only
//   in the HTML that Credit Hero copies to the clipboard when the "Copy As HTML"
//   control is clicked. So the source is a live browser action, not a pure data
//   transform. reportNormalize.js stays PURE (no browser); this module owns the
//   Playwright interaction and the in-browser parse, then hands a plain data
//   structure back to the capture flow.
//
// READ-ONLY / SAFE
//   "Copy As HTML" copies text to the clipboard. It does not order a report,
//   reactivate monitoring, or modify the client account. This module clicks ONLY
//   that control and reads ONLY the Personal Information table. It never touches
//   the order or reactivation controls, and never scrapes creditor addresses.
//
// FAIL CLOSED
//   Every step that can fail (locating the control, the click, the clipboard
//   read, the DOMParser parse, locating the Personal Information table, mapping
//   the three bureau columns) returns { ok: false, reason } so the caller can
//   route the client to Manual Review. It NEVER returns an empty address list as
//   if it were a successful empty result.

const COPY_AS_HTML_LABEL = "Copy As HTML";
const COPY_SUCCESS_TEXT = "Copied to clipboard successfully";

// Bounded retry / polling for making the CLIPBOARD (not the toast) authoritative.
const MAX_CAPTURE_ATTEMPTS = 3;         // click/read sequences before Manual Review
const TOAST_ADVISORY_MS = 2000;         // best-effort, non-fatal wait for the toast
const CLIPBOARD_POLL_MS = 3000;         // bounded poll window per attempt
const CLIPBOARD_POLL_INTERVAL_MS = 250; // poll cadence within an attempt

/**
 * Orchestrate the capture: click "Copy As HTML", then read the CLIPBOARD as the
 * authority (the success toast is advisory only), and parse the Personal
 * Information table in the browser context via DOMParser. Retries the
 * click/read sequence up to MAX_CAPTURE_ATTEMPTS with bounded clipboard polling;
 * returns Manual Review only after all bounded attempts fail.
 *
 * @param {import('playwright').Page} page  The report page (mcc_creditreports_v2.asp).
 * @returns {Promise<{ok:true, addresses:Array}|{ok:false, reason:string, stage:string}>}
 */
export async function captureReportedAddresses(page) {
    // ---- 1. Locate the "Copy As HTML" control by its VISIBLE TEXT ----------
    // Primary locator is the link text, scoped to the credit-report controls.
    // Not a position-only selector. getByRole covers <a>/<button>; the .or()
    // fallback covers a non-semantic clickable carrying the same text.
    let control;
    try {
        control = page
            .getByRole("link", { name: COPY_AS_HTML_LABEL, exact: false })
            .or(page.getByRole("button", { name: COPY_AS_HTML_LABEL, exact: false }))
            .or(page.getByText(COPY_AS_HTML_LABEL, { exact: false }))
            .first();

        if ((await control.count()) === 0) {
            return { ok: false, stage: "locate", reason: `"${COPY_AS_HTML_LABEL}" control not found on the report page.` };
        }
    } catch (error) {
        return { ok: false, stage: "locate", reason: `Could not locate "${COPY_AS_HTML_LABEL}": ${error.message}` };
    }

    // ---- 2. Grant clipboard read + write for this origin -------------------
    // "Copy As HTML" WRITES the clipboard; navigator.clipboard.readText() READS
    // it. Grant both so neither is silently blocked by the browser. Idempotent
    // and independent of how the context was built. If granting fails, the
    // bounded clipboard reads below fail closed with a clear reason.
    try {
        const origin = new URL(page.url()).origin;
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    } catch {
        // Non-fatal: a failed grant surfaces as an unreadable clipboard below.
    }

    // ---- 3/4/5/6. Click, then read the CLIPBOARD as the authority ----------
    // The clipboard content — not the toast — is authoritative. The visible
    // "Copied to clipboard successfully" toast is treated as advisory only: a
    // brief best-effort wait to let the copy settle on the happy path, never a
    // failure condition. Across production this toast is sometimes missed within
    // 15s even though the copy succeeded, which wrongly routed clients to Manual
    // Review; reading valid report HTML from the clipboard proves success
    // regardless of whether the toast was observed.
    //
    // Up to MAX_CAPTURE_ATTEMPTS attempts. Each attempt re-clicks, then polls the
    // clipboard for up to CLIPBOARD_POLL_MS in short CLIPBOARD_POLL_INTERVAL_MS
    // steps, accepting the first read that VALIDATES as report HTML and parses.
    // Manual Review is returned only after every bounded attempt fails.
    let lastFailure = { ok: false, stage: "clipboard", reason: "Clipboard never yielded valid report HTML." };

    for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
        // Re-click on each attempt (the copy is the only side effect; it is
        // read-only with respect to the client account).
        try {
            await control.click();
        } catch (error) {
            lastFailure = { ok: false, stage: "click", reason: `Clicking "${COPY_AS_HTML_LABEL}" failed: ${error.message}` };
            continue;
        }

        // Advisory toast wait: bounded and non-fatal. Its absence never fails.
        try {
            await page
                .getByText(COPY_SUCCESS_TEXT, { exact: false })
                .first()
                .waitFor({ state: "visible", timeout: TOAST_ADVISORY_MS });
        } catch {
            // Toast not seen — proceed to read the clipboard anyway.
        }

        // Bounded clipboard poll + validate + parse, all inside the page so the
        // HTML never leaves the browser (and is never logged).
        let result;
        try {
            result = await page.evaluate(
                async ({ coreSource, pollMs, intervalMs }) => {
                    // Validate that a clipboard string looks like the report HTML
                    // the parser expects: a non-trivial string containing an HTML
                    // table and the Personal Information section marker. This
                    // gates parsing without trusting the toast.
                    const looksLikeReportHtml = (s) => {
                        if (!s || typeof s !== "string" || s.length < 200) return false;
                        const lower = s.toLowerCase();
                        return lower.includes("<table") && lower.includes("personal information");
                    };
                    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

                    const deadline = Date.now() + pollMs;
                    let html = null;
                    // Poll until we read valid-looking HTML or the deadline passes.
                    // (First iteration runs immediately.)
                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        let candidate = null;
                        try {
                            candidate = await navigator.clipboard.readText();
                        } catch (e) {
                            candidate = null; // unreadable this tick; keep polling
                        }
                        if (looksLikeReportHtml(candidate)) {
                            html = candidate;
                            break;
                        }
                        if (Date.now() >= deadline) break;
                        await sleep(intervalMs);
                    }

                    if (!html) {
                        return { ok: false, stage: "clipboard", reason: "Clipboard did not contain valid report HTML." };
                    }

                    let doc;
                    try {
                        doc = new DOMParser().parseFromString(html, "text/html");
                    } catch (e) {
                        return { ok: false, stage: "domparser", reason: "DOMParser failed: " + (e && e.message ? e.message : String(e)) };
                    }
                    if (!doc || !doc.body) {
                        return { ok: false, stage: "domparser", reason: "DOMParser produced no document." };
                    }
                    // Reconstitute the shared parse core in the page and run it.
                    // eslint-disable-next-line no-new-func
                    const core = new Function("return (" + coreSource + ")")();
                    return core(doc);
                },
                { coreSource: PARSE_CORE_SOURCE, pollMs: CLIPBOARD_POLL_MS, intervalMs: CLIPBOARD_POLL_INTERVAL_MS }
            );
        } catch (error) {
            lastFailure = { ok: false, stage: "evaluate", reason: `Reading/parsing the copied HTML failed: ${error.message}` };
            continue;
        }

        if (result && result.ok === true) {
            return { ok: true, addresses: result.addresses };
        }

        // This attempt failed (empty/invalid clipboard or parse failure). Keep
        // the reason and retry.
        lastFailure = { ok: false, stage: result?.stage ?? "parse", reason: result?.reason ?? "Unknown parse failure." };
    }

    // All bounded attempts failed -> Manual Review, with the real last reason
    // (never "confirm"; the toast is no longer a failure condition).
    return lastFailure;
}

/**
 * PURE DOM-walking core. Extracts the Personal Information addresses from a
 * DOM `document` (or any root exposing querySelectorAll + element.children +
 * textContent). No browser globals, no external references — so it can be:
 *   (a) serialized into page.evaluate via PARSE_CORE_SOURCE, and
 *   (b) unit-tested in Node against a minimal DOM shim.
 *
 * @param {Document|Element} doc
 * @returns {{ok:true, addresses:Array}|{ok:false, stage:string, reason:string}}
 */
export function parsePiTableCore(doc) {
    const normLabel = (s) => (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const BUREAUS = { transunion: "transunion", experian: "experian", equifax: "equifax" };

    // Safe de-duplication normalizer: decides whether two bureau-reported strings
    // are the SAME address (so they can be combined with a unioned bureaus[]).
    // The dispute-side comparison vs the CRC profile uses its own normalizer in
    // analyzeCreditReport.js; this one only de-dupes identical addresses.
    const ABBR = {
        STREET: "ST", ROAD: "RD", AVENUE: "AVE", BOULEVARD: "BLVD", DRIVE: "DR",
        LANE: "LN", COURT: "CT", CIRCLE: "CIR", PLACE: "PL", TERRACE: "TER",
        HIGHWAY: "HWY", PARKWAY: "PKWY", NORTH: "N", SOUTH: "S", EAST: "E",
        WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE",
        SOUTHWEST: "SW", APARTMENT: "APT", SUITE: "STE", NUMBER: "",
    };
    const normalizeForCompare = (raw) => {
        let s = (raw || "").toUpperCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
        s = s.split(" ").map((w) => (w in ABBR ? ABBR[w] : w)).filter(Boolean).join(" ");
        s = s.replace(/\b(\d{5})-\d{4}\b/, "$1");
        return s.replace(/\s+/g, " ").trim();
    };
    const isDateOnly = (s) => /^\s*\d{1,2}\/\d{2,4}\s*$/.test(s) || /^\s*\d{1,2}\/\d{1,2}\/\d{4}\s*$/.test(s);
    const cellsOf = (row) =>
        Array.prototype.filter.call(row.children, (c) => c.tagName === "TD" || c.tagName === "TH");

    // 1. locate the Personal Information table by its two address label rows
    //    (rpt_table4column class is reused by other sections, so not by class).
    const tables = Array.prototype.slice.call(doc.querySelectorAll("table"));
    let piTable = null;
    for (const t of tables) {
        const rws = Array.prototype.slice.call(t.querySelectorAll("tr"));
        let hasCurrent = false, hasPrevious = false;
        for (const r of rws) {
            const cells = cellsOf(r);
            const label = normLabel(cells[0] ? cells[0].textContent : "");
            if (label === "current address(es):") hasCurrent = true;
            if (label === "previous address(es):") hasPrevious = true;
        }
        if (hasCurrent && hasPrevious) {
            if (piTable) return { ok: false, stage: "locate_table", reason: "More than one Personal Information table matched." };
            piTable = t;
        }
    }
    if (!piTable) return { ok: false, stage: "locate_table", reason: "Personal Information table not found." };

    const rows = Array.prototype.slice.call(piTable.querySelectorAll("tr"));

    // 2. map the three bureau columns by HEADER TEXT (order-independent)
    let headerCells = null;
    for (const r of rows) {
        const texts = cellsOf(r).map((c) => normLabel(c.textContent));
        if (texts.indexOf("transunion") >= 0 && texts.indexOf("experian") >= 0 && texts.indexOf("equifax") >= 0) {
            headerCells = cellsOf(r);
            break;
        }
    }
    if (!headerCells) return { ok: false, stage: "map_columns", reason: "Bureau header row (TransUnion/Experian/Equifax) not found." };

    const colOf = {};
    headerCells.forEach((c, i) => {
        const t = normLabel(c.textContent);
        if (t in BUREAUS) colOf[BUREAUS[t]] = i;
    });
    if (Object.keys(colOf).length < 3) {
        return { ok: false, stage: "map_columns", reason: "Could not resolve all three bureau columns by header." };
    }

    // 3/4. extract addresses per bureau column; separate the MM/YYYY date beneath
    //      as METADATA (kept in raw, excluded from value).
    const extractCell = (cell) => {
        if (!cell) return [];
        const only = normLabel(cell.textContent);
        if (only === "-" || only === "") return [];
        const out = [];
        const blocks = Array.prototype.filter.call(
            cell.children, (c) => c.tagName === "NG-REPEAT" || c.tagName === "DIV"
        );
        const blockList = blocks.length ? blocks : [cell];
        for (const block of blockList) {
            const wrapper =
                block.tagName === "DIV"
                    ? block
                    : Array.prototype.find.call(block.children, (c) => c.tagName === "DIV") || block;
            const childDivs = Array.prototype.filter.call(wrapper.children, (c) => c.tagName === "DIV");
            const dateDiv = childDivs.length ? childDivs[childDivs.length - 1] : null;
            const dateText = dateDiv ? normLabel(dateDiv.textContent) : "";
            const dateMeta = dateText && isDateOnly(dateText) ? dateDiv.textContent.trim() : null;

            let valueSource;
            const include = Array.prototype.find.call(wrapper.children, (c) => c.tagName === "NG-INCLUDE");
            if (include) {
                valueSource = include.textContent;
            } else {
                let full = wrapper.textContent || "";
                if (dateMeta) full = full.split(dateMeta).join(" ");
                valueSource = full;
            }
            let value = (valueSource || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
            value = value.replace(/\s*\d{1,2}\/\d{2,4}\s*$/, "").trim();
            if (!value) continue;
            out.push({ value, raw: value + (dateMeta ? "  [" + dateMeta + "]" : ""), date: dateMeta });
        }
        return out;
    };

    const wanted = ["current address(es):", "previous address(es):"];
    const labelRow = {};
    for (const r of rows) {
        const label = normLabel(cellsOf(r)[0] ? cellsOf(r)[0].textContent : "");
        if (wanted.indexOf(label) >= 0) labelRow[label] = r;
    }
    if (!labelRow[wanted[0]] || !labelRow[wanted[1]]) {
        return { ok: false, stage: "label_rows", reason: "Current/Previous address label rows not found." };
    }

    const collected = [];
    for (const label of wanted) {
        const cells = cellsOf(labelRow[label]);
        for (const bureau of Object.keys(colOf)) {
            for (const a of extractCell(cells[colOf[bureau]])) {
                collected.push({ value: a.value, bureau, raw: a.raw });
            }
        }
    }

    // 5. combine identical normalized addresses across bureaus
    const byNorm = {};
    const order = [];
    for (const item of collected) {
        const key = normalizeForCompare(item.value);
        if (!byNorm[key]) {
            byNorm[key] = { value: item.value, bureaus: [], raw: item.raw };
            order.push(key);
        }
        if (byNorm[key].bureaus.indexOf(item.bureau) < 0) byNorm[key].bureaus.push(item.bureau);
    }

    // 6. canonical output
    const addresses = order.map((k) => ({
        value: byNorm[k].value,
        bureaus: byNorm[k].bureaus.slice().sort(),
        raw: byNorm[k].raw,
    }));
    return { ok: true, addresses };
}

// The parse core serialized as source, so page.evaluate can reconstitute the
// SAME function inside the browser. Keeping ONE source of truth avoids drift
// between the tested Node path and the deployed browser path.
const PARSE_CORE_SOURCE = parsePiTableCore.toString();
