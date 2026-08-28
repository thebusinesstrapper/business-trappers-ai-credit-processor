/**
 * openClient.js
 *
 * Responsible ONLY for:
 *   1. Searching the Clients table for a given client name.
 *   2. Opening the matching client's dashboard.
 *
 * Auth/navigation-to-Clients-page stays in crcLogin.js.
 */

import { getCrcClientId } from "./crcClientId.js";
import { searchTermsFor, selectClientRow } from "./clientSearchName.js";

const SEARCH_TIMEOUT = 20000;
const ROW_TIMEOUT = 15000;
const DASHBOARD_TIMEOUT = 30000;
// How long to wait for the client-name click to actually navigate to the client
// dashboard URL, BEFORE the (longer) dashboard-content readiness wait. A click
// that resolves to a non-navigating element leaves the page on /app/clients;
// this bounds that case to a fast, clearly-attributed failure instead of a
// misleading 30s CreditHero-readiness timeout.
const NAVIGATION_TIMEOUT = 15000;
// The client dashboard URL reached after opening a row: /app/clients/<id>/dashboard.
// Same "/clients/<numeric-id>" convention as crcClientId.js, plus the required
// "/dashboard" segment.
const CLIENT_DASHBOARD_URL_PATTERN = /\/clients\/\d+\/dashboard(?:[/?#]|$)/;

/**
 * Locate the "Table Search" input using a few fallback strategies,
 * since exact markup can vary by CRC theme/version.
 */
async function getTableSearchInput(page) {
    const candidates = [
        page.getByPlaceholder("Table Search"),
        page.getByPlaceholder(/table search/i),
        page.getByLabel(/table search/i),
        page.locator('input[placeholder*="Table Search" i]'),
    ];

    for (const candidate of candidates) {
        if (await candidate.count()) {
            return candidate.first();
        }
    }

    throw new Error('Could not locate the "Table Search" input on the Clients page.');
}

/**
 * The CRC Clients grid is a MUI DataGrid, which renders rows as
 * <div role="row"> — NOT as <tr> inside a <table>. Matching only on
 * "table tr" finds zero elements, which is why a correctly-filtered,
 * clearly-visible row still came back as "client not found".
 *
 * Covering both shapes keeps this working if CRC ever swaps the grid
 * back to a real table.
 */
const ROW_SELECTOR = '[role="row"]:visible, table tr:visible';

/**
 * Resolve the clickable blue client-name NAVIGATION link inside an already-matched
 * row. Returns ONLY an element positively identified as this client's name link.
 *
 * IMPORTANT: we deliberately do NOT lead with getByRole("link"). An <a> only
 * carries the ARIA "link" role when it has an href. CRC renders the client
 * name as an href-less <a> that navigates via a JS onClick handler — it looks
 * and behaves like a link, but has no role, so a role-based query alone can
 * return zero matches. The tag-based `a:visible` + hasText lookup finds it;
 * because hasText matches the element's whole subtree, a name split across child
 * <span>s inside the real anchor still matches.
 *
 * We do NOT fall back to "any visible anchor" or "the name text node": both can
 * resolve to a non-navigating element (an unrelated action/avatar anchor, or
 * plain text with no click handler), producing a click that succeeds while the
 * page never leaves /app/clients. If no positively-identified client-name link
 * exists, this returns null and the caller fails closed — it never guesses.
 *
 * Never returns the row container: the row has no click handler, so clicking it
 * is a silent no-op.
 */
/**
 * The ORDERED client-name-link candidate list — the single source of truth for
 * which elements count as a positively-identified, navigable client-name link.
 * Both findClientNameLink() (production click target) and the read-only
 * inspectClientNameResolution() diagnostic iterate THIS list, so the diagnostic
 * can never drift from production selection.
 *
 * Each entry is { strategy, locator } where locator is already `.first()`.
 * Order is significant: findClientNameLink returns the first with count > 0.
 */
function clientNameLinkCandidates(row, clientName) {
    return [
        // 1. A visible anchor in this row whose own subtree text is the client's
        //    name. Tag-based, so CRC's href-less <a> still matches; hasText tests
        //    the element's whole subtree, so a name split across child <span>s
        //    INSIDE the real anchor still matches here.
        { strategy: "a_visible_hasText", locator: row.locator("a:visible", { hasText: clientName }).first() },

        // 2. Role-based, kept last: only matches if CRC does supply an href, and
        //    is still bound to the client's name.
        { strategy: "role_link_name", locator: row.getByRole("link", { name: clientName, exact: false }).first() },
    ];
}

async function findClientNameLink(row, clientName) {
    // ONLY positively-identified CLIENT-NAME navigation links are valid click
    // targets. A production failure (CRC 74) showed that falling back to "any
    // visible anchor" or "the name text node" resolves to a non-navigating
    // element — an unrelated action/avatar anchor, or plain text with no click
    // handler — so the click succeeds but the page never leaves /app/clients.
    // Both are removed. We keep only candidates whose match is tied to THIS
    // client's name (see clientNameLinkCandidates):
    for (const { locator } of clientNameLinkCandidates(row, clientName)) {
        if (await locator.count()) {
            return locator;
        }
    }

    // No positively-identified client-name link. Return null and let the caller
    // fail closed through the existing client-open path — never click a bare
    // anchor or text node that may not navigate.
    return null;
}

/**
 * Wait for the grid to filter down to a VISIBLE row containing clientName
 * (or determine that no rows match). Matches on the row's full text content
 * rather than requiring an exact-name link, so this tolerates extra
 * whitespace, middle names/initials, badges, icons, etc. inside the row.
 * Avoids arbitrary sleeps by polling for the actual expected end-state.
 *
 * Returns the clickable client-name element, or null if no visible matching
 * row exists.
 */
async function waitForFilteredRow(page, clientName) {
    // CRC Table Search filters on every column, including Team Members. Do not
    // choose the first row whose whole text contains the search term. Reuse the
    // client-name-aware collector so only rows whose ACTUAL Client Name link
    // matches the requested client are eligible for the ordinary path too.
    const { rows, locators } = await collectFilteredRows(page, clientName);
    if (!rows.length) return null;

    const selection = selectClientRow(rows, { fullName: clientName });
    if (!selection.matched) {
        if (selection.ambiguous) {
            console.error(
                `Client-name search for "${clientName}" remained ambiguous across ` +
                `${selection.candidates} actual Client Name matches; refusing to guess.`
            );
        }
        return null;
    }

    return locators[selection.row.index] ?? null;
}

/**
 * After the grid has filtered on a search term, collect the visible matching
 * rows as lightweight { clientName, crcClientId, index } records so the caller
 * can verify identity (via clientSearchName.selectClientRow) BEFORE opening
 * anything. crcClientId is left null here: the authoritative id is only read
 * from the dashboard URL after a row is opened, so row-level id is not relied
 * upon for the id-based check unless CRC exposes it. Reads only — no clicks.
 *
 * Returns { rows, locators } where locators[i] is the clickable name element for
 * rows[i], or null if that row has no clickable name element.
 */
async function collectFilteredRows(page, term) {
    const rowLocator = page.locator(ROW_SELECTOR, { hasText: term });

    try {
        await rowLocator.first().waitFor({ state: "visible", timeout: ROW_TIMEOUT });
    } catch {
        return { rows: [], locators: [] };
    }

    const count = await rowLocator.count();
    const rows = [];
    const locators = [];

    for (let i = 0; i < count; i += 1) {
        const rowEl = rowLocator.nth(i);
        if (!(await rowEl.isVisible().catch(() => false))) continue;

        // POSITIVE DASHBOARD-LINK IDENTIFICATION. CRC renders the client name in
        // MULTIPLE places per row — the real client-name hyperlink
        // (href="/app/clients/<id>/dashboard") AND, for other clients, an
        // Assigned Team column that shows this person's name with an onclick and
        // NO href. Matching "first anchor containing the name" can select the
        // Assigned-Team anchor of an unrelated client's row, which does not
        // navigate. So we identify the row by its DASHBOARD link specifically and
        // read the CRC id straight from that href — the authoritative signal that
        // selectClientRow can match against knownCrcClientId.
        const dashboardLink = rowEl.locator('a[href*="/clients/"][href*="/dashboard"]:visible').first();
        let hrefId = null;
        let clickTarget = null;
        if (await dashboardLink.count()) {
            const href = (await dashboardLink.getAttribute("href").catch(() => null)) || "";
            const m = href.match(/\/clients\/(\d+)\/dashboard/);
            if (m) {
                hrefId = m[1];
                clickTarget = dashboardLink; // the element that actually navigates
            }
        }

        // Fallback name element (used only when the row exposes no dashboard link
        // — e.g. an older DOM). Verify on the clickable NAME element's own text,
        // not the whole row (which also carries status badges, icons, etc.).
        const nameLink = clickTarget ?? (await findClientNameLink(rowEl, term));
        let displayedName = null;
        if (nameLink) {
            displayedName = (await nameLink.textContent().catch(() => "")) || "";
            displayedName = displayedName.replace(/\s+/g, " ").trim() || null;
        }

        // CRC Table Search matches the ENTIRE row. A team member/account owner can
        // therefore make unrelated client rows appear just because their name is
        // present in Team Members. Only admit rows whose actual client-name link
        // matches the search term. Prefix matching preserves the existing
        // suffix-free search fallback; selectClientRow still performs the final,
        // fail-closed full-name/CRC-id identity verification afterward.
        const normalizeName = (value) =>
            typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : "";
        const actualClientName = normalizeName(displayedName);
        const requestedClientName = normalizeName(term);
        const clientNameMatchesSearch =
            actualClientName === requestedClientName ||
            actualClientName.startsWith(requestedClientName + " ");
        if (!displayedName || !requestedClientName || !clientNameMatchesSearch) {
            continue;
        }

        rows.push({
            clientName: displayedName,
            crcClientId: hrefId, // from the dashboard href — enables id-authoritative selection
            index: locators.length,
        });
        locators.push(nameLink);
    }

    return { rows, locators };
}

const DASHBOARD_READY_LABEL = "View CreditHeroScore Account";

// Tolerates "CreditHeroScore" / "Credit Hero Score" spacing variants.
const DASHBOARD_READY_PATTERN = /view\s*credit\s*hero\s*score\s*account/i;

/**
 * The "View CreditHeroScore Account" link only renders on an open client
 * dashboard, which makes it a reliable "dashboard is ready" signal — far more
 * so than the URL (dynamic per client), a load event, or networkidle (CRC
 * keeps background requests alive indefinitely).
 *
 * Resolved as a UNION rather than a probe-and-fall-through: at call time the
 * dashboard is still rendering, so every branch would report zero matches.
 * .or() waits until whichever branch the real DOM uses becomes available.
 *
 *   1. Role-based — correct if CRC gives the anchor an href.
 *   2. Tag-based  — CRC renders href-less anchors elsewhere in this app, and
 *                   an <a> without an href carries NO "link" role, so the
 *                   role query above would silently never match it.
 *   3. Exact text — covers the label being a styled <div>/<span>, not an <a>.
 */
function getCreditHeroScoreLink(page) {
    return page
        .getByRole("link", { name: DASHBOARD_READY_PATTERN })
        .or(page.locator("a", { hasText: DASHBOARD_READY_PATTERN }))
        .or(page.getByText(DASHBOARD_READY_LABEL, { exact: true }))
        .first();
}

/**
 * Wait until the client dashboard is actually ready, not just navigated.
 * The visible "View CreditHeroScore Account" link is the authoritative
 * signal. The link is NOT clicked here — that belongs to Milestone 3.
 */
async function waitForDashboardLoad(page) {
    await getCreditHeroScoreLink(page).waitFor({
        state: "visible",
        timeout: DASHBOARD_TIMEOUT,
    });

    console.log(`Dashboard ready signal visible: "${DASHBOARD_READY_LABEL}"`);
}

/**
 * Read the client's name as displayed on the dashboard itself,
 * so the caller can confirm the correct client actually opened.
 */
async function readDashboardClientName(page, fallbackName) {
    const candidates = [
        page.locator('[class*="client-name" i]').first(),
        page.locator('[class*="clientname" i]').first(),
        page.getByRole("heading", { level: 1 }).first(),
    ];

    for (const candidate of candidates) {
        try {
            if (await candidate.count()) {
                const text = (await candidate.textContent())?.trim();
                if (text) return text;
            }
        } catch {
            // try next candidate
        }
    }

    return fallbackName;
}

/**
 * Read the client's current Client Status as displayed on the dashboard.
 * Selectors are best-guesses and may need adjusting to match the real
 * CRC dashboard markup.
 */
async function readDashboardClientStatus(page) {
    const candidates = [
        page.locator('[class*="client-status" i]').first(),
        page.locator('[class*="clientstatus" i]').first(),
        page.locator('[data-testid*="status" i]').first(),
        page.locator('[class*="status-badge" i]').first(),
    ];

    for (const candidate of candidates) {
        try {
            if (await candidate.count()) {
                const text = (await candidate.textContent())?.trim();
                if (text) return text;
            }
        } catch {
            // try next candidate
        }
    }

    return null;
}

/**
 * Take a screenshot and log page state on failure, to make debugging
 * "client not found" / "failed to open" cases much faster.
 */
async function captureFailureContext(page, label) {
    const path = `/tmp/openClient-failure-${label}-${Date.now()}.png`;

    try {
        await page.screenshot({ path, fullPage: true });
        console.error(`Failure screenshot saved: ${path}`);
    } catch (screenshotError) {
        console.error("Could not capture failure screenshot:", screenshotError.message);
    }

    console.error("Failure context — current URL:", page.url());
    console.error(
        "Failure context — page title:",
        await page.title().catch(() => "(unable to read title)")
    );

    return path;
}

/**
 * Search for and open a client's dashboard from the Clients page.
 *
 * @param {import('playwright').Page} page
 * @param {string} clientName
 * @returns {Promise<{
 *   clientFound: boolean,
 *   clientOpened: boolean,
 *   crcClientId: string | null,
 *   currentUrl: string,
 *   pageTitle: string,
 *   clientName: string | null,
 *   clientStatus: string | null
 * }>}
 */
export async function openClient(page, clientName, knownCrcClientId = null) {
    // Existing clients already have an authoritative CRC client ID in Supabase.
    // Do not make those clients depend on CRC's broad Table Search, which matches
    // Team Members and other columns as well as Client Name. Navigate directly to
    // the known dashboard, then verify the resulting URL/ID before continuing.
    // No authoritative CRC id was supplied, so use the guarded name-search path.
    if (knownIdProvided) {
        const knownId = String(knownCrcClientId).trim();
        const directUrl = new URL(`/app/clients/${knownId}/dashboard`, page.url()).toString();
        console.log(`Known CRC id ${knownId} supplied. Opening client dashboard directly by id.`);

        try {
            await page.goto(directUrl, { waitUntil: "domcontentloaded", timeout: DASHBOARD_TIMEOUT });
            await page.waitForURL(
                new RegExp(`/clients/${knownId}/dashboard(?:[/?#]|$)`),
                { timeout: NAVIGATION_TIMEOUT }
            );
            console.log(`Waiting for client dashboard to finish loading ("${DASHBOARD_READY_LABEL}")...`);
            await waitForDashboardLoad(page);

            const actualId = getCrcClientId(page);
            if (String(actualId ?? "") !== knownId) {
                throw new Error(
                    `Direct CRC-id navigation expected client ${knownId} but resolved ${actualId ?? "none"}.`
                );
            }

            const dashboardClientName = await readDashboardClientName(page, clientName);
            const dashboardClientStatus = await readDashboardClientStatus(page);

            console.log(`Client dashboard loaded directly by known id: ${page.url()}`);
            console.log(`Derived crc_client_id: ${actualId}`);

            return {
                clientFound: true,
                clientOpened: true,
                crcClientId: actualId,
                currentUrl: page.url(),
                clientStatus: dashboardClientStatus,
                pageTitle: await page.title(),
                clientName: dashboardClientName,
            };
        } catch (error) {
            console.error(`Failed direct CRC-id client open for ${knownId}: ${error.message}`);
            await captureFailureContext(page, "known-id-client-open-failed");
            throw error;
        }
    }

    let searchInput;

    try {
        console.log(`Locating Table Search input...`);
        searchInput = await getTableSearchInput(page);
    } catch (error) {
        console.error(`Failed to locate Table Search input: ${error.message}`);
        await captureFailureContext(page, "search-input-not-found");
        throw error;
    }

    console.log(`Typing client name into Table Search: "${clientName}"`);
    // SEARCH ORDER: the full authoritative name first, then — ONLY if the name
    // ends in a recognized personal suffix (Jr/Sr/II/III/IV/V) and the full
    // search found nothing — the suffix-free base name. CRC's Clients search does
    // not reliably return a suffixed client, so the base name is the fallback.
    // The full name remains authoritative for every downstream identity check;
    // the base name is a transient search string only.
    const searchTerms = searchTermsFor(clientName);

    let clientNameLink = null;
    let usedFallbackSearch = false;
    let usedKnownIdSelection = false;

    // 1. Full-name search.
    await searchInput.click();
    await searchInput.fill(searchTerms[0]);
    console.log(`Waiting for the table to filter on "${searchTerms[0]}"...`);

    // 1a. KNOWN-ID PATH (authoritative). When the caller already knows the CRC id
    //     (e.g. an existing client_state row), the full-name search can return
    //     MANY rows because the name also appears in other clients' Assigned Team
    //     column. "First visible anchor containing the name" then selects a
    //     non-navigating Assigned-Team anchor of the wrong row. So when a known id
    //     is supplied we reuse the SAME id-verified selection the suffix fallback
    //     uses (collectFilteredRows + selectClientRow) against the full-name
    //     results, selecting the row whose dashboard href is /clients/<knownId>/…
    //     This is not a second matching system — it is the existing one, applied
    //     to the primary search. Ordinary clients (no known id) keep the original
    //     first-match behavior below unchanged.
    const knownIdProvided =
        knownCrcClientId != null && /^\d+$/.test(String(knownCrcClientId).trim());

    if (knownIdProvided) {
        const { rows, locators } = await collectFilteredRows(page, searchTerms[0]);
        const selection = selectClientRow(rows, {
            fullName: clientName,
            knownCrcClientId,
        });

        if (selection.matched) {
            clientNameLink = locators[selection.row.index] ?? null;
            usedKnownIdSelection = true;
        } else if (selection.ambiguous) {
            console.log(
                `Full-name search for "${searchTerms[0]}" returned ${selection.candidates} plausible ` +
                `clients and none uniquely matched CRC id ${knownCrcClientId}. ` +
                `Failing closed to manual review (ambiguous_client_match).`
            );
            await captureFailureContext(page, "ambiguous-client-match");
            return {
                clientFound: false,
                clientOpened: false,
                blockedReason: "ambiguous_client_match",
                ambiguous: true,
                candidates: selection.candidates,
            };
        }
        // selection.matched === false && !ambiguous -> fall through to the normal
        // first-match path below (e.g. the known id was not present in this
        // filtered set), preserving existing behavior rather than failing.
    }

    // 1b. Ordinary first-match path — unchanged behavior for clients with no
    //     known id (and the no-unique-match fall-through above).
    if (!clientNameLink) {
        clientNameLink = await waitForFilteredRow(page, searchTerms[0]);
    }

    // 2. Suffix-free fallback — only when the full search missed AND a distinct
    //    base name exists. Verify the returned rows and fail closed if more than
    //    one plausible client remains.
    if (!clientNameLink && searchTerms.length > 1) {
        const baseTerm = searchTerms[1];
        usedFallbackSearch = true;
        console.log(
            `No exact row for "${clientName}". Retrying CRC search without suffix: "${baseTerm}".`
        );

        await searchInput.click();
        await searchInput.fill(baseTerm);
        console.log(`Waiting for the table to filter on "${baseTerm}"...`);

        const { rows, locators } = await collectFilteredRows(page, baseTerm);

        // Verify by known CRC id (if provided), then exact full name, then exact
        // base name. Multiple plausible rows fail closed to Manual Review.
        const selection = selectClientRow(rows, {
            fullName: clientName,
            knownCrcClientId,
        });

        if (selection.matched) {
            clientNameLink = locators[selection.row.index] ?? null;
        } else if (selection.ambiguous) {
            console.log(
                `Suffix-free search for "${baseTerm}" returned ${selection.candidates} plausible ` +
                `clients. Failing closed to manual review (ambiguous_client_match).`
            );
            await captureFailureContext(page, "ambiguous-client-match");
            return {
                clientFound: false,
                clientOpened: false,
                blockedReason: "ambiguous_client_match",
                crcClientId: null,
                currentUrl: page.url(),
                pageTitle: await page.title(),
                clientName: null,
                clientStatus: null,
            };
        }
    }

    if (!clientNameLink) {
        console.log(`No matching client found for "${clientName}".`);
        await captureFailureContext(page, "client-not-found");
        return {
            clientFound: false,
            clientOpened: false,
            crcClientId: null,
            currentUrl: page.url(),
            pageTitle: await page.title(),
            clientName: null,
            clientStatus: null,
        };
    }

    console.log(
        `Match found${usedKnownIdSelection ? " (via known-CRC-id selection)" : usedFallbackSearch ? " (via suffix-free fallback)" : ""}. ` +
        `Opening client: "${clientName}"`
    );

    let dashboardClientName;
    let dashboardClientStatus;

    try {
        // Click the client's blue name hyperlink, not the row container.
        await clientNameLink.click();

        // ---- POST-CLICK NAVIGATION VERIFICATION --------------------------
        // The click is only meaningful if it actually navigated to the client
        // dashboard. A click that resolves to a non-navigating element (which
        // findClientNameLink now refuses to return, but we verify regardless)
        // would otherwise leave the page on /app/clients and surface 30s later
        // as a misleading "View CreditHeroScore Account" timeout inside
        // waitForDashboardLoad. Verify the URL FIRST and fail closed here, with
        // a message that clearly attributes the failure to client navigation —
        // NOT to CreditHero. Do not continue to dashboard readiness, profile,
        // identity, or CreditHero processing when navigation did not occur.
        try {
            await page.waitForURL(CLIENT_DASHBOARD_URL_PATTERN, { timeout: NAVIGATION_TIMEOUT });
        } catch {
            throw new Error(
                `Clicked the client-name link for "${clientName}" but the client dashboard did not ` +
                `open — the page is still at ${page.url()} (expected /app/clients/<id>/dashboard). ` +
                `This is a client-navigation failure, not a CreditHero problem.`
            );
        }

        console.log(`Waiting for client dashboard to finish loading ("${DASHBOARD_READY_LABEL}")...`);
        await waitForDashboardLoad(page);

        dashboardClientName = await readDashboardClientName(page, clientName);
        dashboardClientStatus = await readDashboardClientStatus(page);
    } catch (error) {
        console.error(`Failed to open client dashboard: ${error.message}`);
        await captureFailureContext(page, "client-open-failed");
        throw error;
    }

    console.log("Client dashboard loaded:", page.url());
    console.log("Client Status:", dashboardClientStatus ?? "(not found)");

    // The dashboard is now open, so the URL is authoritative for this client.
    // This is the ONLY place the CRC Client ID can be derived. It is read here
    // and passed on — never re-derived later from a page that may have
    // navigated elsewhere.
    const crcClientId = getCrcClientId(page);

    return {
        clientFound: true,
        clientOpened: true,
        crcClientId,
        currentUrl: page.url(),
        clientStatus: dashboardClientStatus,
        pageTitle: await page.title(),
        clientName: dashboardClientName,
    };
}

/**
 * =========================================================================
 * READ-ONLY DIAGNOSTIC — client-name link resolution inspector.
 *
 * Reports what findClientNameLink() WOULD resolve to for a filtered client row,
 * WITHOUT clicking, navigating, or writing anything. It reuses this module's
 * own getTableSearchInput(), ROW_SELECTOR, clientNameLinkCandidates(), and
 * CLIENT_DASHBOARD_URL_PATTERN, so it mirrors production selection exactly with
 * no duplicated logic.
 *
 * Value-free: returns only structural metadata (tag names, roles, booleans,
 * counts, lengths, and hrefs) — never the client's name text, address, or any
 * report content. The only page interaction is filling the list search box (a
 * client-side filter), identical to what openClient already does; it performs
 * NO click, NO client navigation, NO CRC write, NO Supabase write.
 *
 * Assumes the caller has already logged in and is on /app/clients.
 * =========================================================================
 *
 * @param {import('playwright').Page} page
 * @param {string} clientName  used only to fill the search box + hasText match
 * @returns {Promise<object>} sanitized resolution metadata
 */
export async function inspectClientNameResolution(page, clientName) {
    const report = {
        pageUrlPath: safeUrlPath(page.url()),
        rowMatched: false,
        rowCount: 0,
        rowVisibleTextLength: null,
        candidates: [],
        wouldResolveStrategy: null,
        selected: null,
        otherRowLinks: [],
    };

    // Filter the grid exactly as openClient does (search box fill only).
    const searchInput = await getTableSearchInput(page);
    await searchInput.click();
    await searchInput.fill(clientName);

    const row = page.locator(ROW_SELECTOR, { hasText: clientName }).first();
    try {
        await row.waitFor({ state: "visible", timeout: ROW_TIMEOUT });
    } catch {
        return report; // no matching visible row
    }

    report.rowMatched = true;
    report.rowCount = await page.locator(ROW_SELECTOR, { hasText: clientName }).count();
    // Length only — never the text value itself.
    report.rowVisibleTextLength = ((await row.innerText().catch(() => "")) || "").length;

    // Per-candidate resolution, using the SAME builder production uses.
    const candidates = clientNameLinkCandidates(row, clientName);
    let resolved = null;
    for (const { strategy, locator } of candidates) {
        const count = await locator.count().catch(() => 0);
        const entry = { strategy, count, resolved: null };
        if (count > 0) {
            entry.resolved = await describeElementReadOnly(locator);
            if (!resolved) {
                resolved = { strategy, locator, describe: entry.resolved };
                report.wouldResolveStrategy = strategy; // first match wins, mirrors findClientNameLink
            }
        }
        report.candidates.push(entry);
    }

    if (resolved) {
        const href = resolved.describe.href;
        report.selected = {
            strategy: resolved.strategy,
            ...resolved.describe,
            hrefClassification: classifyHref(href),
        };
    }

    // Read-only survey of EVERY visible anchor in the row (no click): does any
    // OTHER element clearly point to this row's /clients/<id>/dashboard? Reports
    // only structural metadata + href, never the name text.
    const anchorLocator = row.locator("a:visible");
    const anchorCount = await anchorLocator.count().catch(() => 0);
    for (let i = 0; i < anchorCount; i++) {
        const a = anchorLocator.nth(i);
        const desc = await describeElementReadOnly(a);
        report.otherRowLinks.push({
            tag: desc.tag,
            role: desc.role,
            hasHref: desc.hasHref,
            href: desc.href,
            visibleTextLength: desc.visibleTextLength,
            pointsToADashboard: typeof desc.href === "string" && CLIENT_DASHBOARD_URL_PATTERN.test(desc.href),
        });
    }

    return report;
}

/** Structural, value-free description of a single element (no click). */
async function describeElementReadOnly(locator) {
    return locator.evaluate((el) => {
        const dataKeys = [];
        for (const attr of el.attributes || []) {
            if (attr.name.startsWith("data-")) dataKeys.push(attr.name);
        }
        const rawHref = el.getAttribute ? el.getAttribute("href") : null;
        const onclickAttr = el.getAttribute ? el.getAttribute("onclick") : null;
        const outer = (el.outerHTML || "");
        return {
            tag: (el.tagName || "").toLowerCase(),
            role: el.getAttribute ? el.getAttribute("role") : null,
            hasHref: rawHref != null && rawHref !== "",
            href: rawHref,                                   // structural (URL), not consumer data
            hasOnclick: onclickAttr != null || typeof el.onclick === "function",
            target: el.getAttribute ? el.getAttribute("target") : null,
            className: el.className || null,
            dataAttributeKeys: dataKeys,                      // keys only, not values
            isInsideAnchor: !!(el.closest && el.closest("a") && el.closest("a") !== el),
            closestAnchorHasHref: !!(el.closest && el.closest("a") && el.closest("a").getAttribute("href")),
            visibleTextLength: ((el.innerText || el.textContent || "").trim()).length, // length only
            // Truncated, tag-only skeleton of outerHTML (attributes kept, but the
            // element's text nodes are the client name so we cap length hard).
            outerHtmlTruncated: outer.length > 300 ? outer.slice(0, 300) + "…" : outer,
        };
    }).catch(() => ({
        tag: null, role: null, hasHref: false, href: null, hasOnclick: false, target: null,
        className: null, dataAttributeKeys: [], isInsideAnchor: false, closestAnchorHasHref: false,
        visibleTextLength: null, outerHtmlTruncated: null,
    }));
}

/** Classify an href into a navigation category (no consumer data). */
function classifyHref(href) {
    if (href == null || href === "") return "empty_or_missing";
    const h = String(href).trim();
    if (/^javascript:/i.test(h)) return "javascript";
    if (/^#/.test(h)) return "hash_only";
    if (CLIENT_DASHBOARD_URL_PATTERN.test(h)) return "client_dashboard";
    if (/\/clients\/\d+(?:[/?#]|$)/.test(h)) return "client_url_non_dashboard";
    if (/\/(profile|admin|owner|account|settings|users?)\b/i.test(h)) return "profile_admin_owner";
    return "other";
}

/** Host + path only from a URL (never query/hash which could carry data). */
function safeUrlPath(url) {
    try {
        const u = new URL(url);
        return `${u.host}${u.pathname}`;
    } catch {
        return null;
    }
}
