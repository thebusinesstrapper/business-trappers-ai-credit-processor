/**
 * permissiblePurpose.js
 *
 * BT-DM-0055 — PERMISSIBLE PURPOSE VERIFICATION.
 * A first-class Business Trappers strategy for BOTH inquiries AND tradelines.
 *
 * ===========================================================================
 * TWO ITEM TYPES. TWO DIFFERENT LEGAL QUESTIONS. TWO SEPARATE WORDINGS.
 *
 * These are NOT the same dispute with the noun swapped, and treating them that
 * way would put "inquiry" language on an account section — which reads as a
 * form letter and tells the bureau nobody looked at the account.
 *
 *   INQUIRY   — a one-time ACCESS event. Someone obtained the file.
 *               The question: under what permissible purpose was my credit file
 *               FURNISHED to this company?
 *               § 604 governs who may RECEIVE a report.
 *
 *   TRADELINE — an ONGOING act of REPORTING. A furnisher places, and keeps
 *               placing, an account on the file.
 *               The question: by what authority does this creditor furnish, and
 *               CONTINUE to report, this account?
 *               This concerns the furnisher's authority and its § 623 duties, and
 *               it must name the CREDITOR and THAT BUREAU'S account number.
 *
 * "Please verify the permissible purpose for this inquiry" written about a
 * charge-off is nonsense. It is also the exact tell that a letter was generated.
 *
 * ===========================================================================
 * THE INVARIANT, ACROSS BOTH TYPES:
 *
 *   WE REQUEST VERIFICATION. WE NEVER ASSERT THAT AUTHORITY WAS ABSENT.
 *
 * The processor has not established that, and it cannot from a report. A request
 * asserts nothing — so nothing in it can be false — and it puts the burden
 * exactly where the statute already places it: on the party that furnished.
 *
 * An accusation we cannot support invites a one-line denial. A request for
 * verification obliges them to actually go and check. The second is not the
 * weaker move.
 * ===========================================================================
 */

export const PERMISSIBLE_PURPOSE_SCHEMA_VERSION = "BT-PP-3.0";

export const ITEM_TYPE = Object.freeze({
    INQUIRY: "INQUIRY",
    TRADELINE: "TRADELINE",
});

export const MODE = Object.freeze({
    // No consumer statement. Pure request. Asserts nothing whatsoever.
    VERIFICATION_REQUEST: "VERIFICATION_REQUEST",

    // The consumer has stated she did not apply / did not authorize. That is HER
    // fact and she may state it. We still REQUEST verification — the legal
    // conclusion is not ours to draw.
    CONSUMER_DISPUTED: "CONSUMER_DISPUTED",
});

export const BT_DM_0055 = Object.freeze({
    record: "BT-DM-0055",
    name: "Permissible Purpose Verification",

    strategy: "BT-ST-0004",
    reason: "BT-RN-0004",
    instruction: "BT-IN-0004",
    blueprint: "BT-BP-0004",

    roundEligibility: "1-5",
    escalationOnly: false,

    authority: {
        // Who may RECEIVE a consumer report.
        [ITEM_TYPE.INQUIRY]:
            "FCRA § 604 (15 U.S.C. § 1681b) — a consumer report may be furnished only for a permissible purpose.",

        // A furnisher's duty regarding the accuracy and integrity of what it
        // reports, and its authority to report it at all.
        [ITEM_TYPE.TRADELINE]:
            "FCRA § 623 (15 U.S.C. § 1681s-2) — duties of furnishers of information to consumer reporting agencies.",
    },
});

/**
 * FURNISHER ALIAS TABLE — BLOCKING ONLY. It can never cause a dispute.
 *
 * Asymmetry: a false positive costs one low-value dispute. A false negative
 * sends the consumer's own card issuer a demand to justify an inquiry it plainly
 * had every right to make — on a report that shows the account. That wastes a
 * round and teaches the bureau to skim our letters.
 *
 * Found by test: "JPMCB CARD SERVICES" and "CHASE BANK USA NA" are the same
 * company; suffix-stripping compares JPMCB to CHASE and silently finds nothing.
 */
const FURNISHER_ALIASES = Object.freeze([
    ["CHASE", "JPMCB", "JPMORGAN", "JP MORGAN"],
    ["CITI", "CITIBANK", "CBNA", "CITICARDS"],
    ["CAPITAL ONE", "CAP ONE", "CAPONE"],
    ["AMERICAN EXPRESS", "AMEX"],
    ["DISCOVER", "DISCOVER FINANCIAL", "DFS"],
    ["SYNCHRONY", "SYNCB", "SYNCHRONY BANK"],
    ["BANK OF AMERICA", "BOFA", "BANK AMERICA", "BK OF AMER"],
    ["WELLS FARGO", "WELLS FARGO BANK"],
    ["NAVY FEDERAL", "NAVY FCU", "NFCU"],
    ["US BANK", "USBANK", "US BK"],
    ["TD BANK", "TD BANK USA", "TDBANK"],
    ["BARCLAYS", "BARCLAYCARD", "BARCLAYS BANK DELAWARE"],
    ["GOLDMAN SACHS", "APPLE CARD", "GS BANK"],
]);

function normaliseFurnisher(name) {
    return String(name ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, "")
        .replace(/\b(NA|INC|LLC|CORP|BANK USA|CARD SERVICES|BANK|USA)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function aliasGroup(normalised) {
    if (!normalised) return null;

    for (const group of FURNISHER_ALIASES) {
        for (const alias of group) {
            if (normalised === alias || normalised.includes(alias) || alias.includes(normalised)) {
                return group[0];
            }
        }
    }

    return null;
}

export function furnisherHasTradeline(furnisher, report) {
    const target = normaliseFurnisher(furnisher);
    if (!target) return false;

    const targetGroup = aliasGroup(target);

    for (const group of [...(report.accounts ?? []), ...(report.collections ?? [])]) {
        for (const tradeline of group.bureau_tradelines ?? []) {
            const candidate = normaliseFurnisher(tradeline.furnisher);
            if (!candidate) continue;

            if (candidate === target || candidate.includes(target) || target.includes(candidate)) {
                return true;
            }

            const candidateGroup = aliasGroup(candidate);
            if (targetGroup && candidateGroup && targetGroup === candidateGroup) return true;
        }
    }

    return false;
}

// ===========================================================================
// INQUIRIES
// ===========================================================================

/**
 * @param {object} ctx
 * @param {object} ctx.inquiry
 * @param {object} ctx.report
 * @param {object} [ctx.attestation]
 */
export function evaluateInquiryPermissiblePurpose(ctx) {
    const { inquiry, report, attestation = null } = ctx;

    const blocked = (blockedBy, reason) => ({
        eligible: false,
        itemType: ITEM_TYPE.INQUIRY,
        record: BT_DM_0055.record,
        blockedBy,
        reason,
    });

    if (/soft|promotional|prescreen|account\s*review|consumer[- ]initiated/i.test(String(inquiry.inquiry_type ?? ""))) {
        return blocked(
            "SOFT_INQUIRY",
            `Inquiry type "${inquiry.inquiry_type}" is soft. Soft inquiries are not disclosed to lenders. Nothing of value to dispute.`
        );
    }

    // Not a truth problem — a CREDIBILITY problem. Asking a bureau to justify a
    // Chase inquiry when a Chase account sits on the same report earns a one-line
    // answer and spends credibility we need for the disputes that can win.
    if (furnisherHasTradeline(inquiry.furnisher, report)) {
        return blocked(
            "FURNISHER_HAS_TRADELINE_ON_REPORT",
            `${inquiry.furnisher} appears as an account on this consumer's own report. An existing ` +
                `account relationship is a permissible purpose on its face, so this would be answered ` +
                `in one line and would cost credibility on the disputes that matter. Routed to a human.`
        );
    }

    const mode = isCompleteAttestation(attestation, inquiry.stable_item_key)
        ? MODE.CONSUMER_DISPUTED
        : MODE.VERIFICATION_REQUEST;

    return {
        eligible: true,
        itemType: ITEM_TYPE.INQUIRY,
        record: BT_DM_0055.record,
        name: BT_DM_0055.name,
        mode,

        strategy: BT_DM_0055.strategy,
        reason: BT_DM_0055.reason,
        authority: BT_DM_0055.authority[ITEM_TYPE.INQUIRY],

        assertsLackOfPermissiblePurpose: false, // INVARIANT
        humanReview: true,

        reasoningChain: [
            `INQUIRY: ${inquiry.furnisher} (${inquiry.bureau}), dated ${inquiry.inquiry_date ?? "unknown"}.`,
            `RELATIONSHIP CHECK: no matching tradeline found on this report.`,
            mode === MODE.CONSUMER_DISPUTED
                ? `CONSUMER STATEMENT: she states she did not apply and did not authorize this access.`
                : `NO CONSUMER STATEMENT: the letter REQUESTS verification and asserts nothing.`,
            `THE LETTER REQUESTS VERIFICATION of the permissible purpose for ACCESS to the file. It does NOT assert that permissible purpose was absent.`,
            `AUTHORITY: ${BT_DM_0055.authority[ITEM_TYPE.INQUIRY]}`,
        ],
    };
}

// ===========================================================================
// TRADELINES
// ===========================================================================

const AUTHORIZED_USER = /authorized\s*user/i;
const DEROGATORY = /charge.?off|collection|repossession|foreclosure|settled|default|written.?off|late|delinquen|derogatory/i;

/**
 * Permissible purpose / authority verification for a TRADELINE.
 *
 * A different question from the inquiry version: not "who was allowed to LOOK at
 * my file", but "by what authority does this creditor FURNISH, and continue to
 * report, this account".
 *
 * @param {object} ctx
 * @param {object} ctx.tradeline   the bureau tradeline (carries THIS bureau's masked account)
 * @param {string} ctx.furnisher
 * @param {boolean} [ctx.mixedFile]
 */
export function evaluateTradelinePermissiblePurpose(ctx) {
    const { tradeline, furnisher, mixedFile = false } = ctx;
    const obs = tradeline.observation ?? {};

    const blocked = (blockedBy, reason) => ({
        eligible: false,
        itemType: ITEM_TYPE.TRADELINE,
        record: BT_DM_0055.record,
        blockedBy,
        reason,
    });

    // Positive accounts are never disputed — a dispute can get a BENEFICIAL
    // tradeline deleted.
    const pastDue = Number(obs.past_due ?? 0);
    const derogatory = DEROGATORY.test(String(obs.status ?? "")) || pastDue > 0;

    if (!derogatory) {
        return blocked("NOT_DEROGATORY", "Positive accounts are never disputed.");
    }

    if (AUTHORIZED_USER.test(String(obs.responsibility ?? ""))) {
        return blocked(
            "AUTHORIZED_USER",
            "Authorized-user account. The Project Constitution forbids disputing these."
        );
    }

    if (mixedFile) {
        return blocked(
            "MIXED_FILE",
            "An unresolved mixed-file concern supersedes all dispute strategies until identity is resolved."
        );
    }

    // THE BUREAU-SPECIFIC ACCOUNT NUMBER IS MANDATORY.
    //
    // The dispute is about THIS bureau's reporting of THIS account. Without that
    // bureau's own masked number the letter cannot identify what it is asking
    // about, and the bureau answers "unable to locate" — burning a round.
    if (!tradeline.masked_account) {
        return blocked(
            "NO_BUREAU_ACCOUNT_NUMBER",
            `${furnisher} is reported by ${tradeline.bureau} with no masked account number. A ` +
                `permissible-purpose request must identify the account by THAT bureau's own number. ` +
                `Withheld rather than sent unidentifiable.`
        );
    }

    return {
        eligible: true,
        itemType: ITEM_TYPE.TRADELINE,
        record: BT_DM_0055.record,
        name: BT_DM_0055.name,
        mode: MODE.VERIFICATION_REQUEST,

        strategy: BT_DM_0055.strategy,
        reason: BT_DM_0055.reason,
        authority: BT_DM_0055.authority[ITEM_TYPE.TRADELINE],

        stableItemKey: tradeline.stable_item_key,
        bureau: tradeline.bureau,
        furnisher,
        maskedAccount: tradeline.masked_account, // THIS bureau's, verbatim

        assertsLackOfPermissiblePurpose: false, // INVARIANT
        humanReview: true,

        reasoningChain: [
            `TRADELINE: ${furnisher}, account ${tradeline.masked_account}, reported by ${tradeline.bureau}.`,
            `Derogatory, individually held, and identifiable by this bureau's own account number.`,
            `THE LETTER REQUESTS VERIFICATION of the permissible purpose and authority under which this creditor furnishes, and continues to report, this account. It does NOT assert that authority is absent.`,
            `AUTHORITY: ${BT_DM_0055.authority[ITEM_TYPE.TRADELINE]}`,
        ],
    };
}

function isCompleteAttestation(attestation, stableItemKey) {
    if (!attestation) return false;
    if (attestation.stableItemKey !== stableItemKey) return false;

    return (
        attestation.didNotApply === true &&
        attestation.didNotAuthorize === true &&
        attestation.noAccountRelationship === true
    );
}

// ===========================================================================
// APPROVED WORDING — DISTINCT BY ITEM TYPE
//
// NEVER use inquiry wording for a tradeline. The words "inquiry" and "access"
// must not appear in a tradeline section, and the words "furnish this account"
// must not appear in an inquiry section. Enforced by test.
// ===========================================================================

export function letterTextFor(evaluation) {
    if (evaluation.itemType === ITEM_TYPE.TRADELINE) {
        return {
            // Identifies the CREDITOR and THIS BUREAU'S account number.
            heading: evaluation.furnisher,
            accountNumber: evaluation.maskedAccount,

            defect: "I dispute this account.",

            request:
                "Please verify the permissible purpose and the authority under which this creditor " +
                "furnishes, and continues to report, this account on my credit file, and provide me " +
                "with that verification. If that authority cannot be verified, please delete this " +
                "account from my credit file.",

            authority: evaluation.authority,
        };
    }

    // INQUIRY — refers to ACCESS to the credit file.
    if (evaluation.mode === MODE.CONSUMER_DISPUTED) {
        return {
            defect:
                "I did not apply for credit with this company and did not authorize them to access my " +
                "credit file.",
            request:
                "Please verify the permissible purpose under which my credit file was furnished to this " +
                "company and provide me with that verification. If a permissible purpose cannot be " +
                "verified, please remove this inquiry from my credit file.",
            authority: evaluation.authority,
        };
    }

    return {
        defect: "I do not recognize this inquiry on my credit file.",
        request:
            "Please verify the permissible purpose under which my credit file was furnished to this " +
            "company and provide me with that verification. If a permissible purpose cannot be " +
            "verified, please remove this inquiry from my credit file.",
        authority: evaluation.authority,
    };
}

/** Evaluate every inquiry on a report. */
export function evaluateInquiries(report, attestations = {}) {
    const eligible = [];
    const blocked = [];

    for (const inquiry of report.inquiries ?? []) {
        const result = evaluateInquiryPermissiblePurpose({
            inquiry,
            report,
            attestation: attestations[inquiry.stable_item_key] ?? null,
        });

        const entry = {
            stableItemKey: inquiry.stable_item_key,
            bureau: inquiry.bureau,
            furnisher: inquiry.furnisher,
            inquiryDate: inquiry.inquiry_date ?? null,
            ...result,
        };

        (result.eligible ? eligible : blocked).push(entry);
    }

    return {
        schemaVersion: PERMISSIBLE_PURPOSE_SCHEMA_VERSION,
        itemType: ITEM_TYPE.INQUIRY,
        eligible,
        blocked,
        summary: {
            evaluated: (report.inquiries ?? []).length,
            eligibleForDispute: eligible.length,
            verificationRequests: eligible.filter((e) => e.mode === MODE.VERIFICATION_REQUEST).length,
            consumerDisputed: eligible.filter((e) => e.mode === MODE.CONSUMER_DISPUTED).length,
            blocked: blocked.length,
            blockedByAccountRelationship: blocked.filter((b) => b.blockedBy === "FURNISHER_HAS_TRADELINE_ON_REPORT").length,
        },
    };
}

/** Evaluate every bureau tradeline on a report. */
export function evaluateTradelines(report, options = {}) {
    const { mixedFile = false } = options;

    const eligible = [];
    const blocked = [];

    const groups = [
        ...(report.accounts ?? []),
        ...(report.collections ?? []),
    ];

    for (const group of groups) {
        for (const tradeline of group.bureau_tradelines ?? []) {
            const furnisher = tradeline.furnisher ?? group.original_creditor ?? null;

            const result = evaluateTradelinePermissiblePurpose({ tradeline, furnisher, mixedFile });

            const entry = {
                stableItemKey: tradeline.stable_item_key,
                stableAccountKey: group.stable_account_key,
                bureau: tradeline.bureau,
                furnisher,
                ...result,
            };

            (result.eligible ? eligible : blocked).push(entry);
        }
    }

    return {
        schemaVersion: PERMISSIBLE_PURPOSE_SCHEMA_VERSION,
        itemType: ITEM_TYPE.TRADELINE,
        eligible,
        blocked,
        summary: {
            evaluated: eligible.length + blocked.length,
            eligibleForDispute: eligible.length,
            blocked: blocked.length,
            blockedByAuthorizedUser: blocked.filter((b) => b.blockedBy === "AUTHORIZED_USER").length,
            blockedByNoAccountNumber: blocked.filter((b) => b.blockedBy === "NO_BUREAU_ACCOUNT_NUMBER").length,
        },
    };
}
