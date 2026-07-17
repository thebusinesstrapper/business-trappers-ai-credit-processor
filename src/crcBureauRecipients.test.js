/**
 * crcBureauRecipients.test.js
 *
 * Verifies the discrete CRC recipient fields, bureau-name normalization, and the
 * fail-closed behavior for unsupported bureaus and malformed records.
 */
import {
    crcRecipientFor,
    normalizeBureau,
    supportedCrcBureaus,
    isValidState,
    isValidZip,
} from "./crcBureauRecipients.js";

let passed = 0, failed = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) console.log(`FAIL  ${label.padEnd(52)} got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
    ok ? passed++ : failed++;
};

console.log("\n=== ALL THREE SUPPORTED BUREAUS RESOLVE ===\n");

const exp = crcRecipientFor("experian");
check("experian ok", exp.ok, true);
check("experian company", exp.recipient.companyName, "Experian Information Solutions, Inc.");
check("experian address", exp.recipient.address, "P.O. Box 4500");
check("experian address2 empty", exp.recipient.address2, "");
check("experian city", exp.recipient.city, "Allen");
check("experian state", exp.recipient.state, "TX");
check("experian zip", exp.recipient.zip, "75013");

const tu = crcRecipientFor("transunion");
check("transunion ok", tu.ok, true);
check("transunion company", tu.recipient.companyName, "TransUnion LLC");
check("transunion address", tu.recipient.address, "P.O. Box 2000");
check("transunion address2", tu.recipient.address2, "Consumer Dispute Center");
check("transunion city", tu.recipient.city, "Chester");
check("transunion state", tu.recipient.state, "PA");
check("transunion zip", tu.recipient.zip, "19016-2000");

const eq = crcRecipientFor("equifax");
check("equifax ok", eq.ok, true);
check("equifax company", eq.recipient.companyName, "Equifax Information Services LLC");
check("equifax address", eq.recipient.address, "P.O. Box 740256");
check("equifax address2 empty", eq.recipient.address2, "");
check("equifax city", eq.recipient.city, "Atlanta");
check("equifax state", eq.recipient.state, "GA");
check("equifax zip", eq.recipient.zip, "30374-0256");

check("exactly three supported bureaus", supportedCrcBureaus().length, 3);

console.log("\n=== TRANSUNION TWO-LINE ADDRESS PRESERVED SEPARATELY ===\n");
check("transunion keeps both address lines separate (not combined)",
    tu.recipient.address !== "" && tu.recipient.address2 !== "" &&
    !tu.recipient.address.includes("Consumer Dispute Center"), true);
check("transunion address is the P.O. Box line", tu.recipient.address, "P.O. Box 2000");
check("transunion address2 is the routing line", tu.recipient.address2, "Consumer Dispute Center");

console.log("\n=== BUREAU NAME NORMALIZATION ===\n");
check("Experian (title)", normalizeBureau("Experian"), "experian");
check("EXPERIAN (upper)", normalizeBureau("EXPERIAN"), "experian");
check("TransUnion", normalizeBureau("TransUnion"), "transunion");
check("'trans union' (space)", normalizeBureau("trans union"), "transunion");
check("'Trans-Union' (hyphen)", normalizeBureau("Trans-Union"), "transunion");
check("' equifax ' (padded)", normalizeBureau(" equifax "), "equifax");
check("resolve works through normalization", crcRecipientFor("TRANS UNION").recipient.city, "Chester");

console.log("\n=== UNSUPPORTED BUREAUS FAIL CLOSED ===\n");
check("innovis unsupported", normalizeBureau("innovis"), null);
check("empty string unsupported", normalizeBureau(""), null);
check("null unsupported", normalizeBureau(null), null);
check("number unsupported", normalizeBureau(42), null);
const bad = crcRecipientFor("innovis");
check("crcRecipientFor(innovis) not ok", bad.ok, false);
check("crcRecipientFor(innovis) has error", typeof bad.error === "string" && bad.error.length > 0, true);
check("crcRecipientFor(innovis) has no recipient", "recipient" in bad, false);
check("crcRecipientFor(null) not ok", crcRecipientFor(null).ok, false);

console.log("\n=== STATE + ZIP VALIDATION ===\n");
check("TX valid state", isValidState("TX"), true);
check("PA valid state", isValidState("PA"), true);
check("GA valid state", isValidState("GA"), true);
check("DC valid state", isValidState("DC"), true);
check("XX invalid state", isValidState("XX"), false);
check("lowercase 'tx' invalid (must be abbrev)", isValidState("tx"), false);
check("'Texas' invalid (must be abbrev)", isValidState("Texas"), false);

check("5-digit zip valid", isValidZip("75013"), true);
check("ZIP+4 valid", isValidZip("19016-2000"), true);
check("4-digit zip invalid", isValidZip("7501"), false);
check("non-numeric zip invalid", isValidZip("ABCDE"), false);
check("zip with space invalid", isValidZip("75013 "), false);

console.log("\n=== MALFORMED RECORD GUARD (defensive) ===\n");
// Every stored record must pass its own validation — this catches a future
// typo in the map before it can ship a malformed CRC form value.
for (const b of supportedCrcBureaus()) {
    const r = crcRecipientFor(b);
    check(`${b} record is internally valid`, r.ok, true);
    check(`${b} state passes validation`, isValidState(r.recipient.state), true);
    check(`${b} zip passes validation`, isValidZip(r.recipient.zip), true);
}

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
