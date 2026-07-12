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

const SEARCH_TIMEOUT = 20000;
const ROW_TIMEOUT = 15000;
const DASHBOARD_TIMEOUT = 30000;

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
 * Resolve the clickable blue client-name element inside an already-matched row.
 *
 * IMPORTANT: we deliberately do NOT lead with getByRole("link"). An <a> only
 * carries the ARIA "link" role when it has an href. CRC renders the client
 * name as an href-less <a>/<span> that navigates via a JS onClick handler —
 * it looks and behaves like a link, but has no role, so every role-based
 * query returns zero matches. Tag- and text-based lookups find it; role-based
 * ones silently do not.
 *
 * Returns the name element, or null. Never returns the row container: the row
 * has no click handler, so clicking it is a silent no-op.
 */
async function findClientNameLink(row, clientName) {
    const candidates = [
        // 1. A visible anchor in this row whose own text is the client's name.
        //    Tag-based, so href-less anchors still match.
        row.locator("a:visible", { hasText: clientName }).first(),

        // 2. Any visible anchor in the row (name may be wrapped in a child
        //    <span>, which can break the hasText match above).
        row.locator("a:visible").first(),

        // 3. The name may be a styled clickable <div>/<span> rather than an <a>.
        //    Click the name text element itself — still not the row container.
        row.getByText(clientName, { exact: false }).first(),

        // 4. Role-based, kept last: only matches if CRC does supply an href.
        row.getByRole("link", { name: clientName, exact: false }).first(),
    ];

    for (const candidate of candidates) {
        if (await candidate.count()) {
            return candidate;
        }
    }

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
    const row = page.locator(ROW_SELECTOR, { hasText: clientName }).first();

    try {
        await row.waitFor({ state: "visible", timeout: ROW_TIMEOUT });
    } catch {
        return null;
    }

    const nameLink = await findClientNameLink(row, clientName);

    if (!nameLink) {
        console.error(
            `Matched a row for "${clientName}" but found no clickable client-name element inside it.`
        );
    }

    return nameLink;
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
export async function openClient(page, clientName) {
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
    await searchInput.click();
    await searchInput.fill(clientName);

    console.log("Waiting for the table to filter...");
    const clientNameLink = await waitForFilteredRow(page, clientName);

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

    console.log(`Match found. Opening client: "${clientName}"`);

    let dashboardClientName;
    let dashboardClientStatus;

    try {
        // Click the client's blue name hyperlink, not the row container.
        await clientNameLink.click();

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
