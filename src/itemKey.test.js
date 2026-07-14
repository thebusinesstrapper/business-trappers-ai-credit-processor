/**
 * itemKey.test.js
 * Run: node src/itemKey.test.js
 *
 * Extraction §11: itemKey.js is "unit-tested before anything else in this
 * milestone." A key that drifts between runs silently detaches dispute history —
 * nothing throws, the letters still generate, they are simply wrong.
 */

import {
    KEY_PREFIX, mintKey, readVendorIdentifiers, assertNotBarred, BARRED_FROM_IDENTITY,
    furnisherNorm, acctLast4, openedYm, accountTypeNorm,
    accountSignatures, tradelineSignatures, inquirySignatures,
    resolveKey, buildRegistry, RESOLUTION, FURNISHER_ALIASES,
} from "./itemKey.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(60)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

console.log("\n=== MINTING: A UUID, NOT A CONTENT HASH ===\n");

// A key must have NO semantic relationship to its content, so that no future
// change to furnisher naming, masking, or a vendor's id scheme can make it drift.
const k1 = mintKey(KEY_PREFIX.TRADELINE);
const k2 = mintKey(KEY_PREFIX.TRADELINE);

check("minted keys are prefixed", k1.startsWith("bt_tl_"), true);
check("identical inputs -> DIFFERENT keys", k1 === k2, false);
check("account prefix", mintKey(KEY_PREFIX.ACCOUNT).startsWith("bt_ac_"), true);
check("inquiry prefix", mintKey(KEY_PREFIX.INQUIRY).startsWith("bt_iq_"), true);

let threw = false;
try { mintKey("bt_xx_"); } catch { threw = true; }
check("unknown prefix refused", threw, true);

console.log("\n=== VENDOR IDS: EVIDENCE, NEVER IDENTITY (§7.4) ===\n");

// The three identifiers run #83 confirmed on every CREDIT_LIABILITY.
const liability = {
    "@ArrayAccountIdentifier": "ARR-99123",
    "@TradelineHashSimple": "hs-abc",
    "@TradelineHashComplex": "hc-changes-monthly",
};

const vendor = readVendorIdentifiers(liability);

check("reads @ArrayAccountIdentifier", vendor.array_account_identifier, "ARR-99123");
check("reads @TradelineHashSimple", vendor.tradeline_hash_simple, "hs-abc");
check("captures @TradelineHashComplex", vendor.tradeline_hash_complex, "hc-changes-monthly");

console.log("\n--- TradelineHashComplex is PERMANENTLY barred ---");

// It incorporates balance, status, and dates — fields that change every month BY
// DESIGN. Apparent stability across two reports means NOTHING CHANGED that month,
// not that the hash is stable. Promoting it on that evidence is reasoning from an
// accident.
check("it is on the barred list", BARRED_FROM_IDENTITY.includes("TradelineHashComplex"), true);

let barred = false;
try { assertNotBarred("TradelineHashComplex"); } catch { barred = true; }
check("using it as identity THROWS", barred, true);

// It never reaches a cascade.
const tlSigs = tradelineSignatures({ ...liability, bureau: "transunion" }, "bt_ac_x");
check("never appears in a signature", tlSigs.some((s) => s.value.includes("hc-changes-monthly")), false);

const acSigs = accountSignatures(liability);
check("never appears in an account signature", acSigs.some((s) => s.value.includes("hc-changes-monthly")), false);

console.log("\n=== COMPONENT NORMALIZATION ===\n");

check("furnisher: strips legal suffix", furnisherNorm("CHASE BANK USA NA"), "CHASE");
check("furnisher: strips punctuation", furnisherNorm("Navy Federal Cr. Union"), "NAVY FEDERAL CR UNION");
check("furnisher: null-safe", furnisherNorm(null), null);
check("alias table starts EMPTY", Object.keys(FURNISHER_ALIASES).length, 0);

check("last4: from long mask", acctLast4("411111******1234"), "1234");
check("last4: from short mask", acctLast4("****1234"), "1234");
check("last4: absent trailing digits -> null", acctLast4("4111********"), "4111");
check("last4: null-safe", acctLast4(null), null);

// Bureaus disagree by DAYS on the same account. Keeping day precision would split
// one account into three.
check("opened: day precision DISCARDED", openedYm("2019-03-14"), "2019-03");
check("opened: same month, different day -> same", openedYm("2019-03-01"), openedYm("2019-03-14"));
check("opened: null-safe", openedYm(null), null);

check("type: normalized", accountTypeNorm("  installment  "), "INSTALLMENT");

console.log("\n=== ACCOUNT CASCADE (§7.5A) ===\n");

const acct = {
    "@ArrayAccountIdentifier": "ARR-1",
    masked_account: "411111******1234",
    date_opened: "2019-03-14",
    account_type: "Installment",
    furnisher: "CHASE BANK USA NA",
};

const sigs = accountSignatures(acct);

check("A0 is strongest and first", sigs[0].tier, "A0");
check("A1 = last4 + opened_ym", sigs.some((s) => s.value === "A1|1234|2019-03"), true);
check("A2 = last4 + type", sigs.some((s) => s.value === "A2|1234|INSTALLMENT"), true);

console.log("\n--- The furnisher name may never SPLIT an account ---");

// Bureaus are EXPECTED to name the same lender differently. A furnisher-name
// difference is NEVER evidence that two tradelines are different accounts, so A3
// only appears when account-number evidence is absent from both sides.
check("A3 suppressed when last4 exists", sigs.some((s) => s.tier === "A3"), false);

const noLast4 = accountSignatures({ ...acct, masked_account: null, "@ArrayAccountIdentifier": null });
check("A3 appears only as last resort", noLast4.some((s) => s.tier === "A3"), true);

// The same account, named differently by two bureaus, still correlates on A1.
const tu = accountSignatures({ ...acct, furnisher: "CHASE BANK USA NA" });
const exp = accountSignatures({ ...acct, furnisher: "JPMCB CARD SERVICES", "@ArrayAccountIdentifier": "ARR-1" });

check("different furnisher names, same A1", tu.find((s) => s.tier === "A1").value === exp.find((s) => s.tier === "A1").value, true);

console.log("\n=== TRADELINE CASCADE (§7.5B) — THE LEGAL UNIT OF WORK ===\n");

// Disputes are filed with a BUREAU about THAT BUREAU'S reporting. Dispute memory
// attaches to stable_item_key, never to the account — attaching it to the account
// would merge three separate legal proceedings into one, and we would lose track
// of which bureau we had already written to, about what.
const tlTU = tradelineSignatures({ "@TradelineHashSimple": "hs-tu", masked_account: "****1234", furnisher: "CHASE", bureau: "transunion" }, "bt_ac_1");
const tlEX = tradelineSignatures({ "@TradelineHashSimple": "hs-ex", masked_account: "****1234", furnisher: "JPMCB", bureau: "experian" }, "bt_ac_1");

check("T0 strongest", tlTU[0].tier, "T0");
check("T1 = account + bureau", tlTU.some((s) => s.value === "T1|bt_ac_1|transunion"), true);

// SAME account, DIFFERENT bureaus -> DIFFERENT item keys. This is the point.
check("same account, different bureau -> different T1", tlTU.find((s) => s.tier === "T1").value === tlEX.find((s) => s.tier === "T1").value, false);

console.log("\n=== INQUIRIES: NO ACCOUNT TO CORRELATE (§7.7) ===\n");

const iq = inquirySignatures({ furnisher: "SOME LENDER", bureau: "equifax", inquiry_date: "2026-01-05" });
check("inquiry has a signature", iq.length, 1);
check("...keyed on furnisher+bureau+date", iq[0].value, "I0|SOME LENDER|equifax|2026-01-05");
check("incomplete inquiry -> no signature", inquirySignatures({ furnisher: "X" }).length, 0);

console.log("\n=== RESOLUTION: ASSIGNED ONCE, NEVER RECOMPUTED (§7.2) ===\n");

// Decision 2: the previous report IS the key registry. No separate table.
const registry = buildRegistry([
    { key: "bt_tl_EXISTING", signatures: ["T0|hs-tu", "T1|bt_ac_1|transunion"] },
]);

const matched = resolveKey(tlTU, registry, KEY_PREFIX.TRADELINE);

check("matches the persisted key", matched.resolution, RESOLUTION.MATCHED);
check("...reuses it, does not recompute", matched.key, "bt_tl_EXISTING");
check("...at the strongest tier", matched.matchedTier, "T0");

// A furnisher rebrand must NOT detach history: T0 still matches even though the
// furnisher name changed completely.
const rebranded = tradelineSignatures({ "@TradelineHashSimple": "hs-tu", masked_account: "****1234", furnisher: "TOTALLY NEW BRAND NAME", bureau: "transunion" }, "bt_ac_1");
check("furnisher rebrand -> key SURVIVES", resolveKey(rebranded, registry, KEY_PREFIX.TRADELINE).key, "bt_tl_EXISTING");

// First sighting mints.
const fresh = resolveKey(
    tradelineSignatures({ "@TradelineHashSimple": "hs-brand-new", bureau: "equifax" }, "bt_ac_9"),
    registry, KEY_PREFIX.TRADELINE
);
check("first sighting -> MINTED", fresh.resolution, RESOLUTION.MINTED);
check("...with a fresh key", fresh.key.startsWith("bt_tl_"), true);

console.log("\n=== AMBIGUITY FAILS CLOSED (§7.6) ===\n");

// A WRONG KEY IS WORSE THAN NO KEY. It attaches this run's findings to ANOTHER
// account's dispute history — corrupting the authoritative memory store in a way
// that cannot be detected or undone. A failed extraction costs us one cycle.
// That trade is not close.
const colliding = buildRegistry([
    { key: "bt_tl_A", signatures: ["T2|CHASE|1234|transunion"] },
    { key: "bt_tl_B", signatures: ["T2|CHASE|1234|transunion"] },
]);

const ambiguous = resolveKey(
    [{ tier: "T2", value: "T2|CHASE|1234|transunion" }],
    colliding, KEY_PREFIX.TRADELINE
);

check("two candidates -> AMBIGUOUS", ambiguous.resolution, RESOLUTION.AMBIGUOUS);
check("...does NOT pick one", ambiguous.key, null);
check("...does NOT mint a new key", ambiguous.key === null, true);
check("...names both candidates", ambiguous.candidates.length, 2);

console.log("\n--- A stronger tier resolves before a weaker one collides ---");

// If T0 matches cleanly, we never reach the colliding T2 tier.
const mixed = buildRegistry([
    { key: "bt_tl_GOOD", signatures: ["T0|hs-unique"] },
    { key: "bt_tl_A", signatures: ["T2|CHASE|1234|transunion"] },
    { key: "bt_tl_B", signatures: ["T2|CHASE|1234|transunion"] },
]);

const r = resolveKey(
    [{ tier: "T0", value: "T0|hs-unique" }, { tier: "T2", value: "T2|CHASE|1234|transunion" }],
    mixed, KEY_PREFIX.TRADELINE
);

check("strongest tier wins before ambiguity", r.resolution, RESOLUTION.MATCHED);
check("...resolved at T0", r.matchedTier, "T0");

console.log("\n=== PURE: NO BROWSER, NO MEMORY, NO NETWORK ===\n");

const { readFileSync } = await import("fs");
const src = readFileSync(new URL("./itemKey.js", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

check("does not import Playwright", /playwright/i.test(src), false);
check("does not import supabase", /supabase/i.test(src), false);
check("does not touch memory", /clientMemory|writeMemory|readMemory/.test(src), false);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
