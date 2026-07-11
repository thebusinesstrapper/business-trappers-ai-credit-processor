export async function loginToCRC(page) {

    console.log("Opening Credit Repair Cloud...");

    await page.goto(
        "https://app.creditrepaircloud.com/app/login",
        {
            waitUntil: "domcontentloaded",
            timeout: 60000
        }
    );

    const usernameField = page.getByPlaceholder("Email or User ID");
    const passwordField = page.getByPlaceholder("Password");

    await usernameField.waitFor({
        state: "visible",
        timeout: 60000
    });

    await usernameField.fill(process.env.CRC_USERNAME);

    await passwordField.fill(process.env.CRC_PASSWORD);

    await page.getByRole("button", { name: "Login" }).click();

    console.log("Login submitted.");

    await page.waitForLoadState("networkidle");

    console.log("Logged into CRC.");

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

}
