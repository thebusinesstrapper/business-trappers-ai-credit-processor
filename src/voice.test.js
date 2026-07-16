/**
 * voice.test.js
 * Run: node src/intelligence/voice.test.js
 *
 * ===========================================================================
 * THE LIBRARIES ARE CONTENT. THESE TESTS ARE THE GUARDRAIL ON THAT CONTENT.
 *
 * Anyone may add an approved paragraph. These tests make it impossible to add
 * one that lies.
 *
 * The core rule: EVERY SENTENCE MUST BE TRUE OF EVERY CLIENT, IN EVERY ROUND,
 * ABOUT EVERY ACCOUNT IN THE LETTER. The opening speaks for the whole letter,
 * and one bureau letter carries first-round and escalated accounts together.
 * ===========================================================================
 */

import { OPENINGS, renderOpening } from "./openingLibrary.js";
import { TRANSITIONS } from "./transitionLibrary.js";
import { CLOSINGS, renderClosing } from "./closingLibrary.js";
import { selectVoice, combinationCount } from "./voice.js";
import { APPROVED_GENERAL_OPENING_TEXT } from "./openingLibrary.js";
import { APPROVED_CLOSING_TEXT } from "./closingLibrary.js";
import { resolveRecipient, supportedBureaus, BUREAUS } from "./recipientLibrary.js";
import { APPROVED_BY_BUSINESS_TRAPPERS as OPENINGS_APPROVED, APPROVAL as OPENING_APPROVAL } from "./openingLibrary.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(60)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

const allText = [
    ...OPENINGS.map((o) => ({ id: o.id, text: renderOpening(o) })),
    ...TRANSITIONS.map((t) => ({ id: t.id, text: t.text })),
    ...CLOSINGS.map((c) => ({ id: c.id, text: renderClosing(c) })),
];

/** Scan every library entry for a forbidden pattern. */
function scan(label, pattern) {
    const hits = allText.filter((e) => pattern.test(e.text));

    for (const hit of hits) {
        console.log(`      VIOLATION in ${hit.id}: "${hit.text.slice(0, 90)}..."`);
    }

    check(label, hits.length, 0);
}

console.log("\n=== FORBIDDEN: claims the processor cannot verify ===\n");

// HISTORY. False for any first-round account in a mixed letter.
scan(
    "no dispute-history claims",
    /previously disputed|prior (?:letter|dispute)|as I (?:told|wrote|informed|stated)|second (?:time|request|letter)|again|already (?:told|wrote|disputed)|last (?:letter|time)|once more|repeated(?:ly)?/i
);

// MOTIVE. We do not know why she pulled her report.
scan(
    "no motive claims",
    /applied for (?:a )?(?:mortgage|loan|credit|apartment)|when I (?:applied|tried)|in order to (?:buy|purchase|qualify)|preparing to (?:buy|apply)/i
);

// HARM. A damages claim, unproven, and it opens a lawsuit nobody authorized.
scan(
    "no damages or harm claims",
    /damaged my|cost me|denied (?:credit|a loan)|hurt my|suffered|financial (?:harm|loss)|lost (?:the|my) (?:home|opportunity)|unable to (?:obtain|get)/i
);

// THREATS. Never Rules: never threaten litigation.
scan(
    "no threats or legal action",
    // \b matters: /sue/ without it matches "isSUE", and a guardrail that cries wolf
    // is a guardrail people learn to ignore.
    /legal action|\battorney\b|\blawsuit\b|\bsue\b|\bcourt\b|litigation|report you to|file a complaint|\bCFPB\b|Attorney General/i
);

// DEADLINES stated as automatic legal consequences.
scan(
    "no self-executing deadlines",
    /within 30 days|30-day|must be (?:deleted|removed)|required by law to (?:delete|remove)|failure to respond will/i
);

// PROMISES about an investigation that has not happened.
scan(
    "no presumed outcomes",
    /look forward to (?:these|the) (?:items|accounts) being (?:removed|deleted)|expect (?:these|them) to be (?:removed|deleted)|will be (?:removed|deleted)/i
);

// EMOTION. Style Guide forbids it, and it reads as a template.
scan(
    "no emotional or accusatory language",
    /frustrat|outrage|unacceptable|disgrace|negligen|reckless|refus(?:al|ed) to|blatant|egregious/i
);

// ACCOUNT-SPECIFIC claims. The opening speaks for ALL accounts.
scan(
    "no account-specific claims",
    /fraudulent|identity theft|never (?:opened|had) (?:this|an) account|not my account|this account is/i
);

// COUNTS. The number of accounts varies per letter.
scan(
    "no hardcoded account counts",
    /\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+accounts?\b|\b\d+\s+accounts?\b/i
);

// LAW. Voice is maintained INDEPENDENTLY of legal authorities. A statute in the
// prose means a legal change would require a prose edit — and a prose edit could
// silently change a citation.
scan(
    "no statutes or legal citations in voice text",
    /FCRA|FDCPA|U\.?S\.?C|§|15 USC|1681|Section \d/i
);

// DECISION RECORDS / strategies never leak into consumer-facing prose.
scan("no internal identifiers", /BT-DM-|BT-ST-|BT-RN-|BT-IN-|BT-BP-/i);

console.log("\n=== PERMITTED: what every letter may truthfully say ===\n");

// KRIS FIRM STANDARD (2026-07-16). Every opening states the formal dispute and
// the reinvestigation demand; every closing demands the written results.
check("every opening states a formal dispute", OPENINGS.every((o) => /formally disputing/i.test(renderOpening(o))), true);
check("every opening demands a reasonable reinvestigation", OPENINGS.every((o) => /reasonable reinvestigation/i.test(renderOpening(o))), true);
check("the approved general firm opening exists", OPENINGS.some((o) => renderOpening(o).includes(APPROVED_GENERAL_OPENING_TEXT)), true);
check("every closing demands written results", CLOSINGS.every((c) => /(written results|results) of your reinvestigation/i.test(renderClosing(c)) && /in writing|written results/i.test(renderClosing(c))), true);
check("every closing demands the procedure used", CLOSINGS.every((c) => /description of the procedure/i.test(renderClosing(c))), true);
check("no opening uses soft courtesy language", OPENINGS.every((o) => !/I would appreciate|thank you|please investigate/i.test(renderOpening(o))), true);
check("no closing uses a soft thank-you", CLOSINGS.every((c) => !/thank you|I would appreciate/i.test(renderClosing(c))), true);
check("openings are KRIS_APPROVED_V1", OPENING_APPROVAL, "KRIS_APPROVED_V1");

console.log("\n=== STRUCTURE ===\n");

check("openings have at least one paragraph", OPENINGS.every((o) => o.paragraphs.length >= 1), true);
check("...but not bloated", OPENINGS.every((o) => o.paragraphs.length <= 4), true);
check("no duplicate openings", new Set(OPENINGS.map(renderOpening)).size, OPENINGS.length);
check("no duplicate transitions", new Set(TRANSITIONS.map((t) => t.text)).size, TRANSITIONS.length);
check("no duplicate closings", new Set(CLOSINGS.map(renderClosing)).size, CLOSINGS.length);
check("every entry has a stable id", allText.every((e) => !!e.id), true);

console.log("\n=== DETERMINISM ===\n");

const ctx = { crcClientId: 15, bureau: "transunion", round: 1, reportDate: "2026-07-13" };

const v1 = selectVoice(ctx);
const v2 = selectVoice(ctx);

check("same input -> identical voice", JSON.stringify(v1) === JSON.stringify(v2), true);
check("...same combination", v1.provenance.combination, v2.provenance.combination);
check("nothing is generated (invariant)", v1.provenance.generated, false);

console.log(`\n  Combination selected: ${v1.provenance.combination}`);
console.log(`  Total approved combinations: ${combinationCount()}`);

// V1 is deliberately SMALL. 10 openings x 4 transitions x 4 closings = 160.
// The variation that matters lives in the multi-paragraph openings; a transition
// is one line, and a closing has a narrow permitted surface (ask for results in
// writing, thank the reader). Expanding those buys little and is not on the
// critical path to the real report run.
check("combination count = openings x transitions x closings",
    combinationCount(), OPENINGS.length * TRANSITIONS.length * CLOSINGS.length);
check("...at least a few distinct voices", combinationCount() >= OPENINGS.length, true);

console.log("\n=== VARIATION: letters must not look mass-produced ===\n");

// Two clients, same bureau, same round. This is the pattern a bureau spots
// first, and it discredits every other letter we send.
const c15 = selectVoice({ ...ctx, crcClientId: 15 });
const c99 = selectVoice({ ...ctx, crcClientId: 99 });
check("different clients -> different voice", c15.provenance.combination === c99.provenance.combination, false);

// Round 2 to the same bureau. That reader most likely has round 1 on file.
const r2 = selectVoice({ ...ctx, round: 2 });
check("round 2 differs from round 1", v1.provenance.combination === r2.provenance.combination, false);

// The three bureaus receive different letters in the same run.
const tu = selectVoice({ ...ctx, bureau: "transunion" });
const ex = selectVoice({ ...ctx, bureau: "experian" });
const eq = selectVoice({ ...ctx, bureau: "equifax" });
check("three bureaus -> three voices", new Set([tu.provenance.combination, ex.provenance.combination, eq.provenance.combination]).size, 3);

// The libraries must not be locked 1:1. If one seed drove all three, the 560
// combinations would collapse to 10 and the PAIRING would become the fingerprint.
const combos = new Set();
for (let c = 1; c <= 200; c++) {
    combos.add(selectVoice({ ...ctx, crcClientId: c }).provenance.combination);
}
check("combinations are not locked 1:1", combos.size > OPENINGS.length, true);
console.log(`  ${combos.size} distinct combinations across 200 clients`);

console.log("\n=== SAMPLE LETTER VOICE ===\n");
console.log(v1.opening.text);
console.log("\n" + v1.transition.text);
console.log("\n[account sections]\n");
console.log(v1.closing.text);

console.log("\n=== RECIPIENT STANDARD: never a generic greeting ===\n");

const GENERIC = /credit reporting agency|to whom it may concern|dear sir|dear madam|dear sir or madam/i;

for (const key of supportedBureaus()) {
    const r = resolveRecipient(key);
    check(`${key}: resolves`, r.ok, true);
    check(`${key}: greeting names the bureau`, r.greeting.includes(r.shortName), true);
    check(`${key}: greeting is not generic`, GENERIC.test(r.greeting), false);
    check(`${key}: address block is not generic`, GENERIC.test(r.addressBlock), false);
}

check("TransUnion legal entity", resolveRecipient("transunion").legalName, "TransUnion LLC");
check("Experian legal entity", resolveRecipient("experian").legalName, "Experian Information Solutions, Inc.");
check("Equifax legal entity", resolveRecipient("equifax").legalName, "Equifax Information Services LLC");

// An unknown bureau must NOT silently fall back to a generic greeting — that
// would reintroduce the exact failure this standard forbids, on the first typo.
const unknown = resolveRecipient("transunion-typo");
check("unknown bureau -> FAILS CLOSED", unknown.ok, false);
check("...and does NOT fall back to a generic greeting", !!unknown.greeting, false);

// Recipients must NOT vary. There is one correct entity per bureau.
const a = resolveRecipient("experian");
const b = resolveRecipient("experian");
check("recipient never varies", a.legalName === b.legalName && a.greeting === b.greeting, true);

console.log("\n=== APPROVAL STATUS IS MACHINE-READABLE ===\n");

// The approval flag is real state, not a comment. A library that certifies its
// own approval in prose is the same defect class as the identity string literal
// that once put a fabricated address on a dispute letter — a guarantee asserted
// rather than enforced is worse than none, because it stops people looking.
check("openings are Suzanne-approved", OPENINGS_APPROVED, true);
check("...marked KRIS_APPROVED_V1", OPENING_APPROVAL, "KRIS_APPROVED_V1");
check("voice provenance reports approval", selectVoice(ctx).provenance.librariesApproved, true);

// The greeting is NOT part of the Opening Library and must never be folded in.
// Voice VARIES; the recipient must NEVER vary.
const openingText = OPENINGS.map(renderOpening).join(" ");
check("no opening contains a greeting", /^Dear |Dear (?:TransUnion|Experian|Equifax|Sir|Madam)/i.test(openingText), false);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
