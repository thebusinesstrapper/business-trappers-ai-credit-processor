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

    return page;

}
