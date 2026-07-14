/**
 * openCreditHero.test.js
 * Run: node src/openCreditHero.test.js
 *
 * ===========================================================================
 * THE BUG THE RETRY WOULD HAVE HIDDEN.
 *
 * openCreditHero() never returned `ok`. It returned { page, openedInNewTab, ... }
 * on success and THREW on failure. But milestone6 checked:
 *
 *     if (!creditHero.ok) -> return CREDIT_HERO_UNAVAILABLE
 *
 * `creditHero.ok` was undefined. `!undefined` is true. So CREDIT_HERO_UNAVAILABLE
 * was reported on runs where CreditHero opened perfectly.
 *
 * A GENUINE failure would have thrown, and surfaced as MILESTONE_6_ERROR — never
 * as CREDIT_HERO_UNAVAILABLE. Which means that error could ONLY come from the
 * false check.
 *
 * Had the retry gone in first, it would have clicked three times, succeeded three
 * times, and still returned CREDIT_HERO_UNAVAILABLE — and we would have concluded
 * CreditHero was deeply unreliable while the replay showed it opening cleanly on
 * every attempt.
 *
 * A retry on top of a broken success-check does not fix flakiness. It manufactures
 * the appearance of it.
 * ===========================================================================
 */

import { readFileSync } from "fs";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(62)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

const raw = readFileSync(new URL("./openCreditHero.js", import.meta.url), "utf-8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const m6 = readFileSync(new URL("./milestone6.js", import.meta.url), "utf-8");

console.log("\n=== THE CONTRACT ===\n");

// Both branches must be explicit. A caller cannot distinguish success from failure
// by the absence of a field.
check("returns ok: true on success", /ok: true,\s*\/\/ <- THE CONTRACT/.test(raw), true);
check("returns ok: false on exhaustion", /ok: false,\s*\n\s*error_code: "CREDIT_HERO_UNAVAILABLE"/.test(raw), true);
check("...and names the error code itself", /error_code: "CREDIT_HERO_UNAVAILABLE"/.test(code), true);
check("milestone6 checks creditHero.ok", /if \(!creditHero\.ok\)/.test(m6), true);

console.log("\n=== BOUNDED RETRY: THREE ATTEMPTS ===\n");

check("maximum of three attempts", /MAX_OPEN_ATTEMPTS = 3/.test(code), true);
check("loops attempt 1..MAX", /for \(let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt\+\+\)/.test(code), true);
check("returns CREDIT_HERO_UNAVAILABLE after exhaustion", /after \$\{MAX_OPEN_ATTEMPTS\} attempts/.test(raw), true);
check("...and requires human review", /requiresHumanReview: true/.test(code), true);

console.log("\n--- Each attempt performs all six steps ---");

check("1. verifies the dashboard is active", /the client dashboard does not appear to be active/.test(raw), true);
check("2. re-locates the link", /const link = getCreditHeroLink\(page\);/.test(code), true);
check("3. waits until visible", /waitFor\(\{ state: "visible", timeout: CONTROL_TIMEOUT \}\)/.test(code), true);
check("4. waits until enabled", /\.isEnabled\(\{ timeout: CONTROL_TIMEOUT \}\)/.test(code), true);
check("5. clicks", /await clickAndFollow\(page, context\)/.test(code), true);
check("6. verifies CreditHero actually opened", /waitForLoadState\("load"/.test(code), true);

console.log("\n--- No stale locators between attempts ---");

// A locator captured on attempt 1 may point at a detached node by attempt 2. We
// would then click a dead reference three times and conclude CreditHero was down.
check("the link is re-queried inside attemptOpen", /async function attemptOpen[\s\S]{0,2000}getCreditHeroLink\(page\)/.test(code), true);
check("no locator is hoisted out of the retry loop", /const link = getCreditHeroLink\(page\);\s*\n\s*for \(let attempt/.test(code), false);

console.log("\n--- The silent no-op is caught ---");

// Visible is not clickable. CRC renders the control before wiring it up, and a
// click on a not-yet-enabled control is SWALLOWED — no error, no navigation.
// That silent no-op is exactly what an intermittent failure looks like.
check("detects a click that did not navigate", /The click did not navigate — still on CRC/.test(raw), true);
check("...by checking we are no longer on CRC", /app\\\.creditrepaircloud\\\.com/.test(raw), true);

console.log("\n=== THE RETRY AUTHORITY DOES NOT GENERALISE ===\n");

// Retrying is safe HERE because opening CreditHero is READ-ONLY AND IDEMPOTENT.
// Clicking twice costs the client nothing. The boundary is the idempotence of the
// action — not the convenience of the caller.
check("no retry on Save", /\.click\(\)[\s\S]{0,50}save/i.test(code), false);
check("no order/purchase action anywhere", /mcc_order_select|productBuyNew|purchase|checkout/i.test(code), false);
check("no write API in this module", /\.fill\s*\(|\.selectOption\s*\(|\.check\s*\(/.test(code), false);

// The Report Acquisition Authority §5: a run that submits and then crashes leaves
// no record, and the "safe" retry spends a second entitlement.
check("the boundary is documented as idempotence", /READ-ONLY AND IDEMPOTENT/.test(raw), true);
check("...and explicitly excludes writes", /must never be extended to Save[\s\S]{0,80}Order Report[\s\S]{0,40}any write/.test(raw), true);

console.log("\n=== A FAILURE MUST BE DIAGNOSABLE ===\n");

// Three identical retries producing one identical error tell us nothing about
// whether the control was missing, invisible, disabled, or swallowing the click.
check("records why EACH attempt failed", /attempts\.push\(\{ attempt, reason: result\.reason \}\)/.test(code), true);
check("returns the attempt log", /attemptLog: attempts/.test(code), true);
check("milestone6 surfaces the attempt log", /attemptLog: creditHero\.attemptLog/.test(m6), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
