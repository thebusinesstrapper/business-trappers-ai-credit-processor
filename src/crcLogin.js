export async function loginToCRC(page) {

    console.log("Opening Credit Repair Cloud...");

    await page.goto(
        "https://app.creditrepaircloud.com/app/login",
        {
            waitUntil: "networkidle",
            timeout: 60000
        }
    );

    await page.fill(
        'input[type="email"]',
        process.env.CRC_USERNAME
    );

    await page.fill(
        'input[type="password"]',
        process.env.CRC_PASSWORD
    );

    await page.click('button[type="submit"]');

    await page.waitForLoadState("networkidle");

    console.log("Logged into CRC.");

    // ---------- NEW ----------
    // Go directly to the Clients page.
    // This is our only new milestone.
    await page.goto(
        "https://app.creditrepaircloud.com/app/clients",
        {
            waitUntil: "networkidle",
            timeout: 60000
        }
    );

    console.log("Clients page opened.");

   console.log("Current URL:", page.url());

return {
    page,
    currentUrl: page.url(),
    pageTitle: await page.title()
};
