/**
 * decisionRecords.js
 *
 * Two things live here, and they are DELIBERATELY SEPARATE:
 *
 *   1. EVIDENCE CLASSIFICATION  — STABLE ARCHITECTURE.
 *      What KIND of evidence supports a fact. This is a taxonomy, not a
 *      measurement, and it does not change as the business learns.
 *
 *   2. AUTOMATION POLICY        — PROVISIONAL. EXPECTED TO CHANGE.
 *      How much autonomy Business Trappers is willing to grant each evidence
 *      class TODAY. This is a business decision, revisable as production
 *      outcomes accumulate.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE NO CONFIDENCE PERCENTAGES HERE ANY MORE
 *
 * An earlier version scored evidence as SELF_EVIDENT = 97, CROSS_BUREAU = 92,
 * and so on. Those numbers were invented. Nothing in this system has ever
 * measured how often a Metro 2 contradiction results in a deletion.
 *
 * A number like "97%" LOOKS like a probability, and everything downstream would
 * have started treating it as one — comparing it, averaging it, putting it in
 * front of Kris as though it meant something. It would have been a fabricated
 * statistic wearing the costume of a measurement, and the whole system is built
 * on not doing that.
 *
 * So: evidence has a CLASS and an ORDINAL RANK (for "which evidence is
 * stronger"), and policy maps class -> automation tier. Ordering is a real
 * thing we can defend. A probability is not, until we have measured one.
 * ---------------------------------------------------------------------------
 */

// ===========================================================================
// 1. EVIDENCE CLASSIFICATION — STABLE
// ===========================================================================

/**
 * `rank` is ORDINAL ONLY. It answers "which of these two facts rests on
 * stronger evidence?" It is NOT a probability, NOT a percentage, and must never
 * be summed, averaged, or displayed as a confidence score.
 */
export const EVIDENCE_CLASS = Object.freeze({

    SELF_EVIDENT: {
        id: "SELF_EVIDENT",
        rank: 5,
        label: "Self-evident",
        definition:
            "The bureau's own record contradicts itself, or contradicts the law on its face. " +
            "No external reference is required, and the bureau cannot dispute its own data.",
    },

    HISTORICAL: {
        id: "HISTORICAL",
        rank: 4,
        label: "Historical",
        definition:
            "Established by comparing two Business Trappers report snapshots. The change is " +
            "documented in our own persisted history and is independently verifiable.",
    },

    IDENTITY: {
        id: "IDENTITY",
        rank: 3,
        label: "Identity",
        definition:
            "Established by comparison against the CRC client profile, which is authoritative " +
            "for consumer identity.",
    },

    CROSS_BUREAU: {
        id: "CROSS_BUREAU",
        rank: 2,
        label: "Cross-bureau",
        definition:
            "Bureaus report conflicting values for the same account. At least one is inaccurate — " +
            "but the report does not establish WHICH. That irreducible uncertainty is why this " +
            "ranks below a self-evident contradiction.",
    },

    CIRCUMSTANTIAL: {
        id: "CIRCUMSTANTIAL",
        rank: 1,
        label: "Circumstantial",
        definition:
            "The pattern is consistent with an inaccuracy but is not established by the report " +
            "alone. It is an observation, not a proof.",
    },

    // THE CONSUMER'S RIGHT TO DISPUTE — not a claim about the facts.
    //
    // Distinct from every other class here, which grade EVIDENCE OF A DEFECT.
    // This one asserts no defect at all. It records that the consumer disputes
    // the completeness and accuracy of the reporting and asks for a reasonable
    // reinvestigation — a right FCRA §611 grants WITHOUT any requirement to
    // prove error first.
    //
    // The letter it produces must therefore never say the item IS inaccurate,
    // false, or unverifiable. It says the consumer DISPUTES it. That statement
    // is true by construction, and it is the only one we are entitled to make.
    CONSUMER_DISPUTE: {
        id: "CONSUMER_DISPUTE",
        rank: 1,
        label: "Consumer dispute (no defect asserted)",
        definition:
            "The consumer exercises the FCRA §611 right to dispute completeness and accuracy. " +
            "No defect is alleged and none needs to be.",
    },

    // "WE CANNOT TELL." Distinct from CIRCUMSTANTIAL — that is weak evidence FOR
    // something. This is the ABSENCE of the evidence an assertion would require.
    //
    // A missing DOFD does not make an item weakly obsolete. It makes obsolescence
    // UNKNOWABLE, and an unknowable claim is not a weak claim — it is no claim.
    INDETERMINATE: {
        id: "INDETERMINATE",
        rank: 0,
        label: "Indeterminate",
        definition:
            "The report does not contain the information an assertion would require. Nothing is " +
            "claimed; the item is routed to a human.",
    },

    REQUIRES_CONSUMER: {
        id: "REQUIRES_CONSUMER",
        rank: 0,
        label: "Requires consumer",
        definition:
            "The fact cannot be established without information only the consumer holds. It is " +
            "never asserted and never automated.",
    },
});

// ===========================================================================
// 2. AUTOMATION POLICY — PROVISIONAL
// ===========================================================================

export const AUTOMATION_TIER = Object.freeze({
    FULL_AUTOMATION: "FULL_AUTOMATION",
    AUTOMATED_WITH_VALIDATION: "AUTOMATED_WITH_VALIDATION",
    PROCESSOR_REVIEW: "PROCESSOR_REVIEW",
    HUMAN_REVIEW_REQUIRED: "HUMAN_REVIEW_REQUIRED",
    NEVER_AUTOMATED: "NEVER_AUTOMATED",
});

// ---- GOVERNED AUTOMATION TIERS (authoritative) --------------------------
// The Master Governance Matrix v1.0 assigns an automation tier PER DECISION,
// not per evidence class. These five governed names are the authoritative
// tiers; the evidence-class policy below is retained only as a provisional
// fallback for any decision not present in the governed map.
export const GOVERNED_TIER = Object.freeze({
    CONSUMER_INPUT: "CONSUMER_INPUT",
    VALIDATED_AUTOMATION: "VALIDATED_AUTOMATION",
    REVIEW_DEFAULT: "REVIEW_DEFAULT",
    HUMAN_REVIEW: "HUMAN_REVIEW",
    NO_ACTION: "NO_ACTION",
});

const TIER_BY_DECISION = Object.freeze({
    // GOVERNED per-decision automation tier — Master Governance Matrix v1.0 /
    // Code Alignment Map v1.0. Replaces evidence-class-derived tiering.
    // BT-DM-0001 v2.1 ADDENDUM — Permissible-Purpose Inquiry Evaluation.
    //
    // The Addendum changes this record's Automation Mapping to VALIDATED_AUTOMATION
    // where the account-matching rule is satisfied. The ONLY finding that reaches
    // this record is INQ_NO_ASSOCIATED_ACCOUNT, which is that rule's positive
    // result — a report-derived fact requiring no consumer-held knowledge.
    //
    // The unresolved case never arrives here: INQ_AUTHORIZATION_UNVERIFIABLE
    // carries record:null and routes to consumer input ahead of any tier lookup,
    // so BT-DM-0001's original CONSUMER_INPUT posture survives exactly where the
    // Addendum says it should.
    "BT-DM-0001": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0002": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0003": GOVERNED_TIER.HUMAN_REVIEW,
    "BT-DM-0004": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0005": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0006": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0007": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0008": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0009": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0010": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0011": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0012": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0013": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0014": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0015": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0016": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0017": GOVERNED_TIER.CONSUMER_INPUT,
    "BT-DM-0018": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0019": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0020": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0021": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0022": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0023": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0024": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0025": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0026": GOVERNED_TIER.HUMAN_REVIEW,
    "BT-DM-0027": GOVERNED_TIER.HUMAN_REVIEW,
    "BT-DM-0028": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0029": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0030": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0031": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0032": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0033": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0034": GOVERNED_TIER.VALIDATED_AUTOMATION,
    "BT-DM-0035": GOVERNED_TIER.HUMAN_REVIEW,
    "BT-DM-0036": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0037": GOVERNED_TIER.HUMAN_REVIEW,
    "BT-DM-0038": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0039": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0040": GOVERNED_TIER.HUMAN_REVIEW,
    "BT-DM-0041": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0042": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0043": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0044": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0045": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0046": GOVERNED_TIER.HUMAN_REVIEW,
    "BT-DM-0047": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0048": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0049": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0050": GOVERNED_TIER.NO_ACTION,
    "BT-DM-0051": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0052": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0053": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0054": GOVERNED_TIER.REVIEW_DEFAULT,
    "BT-DM-0055": GOVERNED_TIER.CONSUMER_INPUT,
});

/**
 * PROVISIONAL POLICY — v1, pre-production.
 *
 * This table WILL change. Every entry is a business judgement about how much
 * autonomy to grant, made BEFORE any outcome data exists. It is versioned so a
 * decision made under one policy can be explained later, even after the policy
 * has moved.
 *
 * Changing this table changes system behaviour and requires explicit approval.
 * It does NOT require touching the evidence taxonomy above.
 */
export const AUTOMATION_POLICY = Object.freeze({
    version: "BT-AUTOMATION-POLICY-v1",
    status: "PROVISIONAL — not derived from outcome data. Revise as production evidence accumulates.",

    byEvidenceClass: Object.freeze({
        SELF_EVIDENT:      AUTOMATION_TIER.FULL_AUTOMATION,
        HISTORICAL:        AUTOMATION_TIER.FULL_AUTOMATION,
        IDENTITY:          AUTOMATION_TIER.AUTOMATED_WITH_VALIDATION,
        CROSS_BUREAU:      AUTOMATION_TIER.AUTOMATED_WITH_VALIDATION,
        CONSUMER_DISPUTE:  AUTOMATION_TIER.AUTOMATED_WITH_VALIDATION,
        CIRCUMSTANTIAL:    AUTOMATION_TIER.PROCESSOR_REVIEW,
        INDETERMINATE:     AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED,
        REQUIRES_CONSUMER: AUTOMATION_TIER.NEVER_AUTOMATED,
    }),
});

/**
 * Policy overrides. These DEMOTE; they never promote.
 *
 * A rule that could raise autonomy would let a strong-looking signal talk the
 * system into acting. Overrides only ever make us more cautious.
 */
export const POLICY_OVERRIDES = Object.freeze({
    MIXED_FILE: {
        tier: AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED,
        reason:
            "A mixed file means findings on this tradeline may describe ANOTHER CONSUMER'S account. " +
            "Disputing item-level details would implicitly assert the account is the client's — " +
            "confirming data that may not be theirs, and undermining the mixed-file claim itself.",
    },

    UNMAPPED_FINDING: {
        tier: AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED,
        reason: "One or more findings have no governing Decision Record.",
    },

    COMPLIANCE_GATED: {
        tier: AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED,
        reason:
            "This Decision Record is compliance-gated. It may be detected and routed, but no " +
            "automated letter may assert the legal conclusion behind it until the basis and wording " +
            "are reviewed.",
    },

    EXCLUSIONS_UNVERIFIABLE: {
        tier: AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED,
        reason:
            "The Constitutional exclusions (authorized user, positive account) could not be checked. " +
            "We do not dispute an account we cannot verify we are allowed to dispute.",
    },
});

/**
 * COMPLIANCE GATES.
 *
 * A gated Decision Record may be DETECTED and ROUTED, but no automated letter
 * may assert the legal conclusion behind it until counsel approves the basis and
 * the wording.
 *
 * This is stronger than "needs review". It constrains WHAT MAY BE SAID, not just
 * who signs off — the restriction travels with the item all the way into the
 * Letter Engine, which must refuse to write the forbidden assertion.
 */
export const COMPLIANCE_GATES = Object.freeze({
    "BT-DM-0052": {
        record: "BT-DM-0052",
        name: "Obsolete Inquiry Reporting",
        blocked: true,
        reason:
            "The two-year figure for hard inquiries is largely BUREAU PRACTICE, not a clean statutory " +
            "obsolescence right of the kind FCRA §605 provides for derogatory accounts. FCRA's explicit " +
            "two-year limit is written with respect to inquiries for EMPLOYMENT purposes.",
        forbiddenAssertions: [
            "that the inquiry's age makes it unlawful",
            "that deletion is legally required on the basis of age alone",
            "any citation of permissible purpose (§1681b) — that is BT-DM-0001 and needs a fact we do not have",
        ],
        permittedAssertions: [
            "that the inquiry is more than two years old",
            "a request that the bureau verify the inquiry remains properly reportable",
        ],
        clearedBy: "Pending review of the legal basis and approved wording.",
    },
});

export function complianceGateFor(record) {
    return COMPLIANCE_GATES[record] ?? null;
}

const TIER_RANK = Object.freeze({
    // Legacy evidence-class tiers (retained for the provisional fallback path).
    FULL_AUTOMATION: 4,
    AUTOMATED_WITH_VALIDATION: 3,
    PROCESSOR_REVIEW: 2,
    HUMAN_REVIEW_REQUIRED: 1,
    NEVER_AUTOMATED: 0,
    // GOVERNED tiers (Master Governance Matrix v1.0), ranked so overrides still
    // DEMOTE correctly. Higher = more autonomy. HUMAN_REVIEW and NO_ACTION are the
    // most restrictive; VALIDATED_AUTOMATION is the highest governed autonomy.
    VALIDATED_AUTOMATION: 3,
    REVIEW_DEFAULT: 2,
    CONSUMER_INPUT: 1,
    HUMAN_REVIEW: 1,
    NO_ACTION: 0,
});

export function automationTierFor(decisionRecordId, evidenceClassId = null) {
    // GOVERNED-FIRST: the per-decision tier from the Master Governance Matrix is
    // authoritative. If a decision is not governed (should not happen for
    // production-reachable decisions), fall back to the provisional evidence-class
    // policy, then to the most cautious tier. This never PROMOTES autonomy.
    const governed = TIER_BY_DECISION[decisionRecordId];
    if (governed) return governed;
    if (evidenceClassId) {
        return AUTOMATION_POLICY.byEvidenceClass[evidenceClassId] ?? AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED;
    }
    return AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED;
}

/** Overrides demote only. Returns the MORE cautious of the two tiers. */
export function applyOverride(tier, overrideTier) {
    return TIER_RANK[overrideTier] < TIER_RANK[tier] ? overrideTier : tier;
}

export function requiresHumanReview(tier) {
    // Legacy evidence-class tiers.
    if (tier === AUTOMATION_TIER.PROCESSOR_REVIEW ||
        tier === AUTOMATION_TIER.HUMAN_REVIEW_REQUIRED ||
        tier === AUTOMATION_TIER.NEVER_AUTOMATED) return true;
    // GOVERNED tiers that require a human before anything proceeds. VALIDATED_AUTOMATION
    // and REVIEW_DEFAULT permit a draft; HUMAN_REVIEW and CONSUMER_INPUT do not, and
    // NO_ACTION produces no dispute at all.
    if (tier === GOVERNED_TIER.HUMAN_REVIEW ||
        tier === GOVERNED_TIER.CONSUMER_INPUT ||
        tier === GOVERNED_TIER.NO_ACTION) return true;
    return false;
}

// ===========================================================================
// 3. FINDING CODE -> DECISION RECORD
// ===========================================================================

export const FINDING_TO_DECISION = Object.freeze({

    // ---- Personal information ---------------------------------------------
    PI_MULTIPLE_SSN:         { record: "BT-DM-0007", name: "Mixed File Indicators", evidence: "SELF_EVIDENT" },
    PI_MULTIPLE_DOB:         { record: "BT-DM-0007", name: "Mixed File Indicators", evidence: "SELF_EVIDENT" },
    PI_MIXED_FILE_INDICATOR: { record: "BT-DM-0007", name: "Mixed File Indicators", evidence: "SELF_EVIDENT" },
    PI_NAME_MISMATCH_VS_CRC: { record: "BT-DM-0004", name: "Incorrect Name", evidence: "IDENTITY" },
    PI_DOB_MISMATCH_VS_CRC:  { record: "BT-DM-0028", name: "Personal Information Conflict", evidence: "IDENTITY" },
    PI_SSN_MISMATCH_VS_CRC:  { record: "BT-DM-0028", name: "Personal Information Conflict", evidence: "IDENTITY" },
    PI_EMPLOYER_INCONSISTENT_ACROSS_BUREAUS: { record: "BT-DM-0006", name: "Incorrect Employer", evidence: "CROSS_BUREAU" },
    PI_NAME_VARIANTS:        { record: null, reason: "Name variants alone are not an inaccuracy. Context only." },

    // ---- Metro 2 / internal contradiction ----------------------------------
    TL_PAST_DUE_ON_ZERO_BALANCE:              { record: "BT-DM-0033", name: "Metro 2 Reporting Inconsistency", evidence: "SELF_EVIDENT" },
    TL_PAST_DUE_EXCEEDS_BALANCE:              { record: "BT-DM-0033", name: "Metro 2 Reporting Inconsistency", evidence: "SELF_EVIDENT" },
    TL_DEROGATORY_WITHOUT_DOFD:               { record: "BT-DM-0033", name: "Metro 2 Reporting Inconsistency", evidence: "SELF_EVIDENT" },
    TL_DOFD_BEFORE_OPENED:                    { record: "BT-DM-0033", name: "Metro 2 Reporting Inconsistency", evidence: "SELF_EVIDENT" },
    TL_CLOSED_WITH_ACTIVE_STATUS:             { record: "BT-DM-0019", name: "Incorrect Account Status", evidence: "SELF_EVIDENT" },
    TL_STATUS_CONFLICTS_WITH_PAYMENT_HISTORY: { record: "BT-DM-0014", name: "Incorrect Payment History", evidence: "SELF_EVIDENT" },
    TL_DUPLICATE_WITHIN_BUREAU:               { record: "BT-DM-0018", name: "Duplicate Tradeline", evidence: "SELF_EVIDENT" },

    // ---- NEW: obsolete reporting -------------------------------------------
    // SELF_EVIDENT ONLY because the Analysis Engine will not emit these unless the
    // category is identified, the controlling date is present and readable, the
    // period is calculable, and expiry has indisputably passed. Where any of that
    // fails, it emits *_OBSOLESCENCE_INDETERMINATE instead — see below.
    // BT-DM-0054 — Baseline Reinvestigation. Asserts no defect.
    TL_BASELINE_REINVESTIGATION:  { record: "BT-DM-0054", name: "Baseline Reinvestigation", evidence: "CONSUMER_DISPUTE" },
    COL_BASELINE_REINVESTIGATION: { record: "BT-DM-0054", name: "Baseline Reinvestigation", evidence: "CONSUMER_DISPUTE" },

    TL_BEYOND_REPORTING_PERIOD: { record: "BT-DM-0051", name: "Obsolete Derogatory Reporting", evidence: "SELF_EVIDENT" },
    PR_BEYOND_REPORTING_PERIOD: { record: "BT-DM-0051", name: "Obsolete Derogatory Reporting", evidence: "SELF_EVIDENT" },

    TL_OBSOLESCENCE_INDETERMINATE: { record: "BT-DM-0051", name: "Obsolete Derogatory Reporting", evidence: "INDETERMINATE" },

    // ---- NEW: stale inquiries ----------------------------------------------
    //
    // NOT self-evident. See BT-DM-0052: the two-year figure is bureau practice,
    // not a clean §605 obsolescence rule, so the claim is weaker than an
    // obsolete tradeline and is deliberately not fully automated.
    // COMPLIANCE-GATED. Detected and routed; never automatically asserted.
    INQ_BEYOND_REPORTING_PERIOD: { record: "BT-DM-0052", name: "Obsolete Inquiry Reporting", evidence: "INDETERMINATE" },

    // ---- NEW: public record defects ----------------------------------------
    // A missing filing date is READABLE from the report — but it makes the legal
    // treatment UNKNOWABLE, and it is the treatment we would be asserting.
    PR_MISSING_FILING_DATE:        { record: "BT-DM-0053", name: "Public Record Reporting Defect", evidence: "INDETERMINATE" },
    PR_RECORD_TYPE_UNKNOWN:        { record: "BT-DM-0053", name: "Public Record Reporting Defect", evidence: "INDETERMINATE" },
    PR_OBSOLESCENCE_INDETERMINATE: { record: "BT-DM-0053", name: "Public Record Reporting Defect", evidence: "INDETERMINATE" },

    // Provable from the report: two bureaus state different facts about one record.
    PR_XB_INCONSISTENT: { record: "BT-DM-0053", name: "Public Record Reporting Defect", evidence: "CROSS_BUREAU" },

    // ---- Cross-bureau ------------------------------------------------------
    TL_XB_STATUS_INCONSISTENT:      { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },
    TL_XB_BALANCE_INCONSISTENT:     { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },
    TL_XB_PAST_DUE_INCONSISTENT:    { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },
    TL_XB_DOFD_INCONSISTENT:        { record: "BT-DM-0034", name: "Date of First Delinquency Conflict", evidence: "CROSS_BUREAU" },
    TL_XB_OPENED_DATE_INCONSISTENT: { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },

    // ---- History-dependent -------------------------------------------------
    HIST_RE_AGING_INDICATOR:               { record: "BT-DM-0013", name: "Re-aged Account", evidence: "HISTORICAL" },
    HIST_OPENED_DATE_CHANGED:              { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "HISTORICAL" },
    HIST_BALANCE_INCREASED_ON_CHARGED_OFF: { record: "BT-DM-0011", name: "Charge-Off Balance Error", evidence: "HISTORICAL" },
    HIST_ITEM_REAPPEARED:                  { record: "BT-DM-0029", name: "Previously Corrected Information Reappears", evidence: "HISTORICAL" },
    HIST_STATUS_CHANGED:                   { record: null, reason: "A status change is not by itself an inaccuracy. Context for other findings." },

    // ---- Collections -------------------------------------------------------
    COL_MISSING_ORIGINAL_CREDITOR:       { record: "BT-DM-0008", name: "Third-Party Collection", evidence: "SELF_EVIDENT" },
    COL_DUPLICATE_COLLECTION:            { record: "BT-DM-0010", name: "Duplicate Collection Reporting", evidence: "SELF_EVIDENT" },
    COL_POSSIBLE_DUPLICATE_OF_TRADELINE: { record: "BT-DM-0010", name: "Duplicate Collection Reporting", evidence: "CIRCUMSTANTIAL" },
    COL_XB_BALANCE_INCONSISTENT:         { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },

    // ---- Inquiries ---------------------------------------------------------
    INQ_DUPLICATE: { record: "BT-DM-0002", name: "Duplicate Hard Inquiry", evidence: "SELF_EVIDENT" },

    INQ_AUTHORIZATION_UNVERIFIABLE: {
        record: null,
        evidence: "REQUIRES_CONSUMER",
        reason:
            "BT-DM-0001 (Unauthorized Hard Inquiry) requires the consumer to state that they did " +
            "not authorize the pull. That fact is not in the report and this engine will not " +
            "assume it. Routed to the consumer, NOT to a dispute. Under the v2.1 Addendum this " +
            "path is reached only when the account-matching rule cannot be applied.",
    },

    // BT-DM-0001 v2.1 ADDENDUM — Permissible-Purpose Inquiry Evaluation.
    //
    // The Addendum supplies what v2.0 lacked: a REPORT-DERIVED trigger. The
    // inquiry source has no associated account on the bureau's own report, so the
    // dispute rests on the bureau's data rather than on a consumer-held fact.
    // Automation is authorized for this path; BT-DM-0001's CONSUMER_INPUT mapping
    // survives only for the UNRESOLVED case above.
    INQ_NO_ASSOCIATED_ACCOUNT: {
        record: "BT-DM-0001",
        name: "Unauthorized Hard Inquiry",
        evidence: "SELF_EVIDENT",
    },

    // ---- Context only ------------------------------------------------------
    ACCT_NOT_REPORTED_BY_BUREAU: {
        record: null,
        reason:
            "An account absent from one bureau is CONTEXT, not an inaccuracy. It has no bureau " +
            "tradeline and therefore nothing to dispute with that bureau.",
    },
});

export const DECISION_NO_FURTHER_ACTION = { record: "BT-DM-0050", name: "No Further Action Recommended" };
export const DECISION_AUTHORIZED_USER   = { record: "BT-DM-0036", name: "Authorized User Review" };
export const DECISION_HUMAN_EXCEPTION   = { record: "BT-DM-0049", name: "Human Exception Routing" };
export const DECISION_MIXED_FILE        = { record: "BT-DM-0007", name: "Mixed File Indicators" };
