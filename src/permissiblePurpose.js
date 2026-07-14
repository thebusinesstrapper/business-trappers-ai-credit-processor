/**
 * permissiblePurpose.js
 *
 * BT-DM-0055 — PERMISSIBLE PURPOSE VERIFICATION.
 * A first-class Business Trappers dispute strategy.
 *
 * ===========================================================================
 * WE REQUEST. WE DO NOT ACCUSE.
 *
 * The earlier design of this record required a consumer attestation before it
 * could run, because it was framed as an ASSERTION — "this company had no
 * permissible purpose" — and a credit report cannot prove that. Only the
 * consumer knows whether she applied, and asserting it without her would invent
 * a fact in her name.
 *
 * The Business Trappers framing dissolves that problem entirely, and it does so
 * without weakening the dispute:
 *
 *   WE DO NOT SAY:  "You had no permissible purpose to pull my file."
 *                   -> An accusation of a federal violation. Unproven. And if
 *                      she applied and forgot, it is FALSE.
 *
 *   WE SAY:         "Please verify and provide the permissible purpose under
 *                    which this inquiry was made."
 *                   -> A REQUEST. It asserts nothing at all, so nothing in it
 *                      can be false — and it puts the burden exactly where FCRA
 *                      § 604 already places it: on the party that furnished the
 *                      report.
 *
 * The second is not the weaker move. It is the stronger one. An accusation we
 * cannot support invites a one-line denial. A request for verification obliges
 * the bureau to actually go and check — which is the outcome we wanted from an
 * accusation anyway, minus the risk of being wrong in the consumer's name.
 *
 * The Constitutional rule survives intact: THE PROCESSOR NEVER ASSERTS AN
 * UNPROVEN FACT. It just turns out we never needed to.
 * ===========================================================================
 */

export const PERMISSIBLE_PURPOSE_SCHEMA_VERSION = "BT-PP-2.0";

export const BT_DM_0055 = Object.freeze({
    record: "BT-DM-0055",
    name: "Permissible Purpose Verification",

    strategy: "BT-ST-0004",
    strategyName: "Unauthorized Inquiry",

    reason: "BT-RN-0004",
    reasonName: "Unauthorized Hard Inquiry",

    instruction: "BT-IN-0004",
    blueprint: "BT-BP-0004",

    authority:
        "FCRA § 604 (15 U.S.C. § 1681b) — a consumer report may be furnished only for a permissible purpose.",

    // First-class initial dispute. It does not ripen with time: the request is
    // exactly as valid on round 1 as it will ever be.
    roundEligibility: "1-5",
    escalationOnly: false,
});

/**
 * TWO MODES. Both REQUEST. Neither ACCUSES.
 */
export const MODE = Object.freeze({
    // No consumer statement. We ask the bureau to verify its permissible purpose.
    // Asserts nothing whatsoever, so nothing in it can be untrue.
    VERIFICATION_REQUEST: "VERIFICATION_REQUEST",

    // The consumer has stated she did not apply or authorize. That statement is
    // HER fact and she is entitled to make it — but we still REQUEST verification
    // rather than declaring the inquiry unlawful. The legal conclusion is not
    // ours to draw.
    CONSUMER_DISPUTED: "CONSUMER_DISPUTED",
});

/**
 * FURNISHER ALIAS TABLE — BLOCKING ONLY. It can never cause a dispute.
 *
 * The asymmetry: a false positive costs us one low-value dispute. A false
 * negative sends the consumer's own credit card issuer a demand to justify an
 * inquiry it plainly had every right to make — on a report that shows the
 * account. That is a wasted round and it discredits the letters that matter.
 *
 * Discovered by test: "JPMCB CARD SERVICES" (inquiry) and "CHASE BANK USA NA"
 * (tradeline) are the same company; suffix-stripping compares JPMCB to CHASE and
 * silently finds nothing.
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

/** Does this furnisher already hold an account on the consumer's report? */
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
            if (targetGroup && candidateGroup && targetGroup === candidateGroup) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Evaluate ONE inquiry.
 *
 * @param {object} ctx
 * @param {object} ctx.inquiry      inquiry from the BT Credit Report Model
 * @param {object} ctx.report       the full report (to check for a relationship)
 * @param {object} [ctx.attestation] optional consumer statement about THIS inquiry
 */
export function evaluatePermissiblePurpose(ctx) {
    const { inquiry, report, attestation = null } = ctx;

    const blocked = (blockedBy, reason) => ({
        eligible: false,
        record: BT_DM_0055.record,
        blockedBy,
        reason,
    });

    // ---- Soft inquiries are not visible to lenders. Nothing to dispute. -----
    if (/soft|promotional|prescreen|account\s*review|consumer[- ]initiated/i.test(String(inquiry.inquiry_type ?? ""))) {
        return blocked(
            "SOFT_INQUIRY",
            `Inquiry type "${inquiry.inquiry_type}" is soft. Soft inquiries are not disclosed to ` +
                `lenders and do not affect the consumer. There is nothing of value to dispute.`
        );
    }

    // ---- The consumer's own creditor ---------------------------------------
    //
    // Not a truth problem — a CREDIBILITY problem. Asking a bureau to justify a
    // Chase inquiry when a Chase account is sitting on the same report gets a
    // one-line answer and teaches the bureau to skim our letters. We spend the
    // consumer's credibility on the disputes that can actually win.
    if (furnisherHasTradeline(inquiry.furnisher, report)) {
        return blocked(
            "FURNISHER_HAS_TRADELINE_ON_REPORT",
            `${inquiry.furnisher} appears as an account on this consumer's own credit report. An ` +
                `existing account relationship is a permissible purpose on its face (account review is ` +
                `expressly permitted under § 604), so this request would be answered in one line and ` +
                `would cost credibility on the disputes that matter. Routed to a human, who may know ` +
                `something the report does not show.`
        );
    }

    // ---- ELIGIBLE ----------------------------------------------------------
    const mode = isCompleteAttestation(attestation, inquiry)
        ? MODE.CONSUMER_DISPUTED
        : MODE.VERIFICATION_REQUEST;

    return {
        eligible: true,
        record: BT_DM_0055.record,
        name: BT_DM_0055.name,
        mode,

        strategy: BT_DM_0055.strategy,
        reason: BT_DM_0055.reason,
        instruction: BT_DM_0055.instruction,
        blueprint: BT_DM_0055.blueprint,
        authority: BT_DM_0055.authority,

        // NEVER an assertion that permissible purpose was absent. This is the
        // invariant the whole record turns on, and it is machine-checkable.
        assertsLackOfPermissiblePurpose: false,

        // Every inquiry dispute is read by a human before it goes out. The letter
        // names a company and asks it to justify itself; that is worth a glance.
        humanReview: true,
        humanReviewReason:
            "This letter asks a named company to verify the permissible purpose for pulling the " +
            "consumer's file. It asserts no violation, but it does put a company on the spot in her " +
            "name, so a human reads it first.",

        attestation: attestation
            ? { attestedAt: attestation.attestedAt ?? null, attestedBy: attestation.attestedBy ?? "consumer" }
            : null,

        reasoningChain: [
            `INQUIRY: ${inquiry.furnisher} (${inquiry.bureau}), dated ${inquiry.inquiry_date ?? "unknown"}.`,
            `RELATIONSHIP CHECK: no matching tradeline found on this report.`,
            mode === MODE.CONSUMER_DISPUTED
                ? `CONSUMER STATEMENT: she states she did not apply for credit with this company and did not authorize the inquiry.`
                : `NO CONSUMER STATEMENT: the letter therefore REQUESTS verification and asserts nothing.`,
            `DECISION: ${BT_DM_0055.record} (${BT_DM_0055.name}).`,
            `THE LETTER REQUESTS VERIFICATION OF PERMISSIBLE PURPOSE. It does NOT assert that permissible purpose was absent — the processor has not established that, and § 604 places the duty on the furnishing party regardless.`,
            `AUTHORITY: ${BT_DM_0055.authority}`,
        ],
    };
}

function isCompleteAttestation(attestation, inquiry) {
    if (!attestation) return false;
    if (attestation.stableItemKey !== inquiry.stable_item_key) return false;

    return (
        attestation.didNotApply === true &&
        attestation.didNotAuthorize === true &&
        attestation.noAccountRelationship === true
    );
}

/**
 * THE LETTER TEXT.
 *
 * Both modes REQUEST. Neither concludes.
 *
 * Note what the CONSUMER_DISPUTED wording does and does not do. It reports HER
 * statement — a fact she is entitled to state, and which is true (she did say
 * it). It does not convert her statement into OUR legal conclusion. She says she
 * did not apply; we ask the bureau to verify. The bureau draws the conclusion.
 */
export function letterTextFor(evaluation) {
    if (evaluation.mode === MODE.CONSUMER_DISPUTED) {
        return {
            defect:
                "I did not apply for credit with this company and did not authorize them to access my " +
                "credit file.",
            request:
                "Please verify the permissible purpose under which this inquiry was made and provide " +
                "me with that verification. If a permissible purpose cannot be verified, please remove " +
                "this inquiry from my credit file.",
        };
    }

    return {
        defect: "I do not recognize this inquiry on my credit file.",
        request:
            "Please verify the permissible purpose under which my credit file was furnished to this " +
            "company and provide me with that verification. If a permissible purpose cannot be " +
            "verified, please remove this inquiry from my credit file.",
    };
}

/** Evaluate every inquiry on a report. */
export function evaluateInquiries(report, attestations = {}) {
    const eligible = [];
    const blocked = [];

    for (const inquiry of report.inquiries ?? []) {
        const result = evaluatePermissiblePurpose({
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
        record: BT_DM_0055.record,
        eligible,
        blocked,
        summary: {
            inquiriesEvaluated: (report.inquiries ?? []).length,
            eligibleForDispute: eligible.length,
            verificationRequests: eligible.filter((e) => e.mode === MODE.VERIFICATION_REQUEST).length,
            consumerDisputed: eligible.filter((e) => e.mode === MODE.CONSUMER_DISPUTED).length,
            blocked: blocked.length,
            blockedByAccountRelationship: blocked.filter(
                (b) => b.blockedBy === "FURNISHER_HAS_TRADELINE_ON_REPORT"
            ).length,
        },
    };
}
