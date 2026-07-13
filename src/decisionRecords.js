/**
 * decisionRecords.js
 *
 * FINDING CODE -> DECISION RECORD mapping, plus confidence policy.
 *
 * The Analysis Engine says WHAT IS TRUE. This registry says WHICH DECISION
 * RECORD GOVERNS that truth. It still selects no strategy, no law, no reason,
 * and no instruction — those come from the Strategy, Crosswalk, Reason, and
 * Instruction libraries downstream.
 *
 * ---------------------------------------------------------------------------
 * CONFIDENCE IS POLICY, NOT MEASUREMENT.
 *
 * The numbers below are NOT derived from data. Nothing in this system has yet
 * measured how often a Metro 2 contradiction results in a deletion. These are
 * DECLARED POLICY VALUES expressing how much evidentiary weight Business
 * Trappers assigns to each class of fact, and they gate automation via the
 * thresholds in the Letter Generation Engine (95+ automated, 90-94 automated
 * with validation, 80-89 processor review, <80 human review).
 *
 * They require Kris's explicit sign-off, and they should be revised once real
 * outcome data exists. Presenting a made-up number as a measurement would be
 * exactly the kind of invented fact the governing documents forbid.
 * ---------------------------------------------------------------------------
 */

/**
 * The evidentiary class of a finding. Confidence flows from this, so that two
 * findings supported by the same KIND of evidence always score the same.
 */
export const EVIDENCE_CLASS = Object.freeze({

    // The bureau's own record contradicts ITSELF. We need no outside reference,
    // and the bureau cannot argue with its own data. The strongest fact we have.
    SELF_EVIDENT: {
        id: "SELF_EVIDENT",
        confidence: 97,
        rationale:
            "The bureau's own reporting is internally contradictory. No external reference is " +
            "required and the contradiction is visible on the face of the report.",
    },

    // Two reports compared. A date that cannot lawfully change, changed.
    HISTORICAL: {
        id: "HISTORICAL",
        confidence: 95,
        rationale:
            "Established by comparing two Business Trappers report snapshots. The change itself " +
            "is documented in our own persisted history.",
    },

    // Bureaus disagree. One of them is wrong — but the report does not tell us
    // WHICH. That irreducible uncertainty is why this scores below SELF_EVIDENT.
    CROSS_BUREAU: {
        id: "CROSS_BUREAU",
        confidence: 92,
        rationale:
            "Bureaus report conflicting values for the same account. At least one is inaccurate, " +
            "but the report alone does not establish which — so each bureau is addressed on its " +
            "own reporting.",
    },

    // Compared against CRC, which is authoritative for identity.
    IDENTITY: {
        id: "IDENTITY",
        confidence: 93,
        rationale: "Compared against the CRC client profile, which is authoritative for consumer identity.",
    },

    // Observable coincidence, not proof. Two records LOOK like the same debt.
    // Whether they ARE is a judgement the report cannot settle.
    CIRCUMSTANTIAL: {
        id: "CIRCUMSTANTIAL",
        confidence: 78,
        rationale:
            "The pattern is consistent with an inaccuracy but is not established by the report " +
            "alone. Below the automation threshold by design.",
    },

    // We do not know, and the report cannot tell us. Never automated.
    REQUIRES_CONSUMER: {
        id: "REQUIRES_CONSUMER",
        confidence: 0,
        rationale:
            "The fact cannot be established without information only the consumer holds. This is " +
            "never automated and never asserted.",
    },
});

/**
 * FINDING CODE -> DECISION RECORD.
 *
 * Where the Master Decision Library has no governing record, the entry is
 * `null` and the finding is surfaced in `unmappedFindings`. WE DO NOT FORCE-FIT.
 * Routing a fact to a decision record that does not govern it would put the
 * wrong strategy, the wrong law, and the wrong letter behind a true fact.
 */
export const FINDING_TO_DECISION = Object.freeze({

    // ---- Personal information ---------------------------------------------
    PI_MULTIPLE_SSN:        { record: "BT-DM-0007", name: "Mixed File Indicators", evidence: "SELF_EVIDENT" },
    PI_MULTIPLE_DOB:        { record: "BT-DM-0007", name: "Mixed File Indicators", evidence: "SELF_EVIDENT" },
    PI_MIXED_FILE_INDICATOR:{ record: "BT-DM-0007", name: "Mixed File Indicators", evidence: "SELF_EVIDENT" },
    PI_NAME_MISMATCH_VS_CRC:{ record: "BT-DM-0004", name: "Incorrect Name", evidence: "IDENTITY" },
    PI_DOB_MISMATCH_VS_CRC: { record: "BT-DM-0028", name: "Personal Information Conflict", evidence: "IDENTITY" },
    PI_SSN_MISMATCH_VS_CRC: { record: "BT-DM-0028", name: "Personal Information Conflict", evidence: "IDENTITY" },
    PI_EMPLOYER_INCONSISTENT_ACROSS_BUREAUS: { record: "BT-DM-0006", name: "Incorrect Employer", evidence: "CROSS_BUREAU" },
    PI_NAME_VARIANTS:       { record: null, reason: "Name variants alone are not an inaccuracy. Context only." },

    // ---- Metro 2 / internal contradiction ----------------------------------
    TL_PAST_DUE_ON_ZERO_BALANCE:            { record: "BT-DM-0033", name: "Metro 2 Reporting Inconsistency", evidence: "SELF_EVIDENT" },
    TL_PAST_DUE_EXCEEDS_BALANCE:            { record: "BT-DM-0033", name: "Metro 2 Reporting Inconsistency", evidence: "SELF_EVIDENT" },
    TL_DEROGATORY_WITHOUT_DOFD:             { record: "BT-DM-0033", name: "Metro 2 Reporting Inconsistency", evidence: "SELF_EVIDENT" },
    TL_DOFD_BEFORE_OPENED:                  { record: "BT-DM-0033", name: "Metro 2 Reporting Inconsistency", evidence: "SELF_EVIDENT" },
    TL_CLOSED_WITH_ACTIVE_STATUS:           { record: "BT-DM-0019", name: "Incorrect Account Status", evidence: "SELF_EVIDENT" },
    TL_STATUS_CONFLICTS_WITH_PAYMENT_HISTORY:{ record: "BT-DM-0014", name: "Incorrect Payment History", evidence: "SELF_EVIDENT" },
    TL_DUPLICATE_WITHIN_BUREAU:             { record: "BT-DM-0018", name: "Duplicate Tradeline", evidence: "SELF_EVIDENT" },

    // ---- Cross-bureau ------------------------------------------------------
    TL_XB_STATUS_INCONSISTENT:      { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },
    TL_XB_BALANCE_INCONSISTENT:     { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },
    TL_XB_PAST_DUE_INCONSISTENT:    { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },
    TL_XB_DOFD_INCONSISTENT:        { record: "BT-DM-0034", name: "Date of First Delinquency Conflict", evidence: "CROSS_BUREAU" },
    TL_XB_OPENED_DATE_INCONSISTENT: { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },

    // ---- History-dependent -------------------------------------------------
    HIST_RE_AGING_INDICATOR:                { record: "BT-DM-0013", name: "Re-aged Account", evidence: "HISTORICAL" },
    HIST_OPENED_DATE_CHANGED:               { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "HISTORICAL" },
    HIST_BALANCE_INCREASED_ON_CHARGED_OFF:  { record: "BT-DM-0011", name: "Charge-Off Balance Error", evidence: "HISTORICAL" },
    HIST_ITEM_REAPPEARED:                   { record: "BT-DM-0029", name: "Previously Corrected Information Reappears", evidence: "HISTORICAL" },
    HIST_STATUS_CHANGED:                    { record: null, reason: "A status change is not by itself an inaccuracy. Context for other findings." },

    // ---- Collections -------------------------------------------------------
    COL_MISSING_ORIGINAL_CREDITOR:      { record: "BT-DM-0008", name: "Third-Party Collection", evidence: "SELF_EVIDENT" },
    COL_DUPLICATE_COLLECTION:           { record: "BT-DM-0010", name: "Duplicate Collection Reporting", evidence: "SELF_EVIDENT" },
    COL_POSSIBLE_DUPLICATE_OF_TRADELINE:{ record: "BT-DM-0010", name: "Duplicate Collection Reporting", evidence: "CIRCUMSTANTIAL" },
    COL_XB_BALANCE_INCONSISTENT:        { record: "BT-DM-0031", name: "Cross-Bureau Reporting Variance", evidence: "CROSS_BUREAU" },

    // ---- Inquiries ---------------------------------------------------------
    INQ_DUPLICATE: { record: "BT-DM-0002", name: "Duplicate Hard Inquiry", evidence: "SELF_EVIDENT" },

    INQ_AUTHORIZATION_UNVERIFIABLE: {
        record: null,
        evidence: "REQUIRES_CONSUMER",
        reason:
            "BT-DM-0001 (Unauthorized Hard Inquiry) requires the consumer to state that they did " +
            "not authorize the pull. That fact is not in the report and this engine will not " +
            "assume it. Routed to the consumer, NOT to a dispute.",
    },

    // ---- KNOWN LIBRARY GAPS ------------------------------------------------
    //
    // These are among the STRONGEST disputes available — an obsolete item is
    // deletable on the face of the report — and the Master Decision Library has
    // no record governing them. Rather than force-fit them onto a record that
    // does not apply, they are surfaced as gaps and routed to human review.
    TL_BEYOND_REPORTING_PERIOD: {
        record: null,
        evidence: "SELF_EVIDENT",
        gap: true,
        reason:
            "LIBRARY GAP. No Decision Record governs OBSOLETE REPORTING (a derogatory item beyond " +
            "the seven-year period). This is distinct from BT-DM-0013 (Re-aged Account), which is " +
            "about DOFD manipulation, not obsolescence. A new Decision Record is required.",
    },

    PR_BEYOND_REPORTING_PERIOD: {
        record: null,
        evidence: "SELF_EVIDENT",
        gap: true,
        reason: "LIBRARY GAP. No Decision Record governs an obsolete public record.",
    },

    INQ_BEYOND_REPORTING_PERIOD: {
        record: null,
        evidence: "SELF_EVIDENT",
        gap: true,
        reason:
            "LIBRARY GAP. No Decision Record governs an inquiry reported beyond the two-year " +
            "period. BT-DM-0001/0002 cover unauthorized and duplicate inquiries, not stale ones.",
    },

    PR_MISSING_FILING_DATE: { record: null, evidence: "SELF_EVIDENT", gap: true, reason: "LIBRARY GAP. No Decision Record governs public record reporting defects." },
    PR_XB_INCONSISTENT:     { record: null, evidence: "CROSS_BUREAU", gap: true, reason: "LIBRARY GAP. No Decision Record governs public record cross-bureau variance." },

    // ---- Context only ------------------------------------------------------
    ACCT_NOT_REPORTED_BY_BUREAU: {
        record: null,
        reason:
            "An account absent from one bureau is CONTEXT, not an inaccuracy. It has no bureau " +
            "tradeline and therefore nothing to dispute with that bureau.",
    },
});

export const DECISION_NO_FURTHER_ACTION = { record: "BT-DM-0050", name: "No Further Action Recommended" };
export const DECISION_AUTHORIZED_USER = { record: "BT-DM-0036", name: "Authorized User Review" };
export const DECISION_HUMAN_EXCEPTION = { record: "BT-DM-0049", name: "Human Exception Routing" };
export const DECISION_MIXED_FILE = { record: "BT-DM-0007", name: "Mixed File Indicators" };

/** Automation thresholds — Letter Generation Engine v1.0. */
export const CONFIDENCE_THRESHOLDS = Object.freeze({
    FULLY_AUTOMATED: 95,
    AUTOMATED_WITH_VALIDATION: 90,
    PROCESSOR_REVIEW: 80,
});

export function automationTier(confidence) {
    if (confidence >= CONFIDENCE_THRESHOLDS.FULLY_AUTOMATED) return "FULLY_AUTOMATED";
    if (confidence >= CONFIDENCE_THRESHOLDS.AUTOMATED_WITH_VALIDATION) return "AUTOMATED_WITH_VALIDATION";
    if (confidence >= CONFIDENCE_THRESHOLDS.PROCESSOR_REVIEW) return "PROCESSOR_REVIEW";
    return "HUMAN_REVIEW_REQUIRED";
}
