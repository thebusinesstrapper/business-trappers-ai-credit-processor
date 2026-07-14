/**
 * crcProfile.test.js
 * Run: node src/crcProfile.test.js
 *
 * ===========================================================================
 * THESE TESTS ASSERT ARCHITECTURE, NOT BEHAVIOUR.
 *
 * The Business Trappers ruling: "Changing any field other than Status is a
 * processor failure."
 *
 * A code review can confirm that today. It cannot confirm it after the next
 * refactor. So the separation is enforced by a test that reads the source: the
 * READER must contain NO write capability AT ALL — not a disabled one, not a
 * guarded one. None.
 *
 * A reader that merely CHOOSES not to write is one careless edit away from
 * writing to a client's record.
 * ===========================================================================
 */

import { readFileSync } from "fs";
import { PROTECTED_FIELDS, WRITABLE_FIELDS } from "./crcClientStatus.js";
import { FIELD_LABELS, REQUIRED_FIELDS } from "./crcClientProfile.js";
import { verifyIdentity, IDENTITY_SOURCE } from "./intelligence/clientIdentity.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(62)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

/** Source with comments stripped, so a comment ABOUT writing isn't read as writing. */
function codeOf(path) {
    return readFileSync(new URL(path, import.meta.url), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
        .replace(/^\s*\/\/.*$/gm, "");      // line comments
}

const readerCode = codeOf("./crcClientProfile.js");
const writerCode = codeOf("./crcClientStatus.js");
const runnerCode = codeOf("./milestoneProfile.js");

console.log("\n=== THE READER HAS NO WRITE PATH — STRUCTURALLY ===\n");

const WRITE_APIS = [
    [".fill(", /\.fill\s*\(/],
    [".selectOption(", /\.selectOption\s*\(/],
    [".check(", /\.check\s*\(/],
    [".uncheck(", /\.uncheck\s*\(/],
    [".setInputFiles(", /\.setInputFiles\s*\(/],
    [".type(", /\.type\s*\(/],
    [".press(", /\.press\s*\(/],
];

for (const [name, pattern] of WRITE_APIS) {
    check(`reader contains no ${name}`, pattern.test(readerCode), false);
}

check("reader never clicks Save", /save/i.test(readerCode), false);
check("reader declares fieldsModified: 0", /fieldsModified:\s*0/.test(readerCode), true);

console.log("\n--- The read-only ROUTE cannot reach the writer ---");

// The runner imports only the reader. The status writer is not reachable from
// the /read-client-profile endpoint, so that route is structurally incapable of
// modifying a client record — not merely disinclined to.
check("runner does NOT import crcClientStatus", /crcClientStatus/.test(runnerCode), false);
check("runner imports the reader", /crcClientProfile/.test(runnerCode), true);
check("reader does NOT import the writer", /crcClientStatus/.test(readerCode), false);

console.log("\n=== THE WRITER MAY TOUCH EXACTLY ONE FIELD ===\n");

check("exactly one writable field", WRITABLE_FIELDS.length, 1);
check("...and it is Status", WRITABLE_FIELDS[0], "status");

console.log("\n--- Every identity field is protected ---");

for (const field of ["firstName", "middleName", "lastName", "address_line_1", "city", "state", "postal_code", "email", "phone"]) {
    check(`${field} is protected`, PROTECTED_FIELDS.includes(field), true);
}

check("no identity field is writable", PROTECTED_FIELDS.some((f) => WRITABLE_FIELDS.includes(f)), false);

console.log("\n--- The writer snapshots, then verifies what it did NOT change ---");

// A form that silently reformats a ZIP on save would corrupt the address on a
// legal document and throw no error. The only way to catch it is to compare
// before and after.
check("writer snapshots BEFORE writing", /PRE_WRITE_SNAPSHOT_FAILED/.test(writerCode), true);
check("writer re-reads AFTER writing", /POST_WRITE_VERIFICATION_FAILED/.test(writerCode), true);
check("writer reports PROTECTED_FIELD_MODIFIED", /PROTECTED_FIELD_MODIFIED/.test(writerCode), true);
check("writer refuses without cycle completion", /WRITE_NOT_AUTHORIZED/.test(writerCode), true);
check("writer refuses if it cannot find Status", /STATUS_FIELD_NOT_FOUND/.test(writerCode), true);

console.log("\n=== SELECTORS ANCHOR ON LABELS, NOT GENERATED IDS ===\n");

// A brittle id selector does not fail loudly. It matches the WRONG field, reads
// a plausible value, and prints a phone number where the ZIP should be.
check("First Name", FIELD_LABELS.firstName, "First Name");
check("Middle Name", FIELD_LABELS.middleName, "Middle Name");
check("Last Name", FIELD_LABELS.lastName, "Last Name");
check("Mailing Address", FIELD_LABELS.address, "Mailing Address");
check("City", FIELD_LABELS.city, "City");
check("State", FIELD_LABELS.state, "State");
check("Zip Code", FIELD_LABELS.zip, "Zip Code");
check("Email Address", FIELD_LABELS.email, "Email Address");
check("Phone (Mobile)", FIELD_LABELS.phone, "Phone (Mobile)");

check("no generated-id selectors in the reader", /#input_|#field_\d|\[id\^=/.test(readerCode), false);

console.log("\n=== A MISSING REQUIRED FIELD STOPS LETTER GENERATION ===\n");

check("address is required", REQUIRED_FIELDS.includes("address"), true);
check("zip is required", REQUIRED_FIELDS.includes("zip"), true);
check("middleName is NOT required", REQUIRED_FIELDS.includes("middleName"), false);
check("email is NOT required for a letter", REQUIRED_FIELDS.includes("email"), false);

check("reader hard-stops on missing required fields", /REQUIRED_IDENTITY_FIELDS_MISSING/.test(readerCode), true);
check("...and refuses to substitute from elsewhere", /does not substitute a value from the credit report/i.test(readFileSync(new URL("./crcClientProfile.js", import.meta.url), "utf-8")), true);

console.log("\n=== THE PRODUCED IDENTITY PASSES THE LETTER ENGINE'S GATE ===\n");

// The real check: what the reader builds must satisfy verifyIdentity(), or the
// Letter Engine will reject it and we would only discover that at letter time.
const identity = {
    source: IDENTITY_SOURCE.CRC_CLIENT_PROFILE,
    crcClientId: "15",
    retrievedAt: "2026-07-13T00:00:00Z",
    firstName: "Elizabeth",
    middleName: "Suzanne",
    lastName: "Kelley",
    name: "Elizabeth Suzanne Kelley",
    address_line_1: "5084 Louvinia Dr",
    city: "Tallahassee",
    state: "FL",
    postal_code: "32311",
    email: "e@example.com",
    phone: "555-0100",
};

const verified = verifyIdentity(identity);

check("CRC-sourced identity VERIFIES", verified.ok, true);
check("...source is crc_client_profile", identity.source, "crc_client_profile");
check("...full name includes the middle name", identity.name, "Elizabeth Suzanne Kelley");

// The same identity, sourced from anywhere else, must be REFUSED.
const fromReport = verifyIdentity({ ...identity, source: "credit_report" });
check("same data from the CREDIT REPORT -> REFUSED", fromReport.ok, false);

const noClientId = verifyIdentity({ ...identity, crcClientId: null });
check("no CRC client id -> REFUSED", noClientId.ok, false);

const noAddress = verifyIdentity({ ...identity, address_line_1: null });
check("no address -> REFUSED", noAddress.ok, false);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
