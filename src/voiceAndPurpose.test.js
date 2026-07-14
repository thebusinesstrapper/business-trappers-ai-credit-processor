/**
 * voiceAndPurpose.test.js
 * Run: node src/intelligence/voiceAndPurpose.test.js
 *
 * 1. NATURAL CONSUMER VOICE — variation by SELECTION, never generation.
 * 2. PERMISSIBLE PURPOSE — never asserted without the consumer, and never
 *    against the consumer's own creditor.
 */

import {
    APPROVED_OPENINGS,
    APPROVED_CLOSINGS,
    selectOpening,
    selectClosing,
} from "./openings.js";

import {
    evaluatePermissiblePurpose,
    evaluateInquiries,
    furnisherHasTradeline,
    BT_DM_0055,
} from "./permissiblePurpose.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(62)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

console.log("\n=== NATURAL VOICE: deterministic, not generated ===\n");

const ctx = { crcClientId: 15, bureau: "transunion", round: 1, reportDate: "2026-07-13" };

const a1 = selectOpening(ctx);
const a2 = selectOpening(ctx);

check("same input -> IDENTICAL opening (regenerable)", a1.text === a2.text, true);
check("...same index", a1.index, a2.index);
check("the opening is from the APPROVED library", APPROVED_OPENINGS.includes(a1.text), true);
check("the closing is from the APPROVED library", APPROVED_CLOSINGS.includes(selectClosing(ctx).text), true);

console.log("\n--- Different letters get different openings ---");

const tu = selectOpening({ ...ctx, bureau: "transunion" });
const exp = selectOpening({ ...ctx, bureau: "experian" });
const eqf = selectOpening({ ...ctx, bureau: "equifax" });

check("bureaus differ from each other", new Set([tu.index, exp.index, eqf.index]).size > 1, true);

// Round 2 must not open with the identical sentence as round 1 to the SAME
// bureau — that reader is the one most likely to have both letters on file.
const r1 = selectOpening({ ...ctx, round: 1 });
const r2 = selectOpening({ ...ctx, round: 2 });
check("round 1 and round 2 differ (same bureau)", r1.index === r2.index, false);

// Two clients writing to the same bureau in the same round must not be identical
// — that is the mass-production pattern a bureau notices first.
const client15 = selectOpening({ ...ctx, crcClientId: 15 });
const client99 = selectOpening({ ...ctx, crcClientId: 99 });
check("different clients differ", client15.index === client99.index, false);

console.log("\n--- Opening/closing pairing is not itself a fingerprint ---");

// If both used the same seed, opening #3 would ALWAYS travel with closing #3,
// and the pairing would become the fingerprint we were trying to avoid.
const pairings = new Set();
for (let c = 1; c <= 40; c++) {
    const o = selectOpening({ ...ctx, crcClientId: c });
    const cl = selectClosing({ ...ctx, crcClientId: c });
    pairings.add(`${o.index}:${cl.index}`);
}
check("opening/closing pairs are not locked 1:1", pairings.size > APPROVED_OPENINGS.length, true);

console.log("\n--- Every approved opening is history-neutral ---");

// The opening asserts something about EVERY account in the letter. A bureau
// letter mixes first-round and escalated accounts, so any claim about dispute
// history would be FALSE for the first-round ones.
const historyLanguage = /previously disputed|second time|again|as I (?:told|wrote|informed)|prior (?:dispute|letter)|last (?:letter|time)|already/i;

let neutral = true;
for (const opening of APPROVED_OPENINGS) {
    if (historyLanguage.test(opening)) {
        neutral = false;
        console.log(`  NOT NEUTRAL: "${opening}"`);
    }
}
check("no opening asserts dispute history", neutral, true);

// And no opening may assert a specific account is inaccurate — the account
// sections do that, individually, where it is supported.
let noAccountClaims = true;
for (const opening of APPROVED_OPENINGS) {
    if (/this account is (?:inaccurate|false|incorrect)/i.test(opening)) noAccountClaims = false;
}
check("no opening makes account-specific claims", noAccountClaims, true);

check("library has room to vary", APPROVED_OPENINGS.length >= 6, true);
check("no duplicate openings", new Set(APPROVED_OPENINGS).size, APPROVED_OPENINGS.length);

console.log("\n=== PERMISSIBLE PURPOSE: the report cannot prove it ===\n");

const report = {
    accounts: [
        {
            stable_account_key: "bt_ac_chase",
            bureau_tradelines: [
                {
                    stable_item_key: "bt_tl_chase",
                    bureau: "transunion",
                    furnisher: "CHASE BANK USA NA",
                    masked_account: "****1234",
                    observation: { status: "Current", balance: 500, past_due: 0 },
                },
            ],
        },
    ],
    collections: [],
    inquiries: [
        { stable_item_key: "bt_iq_unknown", bureau: "transunion", furnisher: "UNKNOWN LENDER", inquiry_date: "2026-01-05", inquiry_type: "hard" },
        { stable_item_key: "bt_iq_chase", bureau: "transunion", furnisher: "JPMCB CARD SERVICES", inquiry_date: "2026-02-01", inquiry_type: "hard" },
        { stable_item_key: "bt_iq_soft", bureau: "transunion", furnisher: "SOME BANK", inquiry_date: "2026-03-01", inquiry_type: "soft - account review" },
    ],
};

const inq = (k) => report.inquiries.find((i) => i.stable_item_key === k);

console.log("--- With NO attestation, nothing is disputed. Ever. ---");

const noAttest = evaluatePermissiblePurpose({ inquiry: inq("bt_iq_unknown"), report, attestation: null });

check("no attestation -> NOT eligible", noAttest.eligible, false);
check("...blocked by NO_CONSUMER_ATTESTATION", noAttest.blockedBy, "NO_CONSUMER_ATTESTATION");
check("...reason explains the report cannot prove it", /cannot establish a lack of permissible purpose/i.test(noAttest.reason), true);

const attestation = (key) => ({
    stableItemKey: key,
    didNotApply: true,
    didNotAuthorize: true,
    noAccountRelationship: true,
    attestedAt: "2026-07-13T00:00:00Z",
    attestedBy: "consumer",
});

console.log("\n--- A complete attestation, furnisher NOT on the report -> eligible ---");

const good = evaluatePermissiblePurpose({
    inquiry: inq("bt_iq_unknown"),
    report,
    attestation: attestation("bt_iq_unknown"),
});

check("eligible", good.eligible, true);
check("record BT-DM-0055", good.record, "BT-DM-0055");
check("evidence REQUIRES_CONSUMER", good.evidenceClass, "REQUIRES_CONSUMER");
check("NEVER automated", good.automationTier, "NEVER_AUTOMATED");
check("human review required even when clean", good.humanReview, true);
check("cites § 1681b", BT_DM_0055.authority.includes("1681b"), true);
check("valid on round 1, not escalation-only", BT_DM_0055.escalationOnly, false);

console.log("\n--- THE REPORT MAY OVERRIDE THE CONSUMER ---");

// She attests in perfect good faith. But CHASE is on her own report. A consumer
// who forgot she holds the card is exactly this case — and filing would accuse
// her own creditor of a federal violation, verifiable against the account
// sitting on the same page.
check("JPMCB matches CHASE tradeline", furnisherHasTradeline("JPMCB CARD SERVICES", report), true);

const contradicted = evaluatePermissiblePurpose({
    inquiry: inq("bt_iq_chase"),
    report,
    attestation: attestation("bt_iq_chase"),
});

check("attested BUT furnisher holds an account -> BLOCKED", contradicted.eligible, false);
check("...blocked by FURNISHER_HAS_TRADELINE_ON_REPORT", contradicted.blockedBy, "FURNISHER_HAS_TRADELINE_ON_REPORT");
check("...reason names the account relationship", /appears as an account/i.test(contradicted.reason), true);

console.log("\n--- Partial attestations are not attestations ---");

const partial = evaluatePermissiblePurpose({
    inquiry: inq("bt_iq_unknown"),
    report,
    attestation: { stableItemKey: "bt_iq_unknown", didNotApply: true, didNotAuthorize: false, noAccountRelationship: true },
});
check("incomplete attestation -> BLOCKED", partial.eligible, false);

// A general "some inquiries look wrong" is not an attestation about THIS one.
const mismatched = evaluatePermissiblePurpose({
    inquiry: inq("bt_iq_unknown"),
    report,
    attestation: attestation("bt_iq_SOMETHING_ELSE"),
});
check("attestation for a DIFFERENT inquiry -> BLOCKED", mismatched.eligible, false);

console.log("\n--- Soft inquiries are not disputable on this ground ---");

const soft = evaluatePermissiblePurpose({
    inquiry: inq("bt_iq_soft"),
    report,
    attestation: attestation("bt_iq_soft"),
});
check("soft inquiry -> BLOCKED even when attested", soft.eligible, false);
check("...blocked by SOFT_INQUIRY", soft.blockedBy, "SOFT_INQUIRY");

console.log("\n--- No blanket inquiry sweeps ---");

// With zero attestations, a report full of inquiries yields zero disputes.
// There is no code path from "an inquiry exists" to "dispute it".
const sweep = evaluateInquiries(report, {});

check("3 inquiries, 0 attestations -> 0 disputes", sweep.summary.eligibleForDispute, 0);
check("...all blocked", sweep.summary.blocked, 3);
check("...2 for want of attestation", sweep.summary.blockedByNoAttestation, 2);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
