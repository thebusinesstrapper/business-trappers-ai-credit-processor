from pathlib import Path

p = Path('src/openClient.js')
s = p.read_text()

needle = '''        rows.push({
            clientName: displayedName,
            crcClientId: hrefId, // from the dashboard href — enables id-authoritative selection
            index: locators.length,
        });
        locators.push(nameLink);
'''

replacement = '''        // CRC Table Search matches the ENTIRE row. A team member/account owner can
        // therefore make unrelated client rows appear just because their name is
        // present in Team Members. Only admit rows whose actual client-name link
        // matches the search term. Prefix matching preserves the existing
        // suffix-free search fallback; selectClientRow still performs the final,
        // fail-closed full-name/CRC-id identity verification afterward.
        const normalizeName = (value) =>
            typeof value === "string" ? value.replace(/\\s+/g, " ").trim().toLowerCase() : "";
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
'''

if 'CRC Table Search matches the ENTIRE row' in s:
    raise SystemExit('patch already present')

count = s.count(needle)
if count != 1:
    raise SystemExit(f'guard failed: expected exactly one candidate push block, found {count}')

p.write_text(s.replace(needle, replacement, 1))
print('guarded client-name candidate patch applied')
