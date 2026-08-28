from pathlib import Path

p = Path('src/openClient.js')
s = p.read_text()

old_start = '''export async function openClient(page, clientName, knownCrcClientId = null) {
    let searchInput;
'''

new_start = '''export async function openClient(page, clientName, knownCrcClientId = null) {
    // Existing clients already have an authoritative CRC client ID in Supabase.
    // Do not make those clients depend on CRC's broad Table Search, which matches
    // Team Members and other columns as well as Client Name. Navigate directly to
    // the known dashboard, then verify the resulting URL/ID before continuing.
    const knownIdProvided =
        knownCrcClientId != null && /^\\d+$/.test(String(knownCrcClientId).trim());

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
'''

old_known = '''    const knownIdProvided =
        knownCrcClientId != null && /^\\d+$/.test(String(knownCrcClientId).trim());

    if (knownIdProvided) {
'''

new_known = '''    // No authoritative CRC id was supplied, so use the guarded name-search path.
    if (knownIdProvided) {
'''

if 'Opening client dashboard directly by id' in s:
    raise SystemExit('direct known-id patch already present')
if s.count(old_start) != 1:
    raise SystemExit(f'guard failed: expected one openClient start, found {s.count(old_start)}')
if s.count(old_known) != 1:
    raise SystemExit(f'guard failed: expected one later knownId declaration, found {s.count(old_known)}')

s = s.replace(old_start, new_start, 1)
s = s.replace(old_known, new_known, 1)
p.write_text(s)
print('guarded direct known-CRC-id navigation patch applied')
