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
import { verifyIdentity, IDENTITY_SOURCE, normalizeIdentity, canonicalState } from "./intelligence/clientIdentity.js";

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

    // NOT /\.type\s*\(/ — that matches `dialog.type()`, which READS a dialog's
    // type and writes nothing. Same false-positive class as /sue/ matching
    // "isSUE". A guardrail that fires on innocent code is one people learn to
    // override, and then it protects nothing. Exclude the known reader.
    [".type( — keyboard input", /(?<!dialog)\.type\s*\(/],

    [".press(", /\.press\s*\(/],
];

for (const [name, pattern] of WRITE_APIS) {
    check(`reader contains no ${name}`, pattern.test(readerCode), false);
}

// NOT /save/i — that matches "unSAVEd changes" in the error text. Same class of
// false positive as /sue/ matching "isSUE". A guardrail that fires on innocent
// text is one people learn to override, and then it protects nothing.
check("reader never clicks a Save button", /getByRole\(\s*"button"\s*,\s*\{\s*name:\s*\/\^?save/i.test(readerCode), false);
check("reader has no Save locator at all", /\bSave\b(?![a-z-])/.test(readerCode.replace(/unsaved/gi, "")), false);
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
// Built exactly as the reader builds it: normalized at capture.
const identity = normalizeIdentity({
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
});

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

console.log("\n=== NORMALIZATION AT CAPTURE ===\n");

// The DOM gives us whatever CRC's form holds. Those strings go on a legal
// document AND are the values we compare — so an un-normalized identity produces
// two bugs: a double space printed on a bureau letter, and a false mismatch in
// the status writer's protected-field check that looks exactly like corruption.
const messy = normalizeIdentity({
    source: IDENTITY_SOURCE.CRC_CLIENT_PROFILE,
    crcClientId: "15",
    firstName: "  Elizabeth ",
    middleName: "Suzanne",
    lastName: " Kelley  ",
    name: "  Elizabeth   Suzanne  Kelley ",
    address_line_1: "5084  Louvinia   Dr\n",
    city: " Tallahassee ",
    state: "Florida",
    postal_code: " 32311 ",
    email: "  e@example.com ",
    phone: " 555-0100 ",
});

check("collapses repeated whitespace", messy.name, "Elizabeth Suzanne Kelley");
check("trims the address", messy.address_line_1, "5084 Louvinia Dr");
check("trims the city", messy.city, "Tallahassee");
check("trims the ZIP", messy.postal_code, "32311");
check("marks itself normalized", messy.normalized, true);

console.log("\n--- State canonicalization ---");

check("Florida -> FL", canonicalState("Florida"), "FL");
check("florida -> FL", canonicalState("florida"), "FL");
check("FL -> FL", canonicalState("FL"), "FL");
check("fl -> FL", canonicalState("fl"), "FL");
check("Fla. -> FL", canonicalState("Fla."), "FL");
check("New York -> NY", canonicalState("New York"), "NY");
check("normalized identity carries FL", messy.state, "FL");

// An unrecognised state FAILS CLOSED. Guessing is how "FL" becomes "FI", and a
// letter addressed to an unparseable state does not arrive.
check("unrecognised state -> null (never a guess)", canonicalState("Flrida"), null);
check("empty state -> null", canonicalState(""), null);

console.log("\n--- Normalization is CONSERVATIVE, not cleanup ---");

// We are not the authority on her address. CRC is. We collapse whitespace and
// canonicalize the state — we do NOT rewrite what CRC holds.
const conservative = normalizeIdentity({
    source: IDENTITY_SOURCE.CRC_CLIENT_PROFILE,
    crcClientId: "15",
    name: "Elizabeth Kelley",
    address_line_1: "5084 Louvinia Dr",
    city: "Tallahassee",
    state: "FL",
    postal_code: "32311-1234",
});

check("does NOT expand 'Dr' to 'Drive'", conservative.address_line_1, "5084 Louvinia Dr");
check("does NOT reformat a ZIP+4", conservative.postal_code, "32311-1234");

console.log("\n--- Raw strings are preserved for audit, and read by nobody ---");

check("raw is retained", messy.raw.state, "Florida");
check("raw address retained verbatim", messy.raw.address_line_1, "5084  Louvinia   Dr\n");

console.log("\n=== VERIFICATION COMPARES NORMALIZED VALUES ===\n");

check("normalized identity VERIFIES", verifyIdentity(messy).ok, true);

// Raw DOM strings must never reach letter generation. We REFUSE them rather than
// normalizing on the fly — a silent fix here would mean the raw string is what
// actually flowed downstream, and the letter would still print the double space.
const unnormalized = {
    source: IDENTITY_SOURCE.CRC_CLIENT_PROFILE,
    crcClientId: "15",
    name: "Elizabeth  Kelley",
    address_line_1: "5084 Louvinia Dr ",
    city: "Tallahassee",
    state: "Florida",
    postal_code: "32311",
};

const rawResult = verifyIdentity(unnormalized);
check("un-normalized identity is REFUSED", rawResult.ok, false);
check("...flagged as not normalized", rawResult.errors.some((e) => /has not been normalized/i.test(e)), true);

const badState = verifyIdentity({ ...messy, state: "Florida" });
check("non-canonical state is REFUSED", badState.ok, false);
check("...even though everything else is fine", badState.errors.some((e) => /canonical two-letter code/i.test(e)), true);

const doubleSpace = verifyIdentity({ ...messy, address_line_1: "5084  Louvinia Dr" });
check("double space in address is REFUSED", doubleSpace.ok, false);

console.log("\n=== FROZEN NAVIGATION: EXIT VIA CANCEL ===\n");

const readerSrc = readFileSync(new URL("./crcClientProfile.js", import.meta.url), "utf-8");

check("exits via Cancel", /const CANCEL_LABEL = "Cancel"/.test(readerSrc), true);
check("...and no longer uses the X", /upper-right X|button:has-text\("×"\)/.test(readerCode), false);
check("still READ ONLY — no Save", /getByRole\(\s*"button"\s*,\s*\{\s*name:\s*\/\^?save/i.test(readerCode), false);
check("still READ ONLY — no .fill()", /\.fill\s*\(/.test(readerCode), false);
check("still READ ONLY — no .selectOption()", /\.selectOption\s*\(/.test(readerCode), false);

console.log("\n--- Cancel is found tag-agnostically, role LAST ---");

// CRC renders href-less <a> controls carrying NO ARIA role. Leading with
// getByRole is what made the X unreachable: we matched nothing, clicked nothing,
// and reported that the modal "refused to close" when we had never touched it.
check("does NOT lead with a role-based query", readerSrc.indexOf('name: "exact text (any tag)"') < readerSrc.indexOf('name: "role=button (last resort)"'), true);
check("matches an <a> or <input> Cancel", /:is\(button, a, input, span, div\):text-is/.test(readerSrc), true);

console.log("\n=== AN UNSAVED-CHANGES PROMPT IS A PROCESSOR FAILURE ===\n");

// READ MODE filled nothing. The form is clean. There is NO legitimate reason for
// Cancel to ask about unsaved changes — if it does, a field WAS modified.
check("UNSAVED_CHANGES_PROMPT is a distinct error code", /error_code: "UNSAVED_CHANGES_PROMPT"/.test(readerSrc), true);
check("...names it a PROCESSOR FAILURE", /PROCESSOR FAILURE: clicking Cancel produced a dialog/.test(readerSrc), true);
check("...routes to human review", /requiresHumanReview: true/.test(readerSrc), true);

console.log("\n--- The trap: Playwright auto-dismisses native dialogs ---");

// A browser-level confirm("unsaved changes") is dismissed SILENTLY by default.
// The modal would close, the run would continue, and we would never learn the
// processor had edited a client's record. The one failure we most need to catch
// is the one the framework hides.
check("attaches a dialog listener", /page\.on\("dialog"/.test(readerSrc), true);
check("...BEFORE clicking Cancel", readerSrc.indexOf('page.on("dialog"') < readerSrc.indexOf("Clicked Cancel via"), true);
check("...and detaches it afterwards", /page\.off\("dialog"/.test(readerSrc), true);
check("dismisses (discards) — never accepts/saves", /dialog\.dismiss\(\)/.test(readerSrc), true);
check("...and never accepts a dialog", /dialog\.accept\(\)/.test(readerSrc), false);

// CRC may render its OWN prompt rather than a native one, in which case no
// dialog event fires at all and the listener above would pass happily.
check("also detects an IN-PAGE unsaved prompt", /findUnsavedChangesPrompt/.test(readerSrc), true);

console.log("\n=== BOTH EXIT CONDITIONS ARE VERIFIED ===\n");

// "The modal is gone" and "the dashboard works" are different facts. An absence
// check alone passes on a blank page, an error screen, or an unintended nav.
check("verifies the modal is no longer visible", /error_code: "MODAL_STILL_VISIBLE"/.test(readerSrc), true);
check("verifies View/Edit Profile is visible again", /error_code: "DASHBOARD_NOT_RESTORED"/.test(readerSrc), true);
check("...a POSITIVE check, not just an absence", /PROFILE_LINK_TEXT[\s\S]{0,80}count\(\)\) > 0/.test(readerSrc), true);

console.log("\n--- Failures are distinguishable, not collapsed into one ---");

// "Nothing worked" is indistinguishable from "never ran" and from "threw" — and
// that ambiguity is what sent us hunting for an execution-path bug last time.
check("selector miss has its own code", /error_code: "CANCEL_CONTROL_NOT_FOUND"/.test(readerSrc), true);
check("reports what each candidate matched", /cancelAttempts: closed\.attempts/.test(readerSrc), true);
check("captures real markup when all miss", /modalHeaderHtml: closed\.modalHeaderHtml/.test(readerSrc), true);

check("state that will not canonicalize STOPS the run", /error_code: "STATE_NOT_CANONICAL"/.test(readerSrc), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
