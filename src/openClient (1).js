/**
 * openClient.js
 *
 * Responsible ONLY for:
 *   1. Searching the Clients table for a given client name.
 *   2. Opening the matching client's dashboard.
 *
 * Auth/navigation-to-Clients-page stays in crcLogin.js.
 */

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
 * Wait for the table to filter down to a row containing clientName
 * (or determine that no rows match). Matches on the row's full text
 * content rather than requiring an exact-name link, so this tolerates
 * extra whitespace, middle names/initials, badges, icons, etc. inside
 * the row. Avoids arbitrary sleeps by polling for the actual expected
 * end-state instead.
 *
 * Returns the clickable element to open the client (preferring a link
 * whose own text contains the name, then any link in the row, then the
 * row itself as a last resort), or null if no row matches.
 */
async function waitForFilteredRow(page, clientName) {
    const row = page.locator("table tr", { hasText: clientName }).first();

    try {
        await row.waitFor({ state: "visible", timeout: ROW_TIMEOUT });
    } catch {
        return null;
    }

    // Prefer clicking directly on the client's name, per spec.
    const nameLink = row.getByRole("link", { name: clientName, exact: false }).first();
    if (await nameLink.count()) {
        return nameLink;
    }

    // Fall back to the first link in the matching row.
    const anyLink = row.getByRole("link").first();
    if (await anyLink.count()) {
        return anyLink;
    }

    // Last resort: click the row itself.
    return row;
}

/**
 * Wait until the client dashboard has actually finished loading,
 * not just navigated. We wait for the URL to move away from the
 * clients list AND for the network to settle.
 */
async function waitForDashboardLoad(page, previousUrl) {
    await page.waitForURL((url) => url.toString() !== previousUrl, {
        timeout: DASHBOARD_TIMEOUT,
    });

    await page
        .waitForLoadState("networkidle", { timeout: DASHBOARD_TIMEOUT })
        .catch(() => {
            // Some CRC dashboards keep background polling alive indefinitely,
            // which prevents "networkidle" from ever firing. Fall back to
            // "load" so we don't fail the whole flow over that.
        });

    await page.waitForLoadState("load", { timeout: DASHBOARD_TIMEOUT }).catch(() => {});
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
    const matchingRow = await waitForFilteredRow(page, clientName);

    if (!matchingRow) {
        console.log(`No matching client found for "${clientName}".`);
        await captureFailureContext(page, "client-not-found");
        return {
            clientFound: false,
            clientOpened: false,
            currentUrl: page.url(),
            pageTitle: await page.title(),
            clientName: null,
            clientStatus: null,
        };
    }

    console.log(`Match found. Opening client: "${clientName}"`);
    const clientsPageUrl = page.url();

    let dashboardClientName;
    let dashboardClientStatus;

    try {
        await matchingRow.click();

        console.log("Waiting for client dashboard to finish loading...");
        await waitForDashboardLoad(page, clientsPageUrl);

        dashboardClientName = await readDashboardClientName(page, clientName);
        dashboardClientStatus = await readDashboardClientStatus(page);
    } catch (error) {
        console.error(`Failed to open client dashboard: ${error.message}`);
        await captureFailureContext(page, "client-open-failed");
        throw error;
    }

    console.log("Client dashboard loaded:", page.url());
    console.log("Client Status:", dashboardClientStatus ?? "(not found)");

    return {
        clientFound: true,
        clientOpened: true,
        currentUrl: page.url(),
        clientStatus: dashboardClientStatus,
        pageTitle: await page.title(),
        clientName: dashboardClientName,
    };
}
