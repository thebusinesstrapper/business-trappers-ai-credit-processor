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

    console.log("Waiting for dashboard...");

    // Wait until we leave the login page.
    await page.waitForURL(
        url => !url.toString().includes("/login"),
        {
            timeout: 60000
        }
    );

    console.log("Dashboard loaded.");

    // Give the dashboard a few seconds to finish rendering.
    await page.waitForTimeout(3000);

    console.log("Clicking Clients tab...");

    // Click the visible Clients menu.
    await page.locator("text=Clients").first().click();

    // Give CRC time to navigate.
    await page.waitForTimeout(5000);

    console.log("Current URL:", page.url());

    return {
        page,
        currentUrl: page.url(),
        pageTitle: await page.title()
    };

}
