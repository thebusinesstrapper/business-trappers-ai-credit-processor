// Read bureau-reported consumer addresses from the rendered Credit Hero report.
export async function captureReportedAddresses(page) {
    const deadline = Date.now() + 10_000;
    let failure;
    do {
        const frames = typeof page.frames === "function" ? page.frames() : [page];
        const matches = [];
        for (const frame of frames) {
            try {
                const result = await frame.evaluate(parsePiTableCore);
                if (result.ok) matches.push(result);
                else if (!failure || failure.stage === "locate_table" || failure.stage === "evaluate") failure = result;
            } catch (error) {
                failure ??= {
                    ok: false,
                    stage: "evaluate",
                    reason: `Reading the rendered Credit Hero report failed: ${error.message}`,
                };
            }
        }
        if (matches.length > 1) {
            return { ok: false, stage: "locate_table", reason: "Multiple report frames supplied addresses." };
        }
        if (matches.length === 1) return matches[0];
        if (typeof page.frames !== "function" || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    // READ-ONLY diagnostic for Credit Hero layout changes. Return selectors and
    // element structure only; never return consumer names, report content, or addresses.
    const structure = [];
    const frames = typeof page.frames === "function" ? page.frames() : [page];
    for (const [frameIndex, frame] of frames.entries()) {
        try {
            const snapshot = await frame.evaluate(() => {
                const count = (selector) => document.querySelectorAll(selector).length;
                const labels = [...document.querySelectorAll("body *")]
                    .filter((el) => el.children.length === 0 && /^(personal information|current address\\(es\\):?|previous address\\(es\\):?|addresses)$/i.test((el.textContent || "").replace(/\\s+/g, " ").trim()))
                    .slice(0, 12)
                    .map((el) => ({
                        tag: el.tagName,
                        parentTag: el.parentElement?.tagName ?? null,
                        parentClass: typeof el.parentElement?.className === "string"
                            ? el.parentElement.className.slice(0, 120) : "",
                    }));
                return {
                    tables: count("table"),
                    addressWrappers: count(".fields-wrapper > .address-wrapper"),
                    addressNodes: count(".address"),
                    bureauHeaders: count(".bureau-data.labels"),
                    iframes: count("iframe"),
                    matchingLabels: labels,
                };
            });
            structure.push({ frameIndex, ...snapshot });
        } catch {
            structure.push({ frameIndex, unreadable: true });
        }
    }
    const base = failure ?? { ok: false, stage: "locate_table", reason: "No report frame was available." };
    return { ...base, diagnostic: { frameCount: frames.length, structure } };
}

/**
 * PURE DOM-walking core. Extracts the Personal Information addresses from a
 * DOM `document` (or any root exposing querySelectorAll + element.children +
 * textContent). No browser globals, no external references — so it can be:
 *   (a) passed directly to page.evaluate, and
 *   (b) unit-tested in Node against a minimal DOM shim.
 *
 * @param {Document|Element} doc
 * @returns {{ok:true, addresses:Array}|{ok:false, stage:string, reason:string}}
 */
export function parsePiTableCore(doc = document) {
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

    const collected = [];
    const addressSections = doc.querySelectorAll(".fields-wrapper > .address-wrapper");
    if (addressSections.length > 0) {
        if (addressSections.length !== 1) {
            return { ok: false, stage: "locate_table", reason: "Multiple rendered address sections matched." };
        }
        const header = doc.querySelectorAll(".bureau-data.labels");
        const bureauColumns = header.length === 1
            ? [...header[0].parentElement.children].filter(column => column !== header[0])
            : [];
        const bureaus = bureauColumns.map(column => {
            const logo = column.querySelector('[role="img"][aria-label$=" logo"]');
            return normLabel(logo?.getAttribute("aria-label")).replace(/ logo$/, "");
        });
        if (bureaus.length !== 3 || new Set(bureaus).size !== 3 ||
            bureaus.some(bureau => !Object.hasOwn(BUREAUS, bureau))) {
            return { ok: false, stage: "map_columns", reason: "Rendered bureau logo columns could not be verified." };
        }

        const addressRows = [...addressSections[0].children];
        if (!addressRows.length ||
            normLabel(addressRows[0].firstElementChild?.textContent) !== "addresses") {
            return { ok: false, stage: "label_rows", reason: "Rendered Addresses row was not found." };
        }
        for (const row of addressRows) {
            const [label, ...cells] = row.children;
            if (!row.matches(".field-header-wrapper") || !label?.matches(".addresses-title") ||
                cells.length !== bureaus.length || cells.some(cell => !cell.matches(".field-value"))) {
                return { ok: false, stage: "label_rows", reason: "Rendered address row does not match bureau columns." };
            }
            for (const [index, cell] of cells.entries()) {
                const value = cell.querySelector(".address")?.textContent?.replace(/\s+/g, " ").trim();
                if (!value) {
                    if (cell.textContent.trim()) {
                        return { ok: false, stage: "label_rows", reason: "A populated bureau cell has no readable address." };
                    }
                    continue;
                }
                const date = cell.querySelector(".date")?.textContent?.trim();
                collected.push({ value, bureau: bureaus[index], raw: date ? value + "  [" + date + "]" : value });
            }
        }
    } else {
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

        for (const label of wanted) {
            const cells = cellsOf(labelRow[label]);
            for (const bureau of Object.keys(colOf)) {
                for (const a of extractCell(cells[colOf[bureau]])) {
                    collected.push({ value: a.value, bureau, raw: a.raw });
                }
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
