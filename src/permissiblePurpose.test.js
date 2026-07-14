/**
 * permissiblePurpose.test.js
 * Run: node src/intelligence/permissiblePurpose.test.js
 *
 * BT-DM-0055 — PERMISSIBLE PURPOSE VERIFICATION, for INQUIRIES *and* TRADELINES.
 *
 * TWO INVARIANTS, both machine-checked:
 *
 *   1. NEVER assert that permissible purpose is absent. We request verification.
 *   2. NEVER use inquiry wording for a tradeline. They are different legal
 *      questions — access to the file vs. authority to furnish an account — and
 *      conflating them is the exact tell that a letter was generated.
 */

import {
    evaluateInquiryPermissiblePurpose,
    evaluateTradelinePermissiblePurpose,
    evaluateInquiries,
    evaluateTradelines,
    furnisherHasTradeline,
    letterTextFor,
    BT_DM_0055,
    ITEM_TYPE,
    MODE,
} from "./permissiblePurpose.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(62)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

const chargeOff = {
    stable_item_key: "bt_tl_navy_tu",
    bureau: "transunion",
    furnisher: "NAVY FEDERAL CR UNION",
    masked_account: "****6095",
    observation: { status: "Charge-off", balance: 4200, past_due: 4200, responsibility: "Individual" },
};

const authorizedUser = {
    stable_item_key: "bt_tl_au_tu",
    bureau: "transunion",
    furnisher: "SOME CARD",
    masked_account: "****1111",
    observation: { status: "Collection", balance: 900, past_due: 900, responsibility: "Authorized User" },
};

const noAccountNumber = {
    stable_item_key: "bt_tl_noacct_exp",
    bureau: "experian",
    furnisher: "MYSTERY COLLECTOR",
    masked_account: null,
    observation: { status: "Collection", balance: 300, past_due: 300, responsibility: "Individual" },
};

const positive = {
    stable_item_key: "bt_tl_chase_tu",
    bureau: "transunion",
    furnisher: "CHASE BANK USA NA",
    masked_account: "****1234",
    observation: { status: "Current", balance: 500, past_due: 0, responsibility: "Individual" },
};

const report = {
    accounts: [
        { stable_account_key: "bt_ac_navy", bureau_tradelines: [chargeOff] },
        { stable_account_key: "bt_ac_chase", bureau_tradelines: [positive] },
        { stable_account_key: "bt_ac_au", bureau_tradelines: [authorizedUser] },
    ],
    collections: [
        { stable_account_key: "bt_ac_mystery", bureau_tradelines: [noAccountNumber] },
    ],
    inquiries: [
        { stable_item_key: "bt_iq_unknown", bureau: "transunion", furnisher: "UNKNOWN LENDER", inquiry_date: "2026-01-05", inquiry_type: "hard" },
        { stable_item_key: "bt_iq_chase", bureau: "transunion", furnisher: "JPMCB CARD SERVICES", inquiry_date: "2026-02-01", inquiry_type: "hard" },
        { stable_item_key: "bt_iq_soft", bureau: "transunion", furnisher: "SOME BANK", inquiry_date: "2026-03-01", inquiry_type: "soft - account review" },
    ],
};

const inq = (k) => report.inquiries.find((i) => i.stable_item_key === k);

// ===========================================================================
console.log("\n=== TRADELINE: a DIFFERENT legal question from an inquiry ===\n");
// ===========================================================================

const tl = evaluateTradelinePermissiblePurpose({ tradeline: chargeOff, furnisher: "NAVY FEDERAL CR UNION" });

check("derogatory tradeline -> eligible", tl.eligible, true);
check("...itemType TRADELINE", tl.itemType, ITEM_TYPE.TRADELINE);
check("...carries THIS bureau's account number", tl.maskedAccount, "****6095");
check("...cites § 623 (furnisher duties), not § 604", tl.authority.includes("1681s-2"), true);
check("...NOT § 604", tl.authority.includes("1681b"), false);

const tlText = letterTextFor(tl);
const tlAll = `${tlText.defect} ${tlText.request}`;

console.log("\n--- The tradeline wording ---");
console.log(`  ${tlText.heading} — Account Number: ${tlText.accountNumber}`);
console.log(`  ${tlText.defect}`);
console.log(`  ${tlText.request}\n`);

check("identifies the CREDITOR", tlText.heading, "NAVY FEDERAL CR UNION");
check("identifies the ACCOUNT NUMBER", tlText.accountNumber, "****6095");
check("asks about FURNISHING the account", /furnishes, and continues to report, this account/i.test(tlText.request), true);
check("requests verification of permissible purpose AND authority", /permissible purpose and the authority/i.test(tlText.request), true);
check("conditions deletion on THEIR verification", /if that authority cannot be verified, please delete/i.test(tlText.request), true);

console.log("\n--- NEVER inquiry wording on a tradeline ---");

// "Please verify the permissible purpose for this inquiry" written about a
// charge-off is nonsense, and it is the exact tell that a letter was generated.
check("no 'inquiry' anywhere in tradeline text", /inquiry/i.test(tlAll), false);
check("no 'access to my credit file'", /access(?:ed)? my credit file|access to my credit file/i.test(tlAll), false);
check("does not say 'remove this inquiry'", /remove this inquiry/i.test(tlAll), false);

console.log("\n--- And never asserts absence of authority ---");

check("assertsLackOfPermissiblePurpose FALSE", tl.assertsLackOfPermissiblePurpose, false);
check("no assertion of absence", /had no|lacks|lacked|without (?:permissible purpose|authority)|no legal right|not authorized to report/i.test(tlAll), false);
check("no accusation of illegality", /unlawful|illegal|violation|violated/i.test(tlAll), false);
check("human reviews it", tl.humanReview, true);

console.log("\n--- Tradeline blocks ---");

const pos = evaluateTradelinePermissiblePurpose({ tradeline: positive, furnisher: "CHASE" });
check("positive account -> BLOCKED", pos.eligible, false);
check("...NOT_DEROGATORY", pos.blockedBy, "NOT_DEROGATORY");

const au = evaluateTradelinePermissiblePurpose({ tradeline: authorizedUser, furnisher: "SOME CARD" });
check("authorized user -> BLOCKED", au.eligible, false);
check("...AUTHORIZED_USER", au.blockedBy, "AUTHORIZED_USER");

const mixed = evaluateTradelinePermissiblePurpose({ tradeline: chargeOff, furnisher: "NAVY", mixedFile: true });
check("mixed file -> BLOCKED", mixed.eligible, false);
check("...MIXED_FILE", mixed.blockedBy, "MIXED_FILE");

// Without THAT bureau's own number the letter cannot say what it is asking
// about, and the bureau answers "unable to locate" — burning a round.
const noAcct = evaluateTradelinePermissiblePurpose({ tradeline: noAccountNumber, furnisher: "MYSTERY COLLECTOR" });
check("no bureau account number -> BLOCKED", noAcct.eligible, false);
check("...NO_BUREAU_ACCOUNT_NUMBER", noAcct.blockedBy, "NO_BUREAU_ACCOUNT_NUMBER");

// ===========================================================================
console.log("\n=== INQUIRY: access to the credit file ===\n");
// ===========================================================================

const iq = evaluateInquiryPermissiblePurpose({ inquiry: inq("bt_iq_unknown"), report, attestation: null });

check("hard inquiry -> eligible with NO attestation", iq.eligible, true);
check("...itemType INQUIRY", iq.itemType, ITEM_TYPE.INQUIRY);
check("...mode VERIFICATION_REQUEST", iq.mode, MODE.VERIFICATION_REQUEST);
check("...cites § 604", iq.authority.includes("1681b"), true);
check("...NOT § 623", iq.authority.includes("1681s-2"), false);

const iqText = letterTextFor(iq);
const iqAll = `${iqText.defect} ${iqText.request}`;

console.log("\n--- The inquiry wording ---");
console.log(`  ${iqText.defect}`);
console.log(`  ${iqText.request}\n`);

check("refers to the FILE being furnished", /my credit file was furnished to this company/i.test(iqText.request), true);
check("asks to remove the INQUIRY", /remove this inquiry/i.test(iqText.request), true);
check("does NOT ask to delete an account", /delete this account/i.test(iqAll), false);
check("assertsLackOfPermissiblePurpose FALSE", iq.assertsLackOfPermissiblePurpose, false);
check("no assertion of absence", /had no permissible purpose|lacked permissible purpose|without permissible purpose/i.test(iqAll), false);

console.log("\n--- Consumer statement: stronger, still a request ---");

const attested = evaluateInquiryPermissiblePurpose({
    inquiry: inq("bt_iq_unknown"),
    report,
    attestation: {
        stableItemKey: "bt_iq_unknown",
        didNotApply: true,
        didNotAuthorize: true,
        noAccountRelationship: true,
    },
});

check("mode CONSUMER_DISPUTED", attested.mode, MODE.CONSUMER_DISPUTED);
check("STILL asserts no lack of permissible purpose", attested.assertsLackOfPermissiblePurpose, false);

const attestedText = letterTextFor(attested);
// She may state HER OWN fact. We may not convert it into OUR legal conclusion.
check("reports HER statement", /I did not apply/i.test(attestedText.defect), true);
check("...but still REQUESTS verification", /verify the permissible purpose/i.test(attestedText.request), true);
check("...draws no legal conclusion", /unlawful|illegal|violation|must remove/i.test(attestedText.request), false);

console.log("\n--- Inquiry blocks ---");

// JPMCB and CHASE are the same company. Suffix-stripping compares JPMCB to CHASE
// and silently finds nothing — which would send Elizabeth's own card issuer a
// demand to justify an inquiry it had every right to make.
check("JPMCB matches the CHASE tradeline", furnisherHasTradeline("JPMCB CARD SERVICES", report), true);

const ownCreditor = evaluateInquiryPermissiblePurpose({ inquiry: inq("bt_iq_chase"), report });
check("furnisher holds an account -> BLOCKED", ownCreditor.eligible, false);
check("...blocked for CREDIBILITY, not truth", /credibility/i.test(ownCreditor.reason), true);

const soft = evaluateInquiryPermissiblePurpose({ inquiry: inq("bt_iq_soft"), report });
check("soft inquiry -> BLOCKED", soft.eligible, false);
check("...SOFT_INQUIRY", soft.blockedBy, "SOFT_INQUIRY");

// ===========================================================================
console.log("\n=== THE TWO WORDINGS ARE GENUINELY DIFFERENT ===\n");
// ===========================================================================

check("tradeline text != inquiry text", tlText.request === iqText.request, false);
check("only the tradeline names an account number", !!tlText.accountNumber && !iqText.accountNumber, true);
check("only the inquiry mentions 'inquiry'", /inquiry/i.test(iqAll) && !/inquiry/i.test(tlAll), true);
check("different statutes", BT_DM_0055.authority[ITEM_TYPE.INQUIRY] === BT_DM_0055.authority[ITEM_TYPE.TRADELINE], false);

console.log("\n=== REPORT-WIDE ===\n");

const inquiries = evaluateInquiries(report, {});
check("3 inquiries, 1 eligible", inquiries.summary.eligibleForDispute, 1);

const tradelines = evaluateTradelines(report);
check("4 tradelines evaluated", tradelines.summary.evaluated, 4);
check("1 eligible (the charge-off)", tradelines.summary.eligibleForDispute, 1);
check("...authorized user blocked", tradelines.summary.blockedByAuthorizedUser, 1);
check("...no-account-number blocked", tradelines.summary.blockedByNoAccountNumber, 1);
check("every eligible tradeline has an account number", tradelines.eligible.every((e) => !!e.maskedAccount), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
