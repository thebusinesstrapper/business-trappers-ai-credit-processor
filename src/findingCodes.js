/**
 * findingCodes.js
 *
 * THE FROZEN FINDING REGISTRY.
 *
 * Every fact the Analysis Engine can observe has exactly one code here. Adding a
 * detector means adding a code here first. Downstream engines (Decision,
 * Strategy, Reason, Instruction, Letter) switch on these codes, so a code is a
 * PUBLIC CONTRACT: once consumed downstream, its meaning may never be redefined.
 *
 * ---------------------------------------------------------------------------
 * WHAT A CODE IS AND IS NOT
 *
 *   A code says WHAT WAS OBSERVED. It never says what to do about it.
 *
 *   There is no "dispute this" code, no "remove" code, no law, no reason, no
 *   instruction. `severity` ranks how strongly a fact demands downstream
 *   ATTENTION -- it is not a recommendation, and it is not a legal opinion.
 *
 * ---------------------------------------------------------------------------
 * THE HARD LINE: WE NEVER NAME A FACT WE CANNOT SEE.
 *
 *   Several findings that sound obvious are NOT observable from one credit
 *   report, and this registry deliberately does not contain them:
 *
 *     "INCORRECT_BALANCE"    -- incorrect compared to WHAT? A balance is only
 *                               wrong relative to a reference: the previous
 *                               report, or a consumer document. Neither is in
 *                               the report.
 *     "UNAUTHORIZED_INQUIRY" -- authorization is a fact about what the CONSUMER
 *                               permitted. It exists outside the document. We
 *                               can observe that an inquiry EXISTS. We cannot
 *                               observe that it was unauthorized.
 *     "INCORRECT_NAME"       -- incorrect against what identity? CRC is
 *                               authoritative for identity (Extraction
 *                               Decision 3), not the report.
 *
 *   Emitting these as facts would put an assertion into the consumer's voice
 *   that we cannot support. Instead:
 *
 *     - Where a REFERENCE exists (previous report, CRC identity), we compare
 *       against it and emit a fact about the COMPARISON.
 *     - Where it does not, we emit nothing and record the gap in
 *       `notEvaluated`, so the absence is explainable rather than silent.
 * ---------------------------------------------------------------------------
 */

export const SEVERITY = Object.freeze({
    CRITICAL: "CRITICAL",
    HIGH: "HIGH",
    MEDIUM: "MEDIUM",
    LOW: "LOW",
    INFO: "INFO",
});

export const SEVERITY_RANK = Object.freeze({
    CRITICAL: 5,
    HIGH: 4,
    MEDIUM: 3,
    LOW: 2,
    INFO: 1,
});

/**
 * Where a finding attaches.
 *
 *   ITEM    -> a bureau tradeline. THE LEGAL UNIT OF DISPUTE. Carries both
 *              stable_item_key and stable_account_key.
 *   ACCOUNT -> the underlying financial account. Used ONLY where no bureau
 *              tradeline exists to attach to (see ACCT_NOT_REPORTED_BY_BUREAU).
 *   REPORT  -> the report as a whole (personal information, mixed-file signals).
 */
export const LEVEL = Object.freeze({
    ITEM: "ITEM",
    ACCOUNT: "ACCOUNT",
    REPORT: "REPORT",
});

/**
 * What a detector needs in order to run.
 *
 *   REPORT_ONLY      -> decidable from this report alone
 *   PREVIOUS_REPORT  -> needs the prior BT Credit Report Model
 *   CLIENT_IDENTITY  -> needs CRC identity (authoritative per Decision 3)
 */
export const REQUIRES = Object.freeze({
    REPORT_ONLY: "REPORT_ONLY",
    PREVIOUS_REPORT: "PREVIOUS_REPORT",
    CLIENT_IDENTITY: "CLIENT_IDENTITY",
});

export const FINDING_CODES = Object.freeze({

    // =======================================================================
    // PERSONAL INFORMATION (report level)
    // =======================================================================

    PI_MULTIPLE_SSN: {
        level: LEVEL.REPORT,
        severity: SEVERITY.CRITICAL,
        requires: REQUIRES.REPORT_ONLY,
        summary: "More than one Social Security Number appears on the report.",
    },

    PI_MULTIPLE_DOB: {
        level: LEVEL.REPORT,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "More than one date of birth appears on the report.",
    },

    PI_MIXED_FILE_INDICATOR: {
        level: LEVEL.REPORT,
        severity: SEVERITY.CRITICAL,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "Multiple identity anchors (SSN and/or date of birth) appear on one file — " +
            "consistent with two consumers' data being merged into one file.",
    },

    PI_NAME_VARIANTS: {
        level: LEVEL.REPORT,
        severity: SEVERITY.LOW,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The report lists multiple name variants.",
    },

    PI_NAME_MISMATCH_VS_CRC: {
        level: LEVEL.REPORT,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.CLIENT_IDENTITY,
        summary: "No reported name matches the identity of record.",
    },

    PI_DOB_MISMATCH_VS_CRC: {
        level: LEVEL.REPORT,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.CLIENT_IDENTITY,
        summary: "No reported date of birth matches the identity of record.",
    },

    PI_SSN_MISMATCH_VS_CRC: {
        level: LEVEL.REPORT,
        severity: SEVERITY.CRITICAL,
        requires: REQUIRES.CLIENT_IDENTITY,
        summary: "No reported SSN matches the identity of record.",
    },

    PI_EMPLOYER_INCONSISTENT_ACROSS_BUREAUS: {
        level: LEVEL.REPORT,
        severity: SEVERITY.LOW,
        requires: REQUIRES.REPORT_ONLY,
        summary: "Bureaus report different employers.",
    },

    // =======================================================================
    // BUREAU TRADELINE — INTERNAL CONSISTENCY (Metro 2)
    //
    // These are decidable from ONE bureau's own reporting: the record
    // contradicts ITSELF. No external reference needed, so these are the
    // strongest facts we can produce from a single report.
    // =======================================================================

    TL_PAST_DUE_ON_ZERO_BALANCE: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "A past-due amount is reported while the balance is zero.",
    },

    TL_PAST_DUE_EXCEEDS_BALANCE: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The past-due amount exceeds the reported balance.",
    },

    TL_DEROGATORY_WITHOUT_DOFD: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "A derogatory status is reported with no Date of First Delinquency. " +
            "Without a DOFD the lawful reporting period cannot be computed.",
    },

    TL_DOFD_BEFORE_OPENED: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The Date of First Delinquency precedes the account opened date.",
    },

    TL_CLOSED_WITH_ACTIVE_STATUS: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The account is reported closed while carrying an active-status indicator.",
    },

    TL_STATUS_CONFLICTS_WITH_PAYMENT_HISTORY: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The reported status conflicts with the account's own payment history grid.",
    },

    // BASELINE REINVESTIGATION.
    //
    // This is NOT a defect. It asserts NOTHING about the account's accuracy.
    //
    // It records that a negative tradeline is eligible for the consumer's FCRA
    // §611 right to dispute completeness and accuracy and demand a reasonable
    // reinvestigation — a right that requires NO proof of error to exercise.
    //
    // Emitted ONLY when no fact-specific finding exists. A stronger, specific
    // finding always supersedes it, and never produces a second dispute section.
    TL_BASELINE_REINVESTIGATION: {
        code: "TL_BASELINE_REINVESTIGATION",
        severity: "MEDIUM",
        level: "ITEM",
        requires: "REPORT_ONLY",
        description: "Negative tradeline eligible for baseline §611 reinvestigation. No specific defect identified.",
    },

    COL_BASELINE_REINVESTIGATION: {
        code: "COL_BASELINE_REINVESTIGATION",
        severity: "MEDIUM",
        level: "ITEM",
        requires: "REPORT_ONLY",
        description: "Collection eligible for baseline §611 reinvestigation. No specific defect identified.",
    },

    TL_BEYOND_REPORTING_PERIOD: {
        level: LEVEL.ITEM,
        severity: SEVERITY.CRITICAL,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "The Date of First Delinquency is more than seven years old, yet the item " +
            "is still reported.",
    },

    // OBSOLESCENCE COULD NOT BE COMPUTED.
    //
    // This is NOT "the item is fine". It is "we cannot tell", and the difference
    // is the whole guardrail. An obsolescence claim rests entirely on a date; if
    // the date is missing, unreadable, or contested across bureaus, we have no
    // ground to stand on and must not manufacture one.
    TL_OBSOLESCENCE_INDETERMINATE: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "A derogatory item may be beyond its reporting period, but the controlling date is " +
            "missing, unreadable, or disputed across bureaus, so the expiration cannot be computed.",
    },

    TL_DUPLICATE_WITHIN_BUREAU: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The same account appears more than once within this single bureau's file.",
    },

    // =======================================================================
    // BUREAU TRADELINE — CROSS-BUREAU INCONSISTENCY
    //
    // Detected by comparing the bureau tradelines of ONE underlying account.
    //
    // CRITICAL ARCHITECTURAL POINT: these are DETECTED at the account level but
    // EMITTED ON EACH BUREAU TRADELINE. Each finding states what THAT bureau
    // reports and how it differs from its peers.
    //
    // They are NEVER flattened into one account-level finding, because each
    // bureau is disputed SEPARATELY and each letter must speak only to that
    // bureau's own reporting. An account-level "the bureaus disagree" finding
    // could not be turned into a letter to any specific bureau.
    // =======================================================================

    TL_XB_STATUS_INCONSISTENT: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "This bureau reports a status that differs from other bureaus reporting the same account.",
    },

    TL_XB_BALANCE_INCONSISTENT: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary: "This bureau reports a balance that differs materially from other bureaus.",
    },

    TL_XB_PAST_DUE_INCONSISTENT: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary: "This bureau reports a past-due amount that differs from other bureaus.",
    },

    TL_XB_DOFD_INCONSISTENT: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "This bureau reports a Date of First Delinquency that differs from other bureaus. " +
            "DOFD determines the lawful reporting period, so the bureaus cannot both be right.",
    },

    TL_XB_OPENED_DATE_INCONSISTENT: {
        level: LEVEL.ITEM,
        severity: SEVERITY.LOW,
        requires: REQUIRES.REPORT_ONLY,
        summary: "This bureau reports an opened date that differs from other bureaus.",
    },

    // =======================================================================
    // ACCOUNT LEVEL
    //
    // Used ONLY where there is no bureau tradeline to attach to. If a bureau
    // does not report an account, no stable_item_key exists for that bureau —
    // so the fact has nowhere else to live.
    //
    // This is NOT a flattening of bureau findings. It is a fact ABOUT AN ABSENCE.
    // =======================================================================

    ACCT_NOT_REPORTED_BY_BUREAU: {
        level: LEVEL.ACCOUNT,
        severity: SEVERITY.INFO,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "One or more bureaus do not report this account at all. Absence is meaningful " +
            "data, not missing data.",
    },

    // =======================================================================
    // COLLECTIONS
    // =======================================================================

    COL_MISSING_ORIGINAL_CREDITOR: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "A collection is reported with no original creditor identified.",
    },

    COL_POSSIBLE_DUPLICATE_OF_TRADELINE: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "A collection shares an original creditor and balance with a charged-off tradeline — " +
            "consistent with the same debt being reported twice.",
    },

    COL_DUPLICATE_COLLECTION: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "More than one collection agency reports the same original creditor and balance.",
    },

    COL_XB_BALANCE_INCONSISTENT: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary: "This bureau reports a collection balance that differs from other bureaus.",
    },

    // =======================================================================
    // INQUIRIES
    //
    // NOTE THE ABSENCE OF "UNAUTHORIZED_INQUIRY". See the header. We can observe
    // that an inquiry exists. We CANNOT observe that it was unauthorized —
    // that is a fact about what the consumer permitted, and it is not in the
    // document. Asserting it would be inventing a fact.
    // =======================================================================

    INQ_DUPLICATE: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The same furnisher made multiple inquiries at the same bureau within a short window.",
    },

    INQ_BEYOND_REPORTING_PERIOD: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The inquiry is more than two years old and is still reported.",
    },

    INQ_AUTHORIZATION_UNVERIFIABLE: {
        level: LEVEL.ITEM,
        severity: SEVERITY.INFO,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "Whether this inquiry was authorized cannot be determined from the credit report. " +
            "It requires confirmation from the consumer. This is a statement about what we do " +
            "NOT know — it is not an assertion that the inquiry was unauthorized.",
    },

    // =======================================================================
    // PUBLIC RECORDS
    // =======================================================================

    PR_MISSING_FILING_DATE: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "A public record is reported with no filing date.",
    },

    PR_XB_INCONSISTENT: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.REPORT_ONLY,
        summary: "This bureau reports public record details that differ from other bureaus.",
    },

    PR_RECORD_TYPE_UNKNOWN: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "The public record's type cannot be identified from the report. Different record types " +
            "carry different reporting periods and different legal treatment, so nothing can be " +
            "asserted about it until the type is known.",
    },

    PR_OBSOLESCENCE_INDETERMINATE: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.REPORT_ONLY,
        summary:
            "A public record may be beyond its reporting period, but the record type or filing date " +
            "cannot be established, so the applicable period cannot be calculated.",
    },

    PR_BEYOND_REPORTING_PERIOD: {
        level: LEVEL.ITEM,
        severity: SEVERITY.CRITICAL,
        requires: REQUIRES.REPORT_ONLY,
        summary: "The public record is beyond its lawful reporting period and is still reported.",
    },

    // =======================================================================
    // HISTORY-DEPENDENT
    //
    // These require the PREVIOUS BT Credit Report Model. They are the reason
    // analyzeCreditReport() accepts an optional context.
    //
    // RE-AGING IS THE POINT. Re-aging is a DOFD moving LATER over time, which
    // unlawfully extends how long a derogatory item may be reported. It is
    // INVISIBLE in a single report — there is nothing to compare against. A
    // single-snapshot analyzer cannot detect it at all, and one that claimed to
    // would be guessing.
    // =======================================================================

    HIST_RE_AGING_INDICATOR: {
        level: LEVEL.ITEM,
        severity: SEVERITY.CRITICAL,
        requires: REQUIRES.PREVIOUS_REPORT,
        summary:
            "The Date of First Delinquency moved LATER than previously reported, which extends " +
            "the reporting period. This is the signature of re-aging.",
    },

    HIST_STATUS_CHANGED: {
        level: LEVEL.ITEM,
        severity: SEVERITY.MEDIUM,
        requires: REQUIRES.PREVIOUS_REPORT,
        summary: "The reported status changed since the previous report.",
    },

    HIST_BALANCE_INCREASED_ON_CHARGED_OFF: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.PREVIOUS_REPORT,
        summary: "The balance on a charged-off account increased since the previous report.",
    },

    HIST_OPENED_DATE_CHANGED: {
        level: LEVEL.ITEM,
        severity: SEVERITY.HIGH,
        requires: REQUIRES.PREVIOUS_REPORT,
        summary: "The account opened date changed since the previous report. An opened date is immutable.",
    },

    HIST_ITEM_REAPPEARED: {
        level: LEVEL.ITEM,
        severity: SEVERITY.CRITICAL,
        requires: REQUIRES.PREVIOUS_REPORT,
        summary: "An item absent from the previous report is being reported again.",
    },
});

export function getCode(code) {
    const entry = FINDING_CODES[code];

    if (!entry) {
        // A typo'd code would otherwise flow downstream as a finding no engine
        // can handle. Fail loudly, here, at the source.
        throw new Error(`Unknown finding code: ${code}. Add it to findingCodes.js first.`);
    }

    return entry;
}
