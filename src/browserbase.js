import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const bb = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY,
});

export async function launchBrowser() {
  console.log("Creating Browserbase session...");

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID,
  });

  console.log("Session created:", session.id);

  const browser = await chromium.connectOverCDP(
    session.connectUrl
  );

  const context = browser.contexts()[0];

  const page =
    context.pages()[0] ||
    (await context.newPage());

  return {
    browser,
    context,
    page,
    session,
  };
}
