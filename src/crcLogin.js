export async function loginToCRC(page) {

    console.log("Opening Credit Repair Cloud...");

    await page.goto(
        "https://app.creditrepaircloud.com/app/login",
        {
            waitUntil: "domcontentloaded",
            timeout: 60000
        }
    );

    const usernameField = page
        .getByPlaceholder(/email|user id/i)
        .first();

    const passwordField = page
        .getByPlaceholder(/password/i)
        .first();

    await usernameField.waitFor({
        state: "visible",
        timeout: 60000
    });

    await usernameField.fill(process.env.CRC_USERNAME);

    await passwordField.fill(process.env.CRC_PASSWORD);

    await page
        .getByRole("button", { name: /login/i })
        .click();

    await page.waitForTimeout(5000);

    console.log("Login submitted.");

    await page.goto(
        "https://app.creditrepaircloud.com/app/clients",
        {
            waitUntil: "domcontentloaded",
            timeout: 60000
        }
    );

    console.log("Current URL:", page.url());

    return {
        page,
        currentUrl: page.url(),
        pageTitle: await page.title()
    };
}
