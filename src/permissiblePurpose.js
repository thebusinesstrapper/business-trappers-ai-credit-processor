/**
 * permissiblePurpose.js
 *
 * BT-DM-0055 — INQUIRY WITHOUT PERMISSIBLE PURPOSE.
 *
 * ===========================================================================
 * THE CENTRAL FACT ABOUT THIS DECISION RECORD
 *
 *   A CREDIT REPORT CANNOT PROVE A LACK OF PERMISSIBLE PURPOSE.
 *
 * An inquiry on the report proves exactly one thing: someone pulled the file.
 * It does not prove they lacked authority to do so, and NOTHING in the report
 * can establish that. The report has no record of whether the consumer applied
 * for credit, signed an authorization, holds an account with the furnisher, or
 * consented to a pull months ago and forgot.
 *
 * ONLY THE CONSUMER KNOWS. Permissible purpose is a fact about the consumer's
 * conduct, and it lives outside the document we are analyzing.
 *
 * This is why UNAUTHORIZED_INQUIRY is deliberately absent from the finding
 * registry, and why this Decision Record is NOT a finding the Analysis Engine
 * may emit. Detecting an inquiry is not detecting a violation.
 *
 * ===========================================================================
 * WHY THIS MATTERS MORE THAN THE OTHER RECORDS
 *
 * Every other dispute in this system says "this reporting is wrong" — a claim
 * about a document. This one says "YOU BROKE THE LAW" — a claim about a named
 * company's conduct, made in the consumer's voice, over her signature.
 *
 * If she DID apply and forgot, we have just accused a lender of a federal
 * violation on the strength of nothing at all. That is not a weak dispute. It is
 * a false accusation, and it is the consumer's name on it, not ours.
 *
 * So this record is NEVER_AUTOMATED. It requires a positive consumer attestation
 * and it does not proceed without one. There is no code path that infers it.
 * ===========================================================================
 */

export const PERMISSIBLE_PURPOSE_SCHEMA_VERSION = "BT-PP-1.0";

export const BT_DM_0055 = Object.freeze({
    record: "BT-DM-0055",
    name: "Inquiry Without Permissible Purpose",

    strategy: "BT-ST-0004",
    strategyName: "Unauthorized Inquiry",

    reason: "BT-RN-0004",
    reasonName: "Unauthorized Hard Inquiry",

    instruction: "BT-IN-0004",
    blueprint: "BT-BP-0004",

    // The consumer is the ONLY source of this fact. Not the report, not the
    // bureau, not inference, not a heuristic.
    evidenceClass: "REQUIRES_CONSUMER",
    automationTier: "NEVER_AUTOMATED",

    authority:
        "FCRA § 604 (15 U.S.C. § 1681b) — a consumer report may be furnished only for a permissible purpose.",

    // Round eligibility: this is a FIRST-CLASS INITIAL DISPUTE, not an
    // escalation. Once the consumer attests, the fact is as strong on round 1 as
    // it will ever be — it does not ripen with time, and withholding it until a
    // later round would simply delay a valid dispute.
    roundEligibility: "1-5 (initial disputes onward, once attested)",
    escalationOnly: false,
});

/**
 * THE TRIGGERING CONDITIONS. All must hold. Conjunctive — AND, never OR.
 */
export const REQUIRED_CONDITIONS = Object.freeze([
    "The inquiry is a HARD inquiry (a soft inquiry is not reportable to lenders and is not disputable on this ground).",
    "The consumer has POSITIVELY ATTESTED that she did not apply for credit with this furnisher, did not authorize the pull, and has no account relationship with them.",
    "The attestation identifies THIS furnisher and THIS inquiry — not a general statement that 'some inquiries look wrong'.",
    "The furnisher does NOT appear as a tradeline on the consumer's own report (see PROHIBITED below).",
    "The inquiry is within the reporting period (a stale inquiry is BT-DM-0052, a different record with a different, compliance-gated basis).",
]);

/**
 * WHEN IT IS PROHIBITED. Any one of these is a hard stop.
 */
export const PROHIBITED_WHEN = Object.freeze([
    {
        condition: "NO_CONSUMER_ATTESTATION",
        rule: "The consumer has not attested. The processor NEVER infers a lack of permissible purpose from the report.",
        why:
            "The report cannot establish this fact. Asserting it without the consumer would be " +
            "inventing a fact in her name — and accusing a named company of a federal violation on " +
            "the strength of nothing.",
    },
    {
        condition: "FURNISHER_HAS_TRADELINE_ON_REPORT",
        rule: "The furnisher appears as an account on the consumer's own credit report.",
        why:
            "An existing account relationship is strong evidence of permissible purpose — account " +
            "review is expressly permitted under § 604. If CHASE has a tradeline on her report, a " +
            "CHASE inquiry is very likely lawful. Disputing it would be a false accusation against " +
            "the consumer's own creditor, and the bureau will verify it against the account it can " +
            "plainly see. This gate FIRES EVEN IF THE CONSUMER ATTESTS — a consumer who forgot she " +
            "holds the account is exactly the case this catches, and the report contradicts her.",
    },
    {
        condition: "SOFT_INQUIRY",
        rule: "The inquiry is soft (promotional, account review, or consumer-initiated).",
        why: "Soft inquiries do not require the same purpose and are not visible to lenders. There is nothing to dispute.",
    },
    {
        condition: "BLANKET_DISPUTE",
        rule: "The request is to dispute all inquiries, or inquiries as a category.",
        why:
            "Permissible purpose is a fact about ONE pull by ONE furnisher. A blanket inquiry sweep " +
            "is not a dispute strategy — it is a guess repeated at scale, and it destroys credibility " +
            "with the bureau for the disputes that are real.",
    },
    {
        condition: "AGE_BASED_REASONING",
        rule: "The dispute rests on the inquiry's age rather than on its authority.",
        why:
            "Age is BT-DM-0052, which is compliance-gated and may not assert illegality. Permissible " +
            "purpose is about AUTHORITY, not TIME. Conflating them would smuggle a gated assertion " +
            "through an ungated record.",
    },
]);

/**
 * FURNISHER ALIAS TABLE — USED ONLY TO BLOCK A DISPUTE. NEVER TO RAISE ONE.
 *
 * The Extraction System forbids seeding the alias table with guesses, because
 * there a wrong alias MERGES two accounts and silently corrupts dispute memory.
 *
 * HERE THE ASYMMETRY RUNS THE OTHER WAY, and it is worth being explicit about:
 *
 *   A false POSITIVE (we wrongly think Chase holds an account) costs us ONE
 *   dispute we could have raised. Recoverable, and a human sees it.
 *
 *   A false NEGATIVE (we miss the relationship) sends a letter accusing the
 *   consumer's own credit card issuer of a federal violation — verifiable by the
 *   bureau against the account sitting on the same report.
 *
 * Those costs are nowhere near equal. So in the BLOCKING direction we may be
 * generous, and we are. This table exists ONLY to stop disputes. It can never
 * cause one.
 *
 * Discovered by test: "JPMCB CARD SERVICES" (the inquiry) and "CHASE BANK USA NA"
 * (the tradeline) are the same company. Suffix-stripping compares JPMCB against
 * CHASE and finds nothing — the gate silently failed open.
 */
const FURNISHER_ALIASES = Object.freeze([
    ["CHASE", "JPMCB", "JPMORGAN", "JP MORGAN"],
    ["CITI", "CITIBANK", "CBNA", "CITICARDS"],
    ["CAPITAL ONE", "CAP ONE", "CAPONE"],
    ["AMERICAN EXPRESS", "AMEX"],
    ["DISCOVER", "DISCOVER FINANCIAL", "DFS"],
    ["SYNCHRONY", "SYNCB", "SYNCHRONY BANK"],
    ["BANK OF AMERICA", "BOFA", "BANK AMERICA", "BK OF AMER"],
    ["WELLS FARGO", "WF", "WELLS FARGO BANK"],
    ["NAVY FEDERAL", "NAVY FCU", "NFCU"],
    ["US BANK", "USBANK", "US BK"],
    ["TD BANK", "TD BANK USA", "TDBANK"],
    ["BARCLAYS", "BARCLAYCARD", "BARCLAYS BANK DELAWARE"],
    ["GOLDMAN SACHS", "APPLE CARD", "GS BANK"],
]);

/** The alias GROUP a furnisher belongs to, or null. */
function aliasGroup(normalised) {
    for (const group of FURNISHER_ALIASES) {
        for (const alias of group) {
            if (normalised === alias || normalised.includes(alias) || alias.includes(normalised)) {
                return group[0]; // canonical
            }
        }
    }
    return null;
}

/** Normalise a furnisher name enough to compare it against tradelines. */
function normaliseFurnisher(name) {
    return String(name ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, "")
        .replace(/\b(NA|N A|INC|LLC|CORP|BANK USA|CARD SERVICES|BANK|USA)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Does this furnisher already hold an account on the consumer's report?
 *
 * Deliberately GENEROUS in what it treats as a match. A false positive here
 * costs us one dispute we could have raised. A false NEGATIVE produces a false
 * accusation against the consumer's own creditor. Those costs are not close, so
 * we err toward finding a relationship.
 */
export function furnisherHasTradeline(furnisher, report) {
    const target = normaliseFurnisher(furnisher);
    if (!target) return false;

    const groups = [...(report.accounts ?? []), ...(report.collections ?? [])];

    for (const group of groups) {
        for (const tradeline of group.bureau_tradelines ?? []) {
            const candidate = normaliseFurnisher(tradeline.furnisher);
            if (!candidate) continue;

            if (
                candidate === target ||
                candidate.includes(target) ||
                target.includes(candidate)
            ) {
                return true;
            }

            // Alias match. Blocking-only, so generosity here is safe.
            const targetGroup = aliasGroup(target);
            const candidateGroup = aliasGroup(candidate);

            if (targetGroup && candidateGroup && targetGroup === candidateGroup) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Evaluate ONE inquiry against BT-DM-0055.
 *
 * FAILS CLOSED at every gate.
 *
 * @param {object} ctx
 * @param {object} ctx.inquiry       the inquiry from the BT Credit Report Model
 * @param {object} ctx.report        the full report (to check for a tradeline relationship)
 * @param {object} ctx.attestation   the CONSUMER's statement about THIS inquiry, or null
 *
 * attestation shape:
 *   {
 *     stableItemKey: string,      // must match THIS inquiry
 *     didNotApply: true,
 *     didNotAuthorize: true,
 *     noAccountRelationship: true,
 *     attestedAt: ISO8601,
 *     attestedBy: "consumer"
 *   }
 */
export function evaluatePermissiblePurpose(ctx) {
    const { inquiry, report, attestation = null } = ctx;

    const blocked = (condition, detail) => ({
        eligible: false,
        record: BT_DM_0055.record,
        blockedBy: condition,
        reason: detail,
    });

    // ---- GATE 1: soft inquiries are not disputable on this ground ----------
    if (/soft|promotional|account\s*review|prescreen|consumer/i.test(String(inquiry.inquiry_type ?? ""))) {
        return blocked(
            "SOFT_INQUIRY",
            `Inquiry type "${inquiry.inquiry_type}" is soft. Soft inquiries are not visible to lenders ` +
                `and do not carry the same permissible-purpose requirement. Nothing to dispute.`
        );
    }

    // ---- GATE 2: THE CONSUMER MUST HAVE SPOKEN -----------------------------
    //
    // This is the gate that matters. No attestation, no dispute. There is no
    // inference, no heuristic, and no "the furnisher looks unfamiliar" shortcut.
    if (!attestation) {
        return blocked(
            "NO_CONSUMER_ATTESTATION",
            `No consumer attestation exists for this inquiry (${inquiry.furnisher}). A credit report ` +
                `cannot establish a lack of permissible purpose — it records only that a pull occurred, ` +
                `never whether it was authorized. Only the consumer knows. The processor does not infer ` +
                `this, and it will not assert it.`
        );
    }

    if (attestation.stableItemKey !== inquiry.stable_item_key) {
        return blocked(
            "NO_CONSUMER_ATTESTATION",
            `The attestation on file does not identify this specific inquiry. A general statement that ` +
                `"some inquiries look wrong" is not an attestation about THIS furnisher.`
        );
    }

    const complete =
        attestation.didNotApply === true &&
        attestation.didNotAuthorize === true &&
        attestation.noAccountRelationship === true;

    if (!complete) {
        return blocked(
            "NO_CONSUMER_ATTESTATION",
            `The attestation is incomplete. All three must be affirmed: did not apply, did not ` +
                `authorize, and no account relationship. A partial attestation does not support the claim.`
        );
    }

    // ---- GATE 3: THE REPORT MAY CONTRADICT THE CONSUMER --------------------
    //
    // Deliberately AFTER the attestation, and deliberately able to OVERRIDE it.
    //
    // A consumer who has forgotten she holds a Chase card will attest in perfect
    // good faith that Chase had no right to pull her. The report says otherwise,
    // in a way the bureau can see at a glance. Filing that dispute would accuse
    // her own creditor of a federal violation, and it would be verified against
    // the account sitting on the same report.
    //
    // We trust the consumer about her own conduct. We do not let a good-faith
    // memory lapse turn into a false accusation.
    if (furnisherHasTradeline(inquiry.furnisher, report)) {
        return blocked(
            "FURNISHER_HAS_TRADELINE_ON_REPORT",
            `The consumer attested, but ${inquiry.furnisher} ALSO APPEARS AS AN ACCOUNT on her own ` +
                `credit report. An existing account relationship is strong evidence of permissible ` +
                `purpose (account review is expressly permitted under § 604). This is routed to a human: ` +
                `the consumer may have forgotten the account, or the account may be one she disputes. ` +
                `Either way, the processor will not accuse her own creditor on this record.`
        );
    }

    // ---- ELIGIBLE ----------------------------------------------------------
    return {
        eligible: true,
        record: BT_DM_0055.record,
        name: BT_DM_0055.name,
        strategy: BT_DM_0055.strategy,
        reason: BT_DM_0055.reason,
        instruction: BT_DM_0055.instruction,
        blueprint: BT_DM_0055.blueprint,

        evidenceClass: BT_DM_0055.evidenceClass,
        automationTier: BT_DM_0055.automationTier,

        // NEVER automated. Even fully attested and fully clear, a human signs off
        // — because the letter accuses a named company of a federal violation.
        humanReview: true,
        humanReviewReason:
            "BT-DM-0055 asserts that a named company pulled this consumer's file without permissible " +
            "purpose. That is an accusation of a federal violation, made in her voice. It is never " +
            "sent without a human reading it.",

        attestation: {
            attestedAt: attestation.attestedAt ?? null,
            attestedBy: attestation.attestedBy ?? "consumer",
        },

        // WHAT THIS CHECK CANNOT DO.
        //
        // Finding no matching tradeline is NOT proof that no relationship exists.
        // Furnisher naming varies wildly across bureaus, the alias table is
        // necessarily incomplete, and a closed or paid account may not appear at
        // all. We can find a relationship; we cannot prove its absence.
        //
        // This is precisely why BT-DM-0055 is NEVER_AUTOMATED. The human reading
        // this letter is the backstop for the relationship we did not spot — and
        // that is a deliberate design, not a gap.
        relationshipCheck: {
            matchFound: false,
            provesAbsence: false,
            note:
                "No matching tradeline was found — but this does NOT prove the consumer has no " +
                "relationship with this furnisher. Bureau naming varies, the alias table is " +
                "incomplete, and closed accounts may not appear. A human must confirm before this " +
                "accusation is sent.",
        },

        reasoningChain: [
            `INQUIRY: ${inquiry.furnisher} (${inquiry.bureau}), dated ${inquiry.inquiry_date ?? "unknown"}.`,
            `CONSUMER ATTESTATION: did not apply, did not authorize, no account relationship.`,
            `REPORT CHECK: no tradeline matching ${inquiry.furnisher} was found. This does NOT prove no relationship exists — it only means we did not find one.`,
            `DECISION: ${BT_DM_0055.record} (${BT_DM_0055.name}).`,
            `EVIDENCE: REQUIRES_CONSUMER — this fact came from the consumer, never from the report.`,
            `AUTHORITY: ${BT_DM_0055.authority}`,
        ],
    };
}

/**
 * Evaluate every inquiry on a report.
 *
 * @param {object} report
 * @param {object} attestations  { [stable_item_key]: attestation }
 */
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
            blocked: blocked.length,
            blockedByNoAttestation: blocked.filter((b) => b.blockedBy === "NO_CONSUMER_ATTESTATION").length,
            blockedByAccountRelationship: blocked.filter(
                (b) => b.blockedBy === "FURNISHER_HAS_TRADELINE_ON_REPORT"
            ).length,
        },
    };
}
