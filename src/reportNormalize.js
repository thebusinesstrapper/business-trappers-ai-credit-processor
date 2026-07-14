/**
 * reportNormalize.js
 *
 * Raw Array.io MISMO 2.4 payload -> BT Credit Report Model™ (BT-CRM-1.1).
 *
 * ===========================================================================
 * THIS MODULE EMITS FACTS. IT DOES NOT DECIDE ANYTHING.
 *
 * It does not know what "negative" means. It does not know what is disputable.
 * It does not know that a closed account is still disputable, or that a
 * positively-reporting Department of Education loan is eligible under Business
 * Trappers policy — because those are POLICY, and policy lives in the Strategy
 * Engine, where it can be read, reviewed, and changed without touching a parser.
 *
 * A normalizer that quietly drops "positive" accounts makes that policy
 * unimplementable, and does it invisibly: the account is simply never seen again.
 *
 * So: open/closed, student-loan indicator, federal-guarantee indicator,
 * charge-off indicator, collection indicator, balances, payment history. Facts.
 * Nothing else.
 *
 * PURE. Must not import Playwright. Structural, not stylistic.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * WHAT RUN #83 PROVED, AND WHY THE MODEL CHANGED
 *
 *   119 raw liability rows
 *    87 unique @ArrayAccountIdentifier values
 *    29 rows carrying MORE THAN ONE bureau
 *
 * Array is INCONSISTENT. It sometimes collapses several bureaus into one
 * liability and sometimes splits them across many. We do not know its merge rule.
 *
 * A liability carrying {TransUnion, Experian, Equifax} has ONE
 * @_UnpaidBalanceAmount. We therefore know that three bureaus report the account
 * and that Array asserts this value for the group. We do NOT know that each
 * bureau individually reports exactly that value.
 *
 * Array probably merges only where the bureaus agree. WE CANNOT PROVE THAT — and
 * if it is wrong, we would assert "$4,200" as TransUnion's reported balance, in a
 * dispute letter, over the consumer's signature, when TransUnion never said it.
 *
 * Hence `basis` on every observation. We keep every value Array gives us, AND we
 * keep the truth about how strongly it is attributable to a single bureau.
 * Nothing is discarded. Nothing is invented.
 * ---------------------------------------------------------------------------
 */

import {
    KEY_PREFIX, mintKey, resolveKey, buildRegistry, RESOLUTION,
    accountSignatures, tradelineSignatures, inquirySignatures,
    readVendorIdentifiers,
} from "./itemKey.js";

export const MODEL_VERSION = "BT-CRM-1.1";

/**
 * How strongly an observed value is attributable to ONE bureau.
 *
 * This is the whole amendment. It is not metadata — it GATES what a letter may
 * say (see §Letter rules below).
 */
export const BASIS = Object.freeze({
    /** This liability named exactly one bureau. The value IS that bureau's. */
    BUREAU_SPECIFIC: "BUREAU_SPECIFIC",

    /**
     * This liability named several bureaus and carried ONE value for all of them.
     * Array asserts it for the group. No individual bureau asserted it to us.
     */
    SHARED_ACROSS_BUREAUS: "SHARED_ACROSS_BUREAUS",
});

const BUREAU_BY_SOURCE_TYPE = Object.freeze({
    transunion: "transunion",
    "trans union": "transunion",
    tui: "transunion",
    tu: "transunion",
    experian: "experian",
    xpn: "experian",
    exp: "experian",
    equifax: "equifax",
    eqf: "equifax",
    efx: "equifax",
});

// ---------------------------------------------------------------------------
// FIELD MAP
// ---------------------------------------------------------------------------

/**
 * MISMO is XML; this payload is an XML->JSON conversion, so attribute keys are
 * @-PREFIXED. Guessing an unprefixed name yields null — and per Extraction §6.1
 * a null is indistinguishable from a DELETED item to the Intelligence Engine.
 * A wrong key name therefore manufactures a phantom deletion.
 *
 * Every field lists its candidate key names. A field we cannot find is null AND
 * is recorded in completeness.warnings — so "the bureau does not report this"
 * (data) is never confused with "we failed to read it" (a bug).
 */
export const FIELD = Object.freeze({
    // CONFIRMED present in the run #83 liability key list.
    balance: ["@_UnpaidBalanceAmount"],
    past_due: ["@_PastDueAmount"],
    monthly_payment: ["@_MonthlyPaymentAmount"],
    months_reviewed: ["@_MonthsReviewedCount"],
    terms_months: ["@_TermsMonthsCount"],
    terms_description: ["@_TermsDescription"],
    last_payment_date: ["@LastPaymentDate"],

    raw_account_status: ["@RawAccountStatus"],
    raw_account_type: ["@RawAccountType"],
    raw_industry_text: ["@RawIndustryText"],

    credit_loan_type: ["@CreditLoanType"],
    credit_business_type: ["@CreditBusinessType"],

    // OBJECTIVE INDICATORS. The Strategy Engine reads these. The normalizer does
    // not act on any of them.
    is_closed: ["@IsClosedIndicator"],
    is_chargeoff: ["@IsChargeoffIndicator"],
    is_collection: ["@IsCollectionIndicator"],
    is_mortgage: ["@IsMortgageIndicator"],
    is_secured: ["@SecuredLoanIndicator"],

    // Business Trappers policy: Department of Education / Aidvantage student loans
    // are disputable EVEN WHEN REPORTING POSITIVELY. That policy is NOT inferred
    // here. These are facts; the rule that uses them lives in the Strategy Engine.
    is_student_loan: ["@IsStudentLoan"],
    is_fed_guaranteed_student_loan: ["@IsFedGuaranteedStudentLoan"],

    // NOT YET CONFIRMED — the liability key list we received was truncated at the
    // top. These are the candidates; a miss is recorded, never guessed around.
    // CONFIRMED to exist. Both spellings tried; neither assumed.
    masked_account: ["@_AccountIdentifier", "_AccountIdentifier", "@AccountIdentifier"],
    account_status_type: ["@_AccountStatusType", "_AccountStatusType"],

    // FCRA §611 — an item the consumer has ALREADY disputed. Maps to BT-RN-0021
    // (Failure to Mark as Disputed). Captured as a fact; acted on by the Strategy
    // Engine, never here.
    consumer_disputed: ["@_ConsumerDisputeIndicator", "_ConsumerDisputeIndicator"],

    // The bureau's OWN derogatory flag. An objective fact, and far safer than
    // inferring "negative" from a status string we have not verified.
    derogatory: ["@_DerogatoryDataIndicator", "_DerogatoryDataIndicator"],
    date_opened: ["@_AccountOpenedDate", "@AccountOpenedDate", "@_DateOpened"],
    date_reported: ["@_AccountReportedDate", "@AccountReportedDate", "@_DateReported"],
    date_closed: ["@_AccountClosedDate", "@AccountClosedDate"],
    // CONFIRMED from the live payload. My earlier candidates all missed.
    //
    // DOFD is load-bearing: BT-DM-0034 (Date of First Delinquency Conflict) and the
    // obsolescence guardrail BT-DM-0051 both depend on it. Had this stayed
    // unresolved it would read as null — and a null DOFD makes an obsolescence
    // claim INDETERMINATE rather than false, so the failure would have been silent
    // and conservative rather than loud.
    dofd: ["@_FirstDelinquencyDate", "@_AccountFirstDelinquencyDate", "@_DateOfFirstDelinquency"],
    credit_limit: ["@_CreditLimitAmount", "@CreditLimitAmount"],
    high_balance: ["@_HighBalanceAmount", "@HighBalanceAmount", "@_HighCreditAmount"],

    /**
     * RESPONSIBILITY / OWNERSHIP.
     *
     * THE PROJECT CONSTITUTION FORBIDS DISPUTING AUTHORIZED-USER ACCOUNTS.
     *
     * If this field cannot be read, we CANNOT KNOW whether an account is an
     * authorized-user tradeline — and a missing value must NEVER be read as "not
     * an authorized user." That would silently dispute exactly the accounts the
     * Constitution protects.
     *
     * A miss here is therefore a HARD STOP (see §Required fields).
     */
    responsibility: [
        "@_AccountOwnershipType",
        "_AccountOwnershipType",
        "@AccountOwnershipType",
        "@_OwnershipType",
    ],
});

/**
 * Fields whose ABSENCE stops the run.
 *
 * Not because we like completeness — because acting without them is unsafe:
 *
 *   responsibility -> without it we cannot honour the authorized-user prohibition.
 *   masked_account -> generateLetter.js Rule 3 WITHHOLDS any item with no account
 *                     number rather than send an unidentifiable dispute, and the
 *                     itemKey cascade loses acct_last4 (tiers A1/A2/T2).
 *
 * We would rather stop than proceed blind.
 */
const REQUIRED_FIELDS = ["responsibility", "masked_account"];

/**
 * Fields the normalizer ACTUALLY READS into the model.
 *
 * `fields_never_found` is computed against THIS set — not against every key in
 * FIELD. The distinction is the bug this fixes:
 *
 *   A field DEFINED in FIELD but never read (e.g. credit_business_type) is not a
 *   mapping failure. /debug/field-map probes the payload directly and finds it;
 *   the normalizer, which only marks keysSeen for fields it reads, never marks it —
 *   so the old check reported it as "never found" while it plainly exists.
 *
 * Two tools, same map, DIFFERENT question. field-map asks "is the key in the
 * payload?" The normalizer asks "did I read this field?" Both are legitimate; they
 * are not the same, and never_found must be asked only of fields we read.
 *
 * Fields present in FIELD but absent here are UNUSED — reported separately, never
 * silently. Whether they SHOULD be read is a downstream-need question, not a bug
 * to paper over by wiring them in.
 */
const READ_FIELDS = new Set([
    "balance", "past_due", "monthly_payment", "months_reviewed", "terms_months",
    "last_payment_date", "raw_account_status", "raw_account_type", "raw_industry_text",
    "is_closed", "is_chargeoff", "is_collection", "is_mortgage", "is_secured",
    "is_student_loan", "is_fed_guaranteed_student_loan", "masked_account",
    "account_status_type", "consumer_disputed", "derogatory", "date_opened",
    "date_reported", "date_closed", "dofd", "credit_limit", "high_balance",
    "responsibility",
]);

// Defined in FIELD but not read. Surfaced in completeness so it is visible, not
// mistaken for missing data. Currently: terms_description, credit_loan_type,
// credit_business_type.
const DEFINED_NOT_READ = Object.keys(FIELD).filter((f) => !READ_FIELDS.has(f));

// ---------------------------------------------------------------------------
// PRIMITIVES — never infer, never default, never "reasonably estimate"
// ---------------------------------------------------------------------------

/**
 * @param {object} node        the liability
 * @param {string} fieldName   logical field
 * @param {object} track       { keysSeen:Set, valueless:Set } — see below
 *
 * TWO DIFFERENT FACTS, NEVER CONFLATED:
 *
 *   keysSeen   — this field's KEY was present on this node (regardless of value).
 *                If a field is in keysSeen for ANY row, the key name is correct.
 *
 *   valueless  — the key was present but the VALUE was null/empty on this node.
 *                That is DATA ("this bureau does not report a close date"), not a
 *                defect.
 *
 * A field is only a genuine "not found" if it is in keysSeen for ZERO rows — i.e.
 * we never located the key under any candidate, on any liability. THAT is a
 * mapping bug. Everything else is legitimate absence.
 *
 * The old code added to a single `misses` set whenever the VALUE was absent, so a
 * field that is present-and-null on 108 rows and populated on 11 — like DOFD —
 * was reported as "not found" AND warned about, while working perfectly.
 */
function readField(node, fieldName, track) {
    for (const key of FIELD[fieldName]) {
        if (node && Object.prototype.hasOwnProperty.call(node, key)) {
            track.keysSeen.add(fieldName);           // the KEY exists here

            const value = node[key];

            if (value !== null && value !== undefined && value !== "") return value;

            track.valueless.add(fieldName);           // key present, value empty
            return null;
        }
    }

    return null;   // key absent on THIS node; not yet a defect — see finalize
}

/** A number we cannot read is null. NEVER 0 — zero is a fact, absence is not. */
function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;

    const n = Number(String(value).replace(/[$,\s]/g, ""));

    return Number.isFinite(n) ? n : null;
}

/** MISMO indicators arrive as "Y"/"N"/"true"/"false"/booleans. Unknown -> null. */
function toBool(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return value;

    const v = String(value).trim().toLowerCase();

    if (["y", "yes", "true", "1"].includes(v)) return true;
    if (["n", "no", "false", "0"].includes(v)) return false;

    return null;
}

function toDate(value) {
    if (!value) return null;

    const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);

    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function toArray(v) {
    if (v == null) return [];

    return Array.isArray(v) ? v : [v];
}

/** Bureau names we do not recognise are null and warned about. Never guessed. */
function normalizeBureau(sourceType) {
    if (!sourceType) return null;

    return BUREAU_BY_SOURCE_TYPE[String(sourceType).trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// OBSERVATION
// ---------------------------------------------------------------------------

/**
 * Build ONE bureau's observation from a liability.
 *
 * `basis` records whether this liability spoke for one bureau or several. It is
 * the difference between a fact we may assert and a fact we may only dispute.
 */
function buildObservation(liability, basis, sharedWith, track) {
    return {
        basis,
        shared_with: sharedWith.length ? sharedWith : null,

        balance: toNumber(readField(liability, "balance", track)),
        past_due: toNumber(readField(liability, "past_due", track)),
        monthly_payment: toNumber(readField(liability, "monthly_payment", track)),
        credit_limit: toNumber(readField(liability, "credit_limit", track)),
        high_balance: toNumber(readField(liability, "high_balance", track)),

        date_opened: toDate(readField(liability, "date_opened", track)),
        date_reported: toDate(readField(liability, "date_reported", track)),
        date_closed: toDate(readField(liability, "date_closed", track)),
        date_of_first_delinquency: toDate(readField(liability, "dofd", track)),
        last_payment_date: toDate(readField(liability, "last_payment_date", track)),

        // Verbatim. We do not map raw status codes to meanings we have not verified.
        account_status_raw: readField(liability, "raw_account_status", track),
        account_type_raw: readField(liability, "raw_account_type", track),
        industry_raw: readField(liability, "raw_industry_text", track),

        // OBJECTIVE INDICATORS. Facts. The Strategy Engine decides what they mean.
        is_closed: toBool(readField(liability, "is_closed", track)),
        is_chargeoff: toBool(readField(liability, "is_chargeoff", track)),
        is_collection: toBool(readField(liability, "is_collection", track)),
        is_mortgage: toBool(readField(liability, "is_mortgage", track)),
        is_secured: toBool(readField(liability, "is_secured", track)),
        is_student_loan: toBool(readField(liability, "is_student_loan", track)),
        is_fed_guaranteed_student_loan: toBool(
            readField(liability, "is_fed_guaranteed_student_loan", track)
        ),

        // Constitution: authorized-user accounts are never disputed. Captured
        // VERBATIM and NOT interpreted here.
        //
        // We do NOT map this to a boolean is_authorized_user, because we have not
        // yet seen the VALUE VOCABULARY — "AuthorizedUser" / "Authorized User" /
        // "A" / "3" are all plausible, and a wrong guess would not fail loudly. It
        // would silently dispute exactly the accounts the Constitution protects.
        //
        // The Decision Engine interprets it, against a vocabulary read off the real
        // data (see POST /debug/field-map).
        responsibility: readField(liability, "responsibility", track),

        account_status_type: readField(liability, "account_status_type", track),

        // Facts. The Strategy Engine decides what they mean.
        consumer_disputed: toBool(readField(liability, "consumer_disputed", track)),
        derogatory: toBool(readField(liability, "derogatory", track)),

        months_reviewed: toNumber(readField(liability, "months_reviewed", track)),
        terms_months: toNumber(readField(liability, "terms_months", track)),

        payment_history: readPaymentPattern(liability),
        late_counts: readLateCounts(liability),
        remarks: readComments(liability),
    };
}

function readPaymentPattern(liability) {
    const pattern = liability?._PAYMENT_PATTERN;

    if (!pattern) return null;

    return {
        data: pattern["@_Data"] ?? null,
        start_date: toDate(pattern["@_StartDate"]),
        raw: pattern,
    };
}

function readLateCounts(liability) {
    const late = liability?._LATE_COUNT;

    if (!late) return null;

    return {
        days_30: toNumber(late["@_30Days"]),
        days_60: toNumber(late["@_60Days"]),
        days_90: toNumber(late["@_90Days"]),
        raw: late,
    };
}

function readComments(liability) {
    const comments = toArray(liability?.CREDIT_COMMENT);

    if (comments.length === 0) return null;

    return comments.map((c) => c?.["@_Text"] ?? c?.["@_Code"] ?? null).filter(Boolean);
}

function readCreditor(liability) {
    return liability?._CREDITOR?.["@_Name"] ?? null;
}

// ---------------------------------------------------------------------------
// THE NORMALIZER
// ---------------------------------------------------------------------------

/**
 * @param {object} payload   raw Array.io MISMO 2.4 JSON, verbatim from M6
 * @param {object} options
 * @param {string} options.crcClientId          tag only; CRC is authoritative for identity
 * @param {object|null} options.previousReport  previous BT Credit Report Model (the key registry)
 */
export function normalizeReport(payload, { crcClientId, previousReport = null } = {}) {
    const response = payload?.CREDIT_RESPONSE ?? payload;

    if (!response || typeof response !== "object") {
        return fail("NO_CREDIT_RESPONSE", "The payload contains no CREDIT_RESPONSE object.");
    }

    const liabilities = toArray(response.CREDIT_LIABILITY);

    if (liabilities.length === 0) {
        return fail("NO_LIABILITIES", "The payload contains no CREDIT_LIABILITY entries.");
    }

    const warnings = [];
    const errors = [];
    // Two facts, tracked apart (see readField): which field KEYS we ever saw, and
    // which were present-but-empty. A field missing from keysSeen entirely is the
    // only genuine "not found."
    const track = { keysSeen: new Set(), valueless: new Set() };

    // ---- Key registry from the PREVIOUS report (Extraction Decision 2) --------
    const accountRegistry = buildRegistry(previousReport?.key_index?.accounts ?? []);
    const tradelineRegistry = buildRegistry(previousReport?.key_index?.tradelines ?? []);

    const keyResolution = {
        accounts: { matched: 0, minted: 0, ambiguous: [] },
        tradelines: { matched: 0, minted: 0, ambiguous: [] },
    };

    // ---- PASS 1: group liabilities by underlying account ---------------------
    //
    // @ArrayAccountIdentifier is the ONLY cross-liability correlation evidence
    // Array gives us. A liability without one cannot be correlated, and we do NOT
    // fall back to furnisher-name matching to invent a relationship — the
    // furnisher name is not identity evidence across bureaus.
    const groups = new Map();
    const uncorrelated = [];

    liabilities.forEach((liability, index) => {
        const arrayId = liability?.["@ArrayAccountIdentifier"] ?? null;

        if (!arrayId) {
            uncorrelated.push({ index, liability });
            return;
        }

        if (!groups.has(arrayId)) groups.set(arrayId, []);

        groups.get(arrayId).push({ index, liability });
    });

    if (uncorrelated.length > 0) {
        warnings.push(
            `${uncorrelated.length} liability row(s) carry no @ArrayAccountIdentifier and cannot be ` +
            `correlated across bureaus. Each is treated as its own account. We do NOT correlate them ` +
            `by furnisher name — that would invent a relationship the payload does not assert.`
        );

        uncorrelated.forEach(({ index, liability }) => {
            groups.set(`__uncorrelated_${index}`, [{ index, liability }]);
        });
    }

    // ---- PASS 2: account x bureau -------------------------------------------
    const accounts = [];

    for (const [arrayId, members] of groups.entries()) {
        const first = members[0].liability;

        // --- stable_account_key -----------------------------------------------
        const acctSigs = accountSignatures({
            "@ArrayAccountIdentifier": arrayId.startsWith("__uncorrelated_") ? null : arrayId,
            masked_account: readField(first, "masked_account", track),
            date_opened: readField(first, "date_opened", track),
            account_type: readField(first, "raw_account_type", track),
            furnisher: readCreditor(first),
        });

        const acctResolved = resolveKey(acctSigs, accountRegistry, KEY_PREFIX.ACCOUNT);

        if (acctResolved.resolution === RESOLUTION.AMBIGUOUS) {
            keyResolution.accounts.ambiguous.push({
                array_account_id: arrayId,
                candidates: acctResolved.candidates,
            });

            continue; // extraction_ok will be false; do not guess a key.
        }

        keyResolution.accounts[acctResolved.resolution === RESOLUTION.MATCHED ? "matched" : "minted"]++;

        const stableAccountKey = acctResolved.key;

        // --- ONE TRADELINE PER (ACCOUNT, BUREAU) ------------------------------
        const byBureau = new Map();

        for (const { index, liability } of members) {
            const repositories = toArray(liability.CREDIT_REPOSITORY);

            const bureaus = repositories
                .map((r) => normalizeBureau(r?.["@_SourceType"]))
                .filter(Boolean);

            if (bureaus.length === 0) {
                warnings.push(
                    `Liability row ${index} names no recognisable bureau (CREDIT_REPOSITORY.@_SourceType). ` +
                    `It is not emitted as a tradeline — a tradeline with no bureau cannot be disputed with anyone.`
                );
                continue;
            }

            // THE BASIS RULE.
            //
            // One bureau on this liability -> the value IS that bureau's.
            // Several bureaus, ONE value  -> Array asserts it for the group. No
            //                                individual bureau asserted it to us.
            const basis = bureaus.length === 1 ? BASIS.BUREAU_SPECIFIC : BASIS.SHARED_ACROSS_BUREAUS;

            for (const bureau of bureaus) {
                const sharedWith = bureaus.filter((b) => b !== bureau);

                // ---- (ACCOUNT, BUREAU) COLLISION -> FAIL CLOSED ---------------
                //
                // Both shapes coexist in this payload. One bureau can therefore
                // report one account through TWO liabilities — a merged {TU, EXP}
                // row AND a separate {TU} row.
                //
                // That yields TWO TransUnion tradelines for one account: two
                // letters about the same item, or a reconciliation that
                // double-counts. WE DO NOT MERGE THEM AND WE DO NOT PICK ONE.
                // A wrong key is worse than no key (§7.6).
                if (byBureau.has(bureau)) {
                    const existing = byBureau.get(bureau);

                    errors.push(
                        `(account, bureau) COLLISION: account ${stableAccountKey} is reported by ` +
                        `${bureau} through TWO liability rows (${existing.source_row_index} and ${index}). ` +
                        `Array's merge behaviour is inconsistent and we cannot tell which row is ` +
                        `authoritative. Routing to manual review rather than merging or choosing.`
                    );

                    keyResolution.tradelines.ambiguous.push({
                        stable_account_key: stableAccountKey,
                        bureau,
                        rows: [existing.source_row_index, index],
                    });

                    continue;
                }

                const observation = buildObservation(liability, basis, sharedWith, track);

                const tlSigs = tradelineSignatures(
                    {
                        "@TradelineHashSimple": liability["@TradelineHashSimple"] ?? null,
                        masked_account: readField(liability, "masked_account", track),
                        furnisher: readCreditor(liability),
                        bureau,
                    },
                    stableAccountKey
                );

                const tlResolved = resolveKey(tlSigs, tradelineRegistry, KEY_PREFIX.TRADELINE);

                if (tlResolved.resolution === RESOLUTION.AMBIGUOUS) {
                    keyResolution.tradelines.ambiguous.push({
                        bureau,
                        candidates: tlResolved.candidates,
                    });

                    continue;
                }

                keyResolution.tradelines[
                    tlResolved.resolution === RESOLUTION.MATCHED ? "matched" : "minted"
                ]++;

                byBureau.set(bureau, {
                    stable_item_key: tlResolved.key,
                    bureau,
                    furnisher: readCreditor(liability),
                    masked_account: readField(liability, "masked_account", track),
                    observation,
                    signatures: tlSigs.map((s) => s.value),
                    vendor_identifiers: readVendorIdentifiers(liability),
                    source_row_index: index,
                    raw: liability,
                });
            }
        }

        accounts.push({
            stable_account_key: stableAccountKey,
            array_account_identifier: arrayId.startsWith("__uncorrelated_") ? null : arrayId,
            account_type: readField(first, "raw_account_type", track),
            signatures: acctSigs.map((s) => s.value),
            bureau_tradelines: [...byBureau.values()],
        });
    }

    // ---- Inquiries -----------------------------------------------------------
    const inquiries = toArray(response.CREDIT_INQUIRY)
        .map((inq) => {
            const bureau = normalizeBureau(
                toArray(inq?.CREDIT_REPOSITORY)[0]?.["@_SourceType"] ?? inq?.["@_SourceType"]
            );

            const furnisher = inq?.["@_Name"] ?? inq?._CREDITOR?.["@_Name"] ?? null;
            const date = toDate(inq?.["@_Date"] ?? inq?.["@_InquiryDate"]);

            const sigs = inquirySignatures({ furnisher, bureau, inquiry_date: date });

            const resolved = resolveKey(sigs, tradelineRegistry, KEY_PREFIX.INQUIRY);

            return {
                stable_item_key: resolved.key,
                bureau,
                furnisher,
                inquiry_date: date,
                signatures: sigs.map((s) => s.value),
                raw: inq,
            };
        })
        .filter((i) => i.bureau && i.furnisher);

    // ---- Scores --------------------------------------------------------------
    const scores = {};

    for (const score of toArray(response.CREDIT_SCORE)) {
        const bureau = normalizeBureau(
            score?.["@CreditRepositorySourceType"] ??
            toArray(score?.CREDIT_REPOSITORY)[0]?.["@_SourceType"]
        );

        if (bureau) scores[bureau] = toNumber(score?.["@_Value"]);
    }

    // ---- Required fields -----------------------------------------------------
    //
    // GENUINELY missing = the key was never located under any candidate, on any
    // liability. A required field that is present-but-null on some row is a
    // different matter and is NOT a hard stop here (the row-level guards handle it).
    const missingRequired = REQUIRED_FIELDS.filter((f) => !track.keysSeen.has(f));

    if (missingRequired.length > 0) {
        errors.push(
            `REQUIRED FIELD(S) NOT FOUND: ${missingRequired.join(", ")}. ` +
            `Candidate keys tried: ${missingRequired.map((f) => FIELD[f].join(" / ")).join("; ")}. ` +
            (missingRequired.includes("responsibility")
                ? `Without a responsibility/ownership value we CANNOT identify authorized-user ` +
                  `tradelines, and the Project Constitution forbids disputing them. A missing value ` +
                  `must never be read as "not an authorized user." `
                : "") +
            (missingRequired.includes("masked_account")
                ? `Without a masked account number the letter engine withholds the item (Rule 3) and ` +
                  `the identity cascade loses acct_last4. `
                : "") +
            `This is a HARD STOP.`
        );
    }

    // A field whose KEY appeared on NO liability under ANY candidate. This is a
    // real mapping concern — the parser is looking for a key the payload never
    // uses. Present-but-null fields (track.valueless) are NOT warned about: they
    // are legitimate absence, which is exactly the DOFD-on-108-rows case.
    // Only fields we READ can be "never found." A field we never read was never
    // looked for, so its absence from keysSeen says nothing about the payload.
    const neverSeen = [...READ_FIELDS].filter(
        (f) => !track.keysSeen.has(f) && !REQUIRED_FIELDS.includes(f)
    );

    for (const field of neverSeen) {
        warnings.push(
            `Field "${field}" was not found on ANY liability under any candidate key ` +
            `(tried: ${FIELD[field].join(", ")}). Every value is null. If this attribute ` +
            `genuinely exists on this bureau's reports, the candidate key list is wrong.`
        );
    }

    // ---- extraction_ok -------------------------------------------------------
    //
    // FAIL CLOSED ON PARTIAL EXTRACTION. A partly-parsed report is MORE DANGEROUS
    // than no report: the Intelligence Engine detects deletions BY ABSENCE, so a
    // tradeline we merely failed to parse is indistinguishable from one the bureau
    // deleted — producing a fabricated "deletion" that flows into a letter.
    const extractionOk =
        errors.length === 0 &&
        keyResolution.accounts.ambiguous.length === 0 &&
        keyResolution.tradelines.ambiguous.length === 0;

    const tradelines = accounts.flatMap((a) => a.bureau_tradelines);

    return {
        extraction_ok: extractionOk,

        report: {
            crc_client_id: crcClientId ?? null,
            model_version: MODEL_VERSION,

            report_metadata: {
                report_date: toDate(response["@CreditReportFirstIssuedDate"]),
                report_identifier: response["@CreditReportIdentifier"] ?? null,
                mismo_version: response["@MISMOVersionID"] ?? null,
                merge_type: response["@CreditReportMergeTypeIndicator"] ?? null,
                bureaus_present: [...new Set(tradelines.map((t) => t.bureau))],
                source: "credit_hero_array_io",
                captured_at: new Date().toISOString(),
            },

            // EVIDENCE ONLY. NOT identity. CRC is authoritative for identity, and
            // nothing downstream may populate a letter header from this block.
            reported_personal_information: {
                raw: response.BORROWER ?? null,
            },

            accounts,
            inquiries,
            scores,

            key_index: {
                accounts: accounts.map((a) => ({
                    key: a.stable_account_key,
                    signatures: a.signatures,
                })),
                tradelines: tradelines.map((t) => ({
                    key: t.stable_item_key,
                    signatures: t.signatures,
                })),
            },
        },

        // ---- THE COUNTS YOU ASKED FOR --------------------------------------
        //
        // #4 (eligible negative) and #5 (excluded) are DELIBERATELY ABSENT.
        // Computing them here would put dispute eligibility inside the normalizer —
        // the exact coupling you ruled out. They are produced by decideDisputes /
        // selectStrategy, from these facts plus Business Trappers policy.
        counts: {
            raw_liability_rows: liabilities.length,
            unique_accounts: accounts.length,
            account_bureau_tradelines: tradelines.length,

            liabilities_naming_multiple_bureaus: liabilities.filter(
                (l) => toArray(l.CREDIT_REPOSITORY).length > 1
            ).length,

            observations_bureau_specific: tradelines.filter(
                (t) => t.observation.basis === BASIS.BUREAU_SPECIFIC
            ).length,

            observations_shared: tradelines.filter(
                (t) => t.observation.basis === BASIS.SHARED_ACROSS_BUREAUS
            ).length,

            inquiries: inquiries.length,

            note:
                "eligible_negative_tradelines and excluded_tradelines are NOT reported here. " +
                "Eligibility is determined by the Strategy Engine from these facts plus Business " +
                "Trappers policy — not by the normalizer, and never from a raw row count.",
        },

        completeness: {
            sections_found: Object.keys(response).filter((k) => k.startsWith("CREDIT_") || k === "BORROWER"),

            // A GENUINE mapping concern: a field whose key appeared on NO liability
            // under any candidate. THIS is the "not found" that means something is
            // wrong. It replaces the old fields_not_found, which flagged any field
            // that was ever null on any row — and therefore flagged DOFD, a field
            // working exactly as intended.
            fields_never_found: neverSeen,

            // Present-but-null on at least one row. LEGITIMATE ABSENCE, reported for
            // transparency, NOT as a defect. "This bureau does not report a close
            // date on this account" lives here. The Intelligence Engine treats an
            // absence here as disputable evidence (Extraction §6.1), never as a bug.
            fields_present_but_null: [...track.valueless],

            // Defined in the field map but NOT read into the model. These exist in
            // the payload (field-map sees them) but no engine consumes them yet.
            // Surfaced so the gap is visible and a product decision — not silently
            // dropped, and NOT mistaken for a missing key.
            fields_defined_but_not_read: DEFINED_NOT_READ,

            warnings,
        },

        key_resolution: keyResolution,
        errors,
    };
}

function fail(code, message) {
    return {
        extraction_ok: false,
        report: null,
        counts: null,
        completeness: { sections_found: [], fields_never_found: [], fields_present_but_null: [], fields_defined_but_not_read: [], warnings: [] },
        key_resolution: null,
        errors: [`${code}: ${message}`],
    };
}
