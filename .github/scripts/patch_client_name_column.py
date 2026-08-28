from pathlib import Path

p = Path('src/openClient.js')
s = p.read_text()

old = '''async function waitForFilteredRow(page, clientName) {
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
'''

new = '''async function waitForFilteredRow(page, clientName) {
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
'''

if 'client-name-aware collector' in s:
    raise SystemExit('ordinary fallback patch already present')

count = s.count(old)
if count != 1:
    raise SystemExit(f'guard failed: expected exactly one waitForFilteredRow block, found {count}')

p.write_text(s.replace(old, new, 1))
print('guarded ordinary client-name fallback patch applied')
