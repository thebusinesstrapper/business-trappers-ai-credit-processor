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
    readVendorIdentifiers, acctLast4, furnisherNorm,
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
    // The bureau's current rating word — the strongest status signal on ListAndStack
    // reports (e.g. "CollectionOrChargeOff"). @RawAccountStatus is frequently absent;
    // this and account_status_type carry the real status.
    current_rating: ["@_CurrentRatingType", "_CURRENT_RATING", "@_CurrentRating"],
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
    "responsibility", "current_rating",
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
/**
 * Resolve a field value to its scalar TEXT.
 *
 * MISMO/Array serializes some elements (e.g. _CURRENT_RATING) as an OBJECT whose
 * text lives under a nested key — not as a bare string. Assigning that object to
 * normalized.status stringified to "[object Object]" downstream, which the analyzer
 * could not categorize. This pulls the text out of the known parser shapes and
 * leaves plain strings (and numbers) untouched. Never String(object) — that is
 * exactly the "[object Object]" defect.
 *
 * Returns a trimmed non-empty string, or null.
 */
function scalarText(value) {
    if (value === null || value === undefined) return null;

    // Already scalar: pass through unchanged.
    if (typeof value === "string") {
        const t = value.trim();
        return t === "" ? null : t;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);

    if (typeof value === "object") {
        // Known MISMO / xml-parser text carriers, in priority order. These mirror
        // the shapes already handled elsewhere in this file (@_Text, @_Code, @_Value).
        const candidates = [
            value["@_Type"], value["@_Code"], value["@_Value"], value["@_Text"],
            value["#text"], value["_Text"], value["@_TypeOtherDescription"],
        ];
        for (const c of candidates) {
            if (typeof c === "string" && c.trim() !== "") return c.trim();
            if (typeof c === "number") return String(c);
        }
    }

    // Unknown object shape: do NOT stringify to "[object Object]". Fail closed to
    // null so the coalesce falls through to the next status candidate.
    return null;
}

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

/**
 * Coerce a reported date string to ISO YYYY-MM-DD for REASONING.
 *
 * The reported string is preserved untouched in Layer 2; this is Layer 1 only.
 *
 * Handles the formats a credit report actually uses: ISO (2022-05-01) and US
 * (05/01/2022). A value we CANNOT parse returns null — never a guess. That matters:
 * a normalized DOFD feeds the obsolescence guardrail (BT-DM-0051) and DOFD-conflict
 * (BT-DM-0034), and a silently-null date would make obsolescence INDETERMINATE
 * rather than computed — the guardrail would never fire, with no error. The exact
 * date FORMAT in the payload is not yet confirmed from production, so we parse the
 * plausible ones and return null (not a guess) for anything else.
 */
function toDate(value) {
    if (!value) return null;

    const str = String(value).trim();

    // ISO: 2022-05-01
    let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;

    // US: 05/01/2022  or  5/1/2022
    m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
        const mm = m[1].padStart(2, "0");
        const dd = m[2].padStart(2, "0");
        return `${m[3]}-${mm}-${dd}`;
    }

    // Anything else -> null. NOT a guess. The reported string still holds the truth.
    return null;
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
/**
 * ===========================================================================
 * IDENTITY OF A BUREAU TRADELINE — for FOLDING within one report.
 *
 * The legal unit is the BUREAU TRADELINE: "Navy Federal on TransUnion". That is
 * what a bureau reinvestigates, so that is what we dispute.
 *
 * Array's ROW STRUCTURE is not the business model. It may serialise one bureau
 * tradeline as a merged {TU, EXP} row AND a separate {TU} row in the same report.
 * Both are describing the SAME TransUnion tradeline. They are not a collision to
 * reject — they are two observations to fold.
 *
 * IDENTITY IS DELIBERATELY NARROW AND STABLE:
 *   bureau + masked-account-last-4 + normalized furnisher.
 *
 * NOT in identity, ON PURPOSE:
 *   - Balance, status, dates, payment history — these are MUTABLE. A value
 *     mismatch between two observations of the same tradeline is expected, and
 *     must never split one tradeline into two.
 *   - Tradeline hash — CHANGE DETECTION ONLY (§7.4). It incorporates mutable data
 *     by design, so hash drift is expected on the same tradeline. Letting it into
 *     identity would fail closed on tradelines that are unambiguously the same.
 *
 * We fold when identity matches. We fail closed ONLY when identity itself cannot
 * be established as the same — a different masked account or a different furnisher.
 * ===========================================================================
 */
function tradelineIdentity(bureau, maskedAccount, furnisher) {
    return {
        bureau,
        masked_account: maskedAccount,
        last4: acctLast4(maskedAccount),
        // The SAME normalization the key cascade uses (itemKey.furnisherNorm),
        // including its alias table — so a tradeline's fold identity and its key
        // identity can never disagree about who the furnisher is.
        furnisher_norm: furnisherNorm(furnisher),
    };
}

/**
 * Do two identities denote the SAME bureau tradeline?
 *
 * Same bureau is a precondition (we only ever compare within one bureau slot).
 * Then: the masked-account last-4 must match, and the normalized furnisher must
 * match. A null on EITHER side of a field is NOT a match — we do not fold on
 * absence, because "we could not read the account number" is not evidence that
 * two tradelines are the same.
 */
function sameTradelineIdentity(a, b) {
    if (a.bureau !== b.bureau) return false;

    // Prefer exact full masked-account equality. This covers bureau formats that
    // contain no readable trailing digits at all (for example
    // SSE001XXXXXXXXXX). Two rows with the same Array account id, same bureau,
    // and the exact same bureau-reported masked account are the same tradeline,
    // even when acctLast4() correctly returns null.
    const fullA = canonicalMaskedAccount(a.masked_account);
    const fullB = canonicalMaskedAccount(b.masked_account);

    if (fullA && fullB && fullA === fullB) return true;

    // Otherwise require a real matching last-4. Absence never confirms identity.
    if (a.last4 === null || b.last4 === null || a.last4 !== b.last4) return false;

    // Furnisher-name differences alone never split an account that account-number
    // evidence joins. The exact bureau-reported furnisher string is still
    // preserved for the letter.
    return true;
}

/**
 * Fold a NEW observation into an EXISTING bureau tradeline of the same identity.
 *
 *   - BUREAU-SPECIFIC WINS. A row naming only this bureau is that bureau's own
 *     reporting; a merged row's value is SHARED across bureaus and less
 *     specifically attributable. When both exist, the bureau-specific one is the
 *     tradeline's observation.
 *   - THE LOSER IS NOT DISCARDED. It is preserved under folded_observations, so a
 *     value the winner overrode — a status the merged row disagreed on — remains
 *     available to the Intelligence Engine as evidence. It is NEVER asserted in a
 *     letter; it is retained, not used.
 *
 * This function decides ONLY which observation is primary and records the other.
 * It never invents a value and never blends two observations into a third.
 */
function foldInto(existing, incoming) {
    const existingSpecific = existing.observation.basis === BASIS.BUREAU_SPECIFIC;
    const incomingSpecific = incoming.observation.basis === BASIS.BUREAU_SPECIFIC;

    // Default: keep existing as primary, record incoming as folded-away.
    let primary = existing;
    let secondary = incoming;

    // Bureau-specific beats shared. If the incoming one is specific and the
    // current primary is not, promote the incoming observation.
    if (incomingSpecific && !existingSpecific) {
        primary = incoming;
        secondary = existing;
    }

    const folded = primary.folded_observations ?? [];

    folded.push({
        from_row: secondary.source_row_index,
        basis: secondary.observation.basis,
        observation: secondary.observation,
        vendor_identifiers: secondary.vendor_identifiers,
        note:
            "Folded away: a second observation of the SAME bureau tradeline. The " +
            "bureau-specific observation is primary. Retained as evidence for the " +
            "Intelligence Engine; never asserted in a letter.",
    });

    // Carry any folded history the secondary itself accumulated.
    for (const f of secondary.folded_observations ?? []) folded.push(f);

    primary.folded_observations = folded;

    return primary;
}

/**
 * ===========================================================================
 * TWO LAYERS, PER THE BUREAU FIDELITY STANDARD™.
 *
 *   reported{}   — LAYER 2. Every value EXACTLY as the bureau wrote it, as a
 *                  STRING. "$4,200.00" stays "$4,200.00". A date stays in the
 *                  bureau's own format. This is authoritative for anything a
 *                  human outside the AI ever sees — above all, letters.
 *
 *   normalized{} — Coerced values for the Intelligence Engine to REASON with:
 *                  4200 (number), "2022-05-01" (ISO date). Internal only. Never
 *                  the source of anything printed.
 *
 * Each raw string is read ONCE, then kept in `reported` AND coerced into
 * `normalized`. The original is never thrown away — which was the latent
 * violation before this refactor: toNumber/toDate/toBool discarded the bureau's
 * own formatting, so a faithful letter could not have been generated from the
 * model even though the model claimed to hold the data.
 *
 * `basis` travels alongside (§3.3): a SHARED value is preserved verbatim but is
 * not individually attributed to this bureau.
 * ===========================================================================
 */
function buildObservation(liability, basis, sharedWith, track) {
    // Read every field ONCE, as the raw string the bureau wrote.
    const raw = {
        balance: readField(liability, "balance", track),
        past_due: readField(liability, "past_due", track),
        monthly_payment: readField(liability, "monthly_payment", track),
        credit_limit: readField(liability, "credit_limit", track),
        high_balance: readField(liability, "high_balance", track),

        date_opened: readField(liability, "date_opened", track),
        date_reported: readField(liability, "date_reported", track),
        date_closed: readField(liability, "date_closed", track),
        dofd: readField(liability, "dofd", track),
        last_payment_date: readField(liability, "last_payment_date", track),

        account_status: readField(liability, "raw_account_status", track),
        current_rating: readField(liability, "current_rating", track),
        account_type: readField(liability, "raw_account_type", track),
        industry: readField(liability, "raw_industry_text", track),
        account_status_type: readField(liability, "account_status_type", track),
        responsibility: readField(liability, "responsibility", track),

        months_reviewed: readField(liability, "months_reviewed", track),
        terms_months: readField(liability, "terms_months", track),

        is_closed: readField(liability, "is_closed", track),
        is_chargeoff: readField(liability, "is_chargeoff", track),
        is_collection: readField(liability, "is_collection", track),
        is_mortgage: readField(liability, "is_mortgage", track),
        is_secured: readField(liability, "is_secured", track),
        is_student_loan: readField(liability, "is_student_loan", track),
        is_fed_guaranteed_student_loan: readField(liability, "is_fed_guaranteed_student_loan", track),
        consumer_disputed: readField(liability, "consumer_disputed", track),
        derogatory: readField(liability, "derogatory", track),
    };

    const paymentHistory = readPaymentPattern(liability);
    const lateCounts = readLateCounts(liability);
    const remarks = readComments(liability);

    return {
        basis,
        shared_with: sharedWith.length ? sharedWith : null,

        // ---- LAYER 2: exactly as the bureau reported it. Strings, verbatim. ----
        reported: {
            balance: raw.balance,
            past_due: raw.past_due,
            monthly_payment: raw.monthly_payment,
            credit_limit: raw.credit_limit,
            high_balance: raw.high_balance,

            date_opened: raw.date_opened,
            date_reported: raw.date_reported,
            date_closed: raw.date_closed,
            dofd: raw.dofd,
            last_payment_date: raw.last_payment_date,

            account_status: raw.account_status,
            account_type: raw.account_type,
            account_status_type: scalarText(raw.account_status_type),
            // Verbatim bureau current-rating (Layer 2). On ListAndStack this carries
            // the reportable status word (e.g. "CollectionOrChargeOff") when
            // @RawAccountStatus is absent. Scalarized because _CURRENT_RATING may be
            // a nested object. Quoting-eligible for Bureau Fidelity.
            current_rating: scalarText(raw.current_rating),
            industry: raw.industry,
            responsibility: raw.responsibility,

            months_reviewed: raw.months_reviewed,
            terms_months: raw.terms_months,

            is_closed: raw.is_closed,
            is_chargeoff: raw.is_chargeoff,
            is_collection: raw.is_collection,
            is_mortgage: raw.is_mortgage,
            is_secured: raw.is_secured,
            is_student_loan: raw.is_student_loan,
            is_fed_guaranteed_student_loan: raw.is_fed_guaranteed_student_loan,
            consumer_disputed: raw.consumer_disputed,
            derogatory: raw.derogatory,

            payment_history: paymentHistory?.data ?? null,
            remarks,
        },

        // ---- NORMALIZED: for AI reasoning only. Never printed. ----------------
        normalized: {
            balance: toNumber(raw.balance),
            past_due: toNumber(raw.past_due),
            monthly_payment: toNumber(raw.monthly_payment),
            credit_limit: toNumber(raw.credit_limit),
            high_balance: toNumber(raw.high_balance),

            date_opened: toDate(raw.date_opened),
            date_reported: toDate(raw.date_reported),
            date_closed: toDate(raw.date_closed),
            date_of_first_delinquency: toDate(raw.dofd),
            last_payment_date: toDate(raw.last_payment_date),

            is_closed: toBool(raw.is_closed),
            is_chargeoff: toBool(raw.is_chargeoff),
            is_collection: toBool(raw.is_collection),
            is_mortgage: toBool(raw.is_mortgage),
            is_secured: toBool(raw.is_secured),
            is_student_loan: toBool(raw.is_student_loan),
            is_fed_guaranteed_student_loan: toBool(raw.is_fed_guaranteed_student_loan),
            consumer_disputed: toBool(raw.consumer_disputed),
            derogatory: toBool(raw.derogatory),

            months_reviewed: toNumber(raw.months_reviewed),
            terms_months: toNumber(raw.terms_months),

            // A normalized STATUS for reasoning. The Intelligence Engine classifies
            // on this; letters use reported.account_status (Layer 2) verbatim. Kept
            // as the raw string here — normalizeStatus() in the analyzer maps it —
            // so the two layers never share a coercion the letter could inherit.
            // Coalesced status for REASONING only. Bureau Fidelity's verbatim
            // reported.account_status is untouched. Order: current rating (strongest
            // negativity signal) -> account status type -> raw account status.
            // Every candidate is scalarized (MISMO may nest the value as an object);
            // fallback order unchanged: current rating -> account status type -> raw.
            status:
                scalarText(raw.current_rating) ??
                scalarText(raw.account_status_type) ??
                scalarText(raw.account_status) ??
                null,
            account_status_type: raw.account_status_type,

            // Responsibility is NOT coerced — the Decision Engine interprets it
            // against a vocabulary read from real data. We keep the string in both
            // layers deliberately.
            responsibility: raw.responsibility,

            payment_history: paymentHistory,
            late_counts: lateCounts,
        },
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

/**
 * Canonical full masked-account value for exact cross-group duplicate detection.
 *
 * Array sometimes assigns DIFFERENT @ArrayAccountIdentifier values to rows that
 * still describe the same bureau tradeline. Grouping only by Array's identifier
 * therefore leaves duplicates in the finished model. We do not merge on last-4
 * here; that would be too broad across unrelated accounts. We require the same
 * bureau and the same full masked account string after punctuation/spacing
 * normalization.
 */
function canonicalMaskedAccount(value) {
    if (value === null || value === undefined) return null;

    const normalized = String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

    return normalized || null;
}

function mergeExactDuplicateTradelines(existing, incoming) {
    const existingSpecific = existing.observation?.basis === BASIS.BUREAU_SPECIFIC;
    const incomingSpecific = incoming.observation?.basis === BASIS.BUREAU_SPECIFIC;
    const existingNamed = Boolean(String(existing.furnisher ?? "").trim());
    const incomingNamed = Boolean(String(incoming.furnisher ?? "").trim());

    let primary = existing;
    let secondary = incoming;

    if (
        (incomingSpecific && !existingSpecific) ||
        (incomingSpecific === existingSpecific && incomingNamed && !existingNamed)
    ) {
        primary = incoming;
        secondary = existing;
    }

    const folded = [
        ...(primary.folded_observations ?? []),
        {
            from_row: secondary.source_row_index,
            basis: secondary.observation?.basis ?? null,
            observation: secondary.observation,
            vendor_identifiers: secondary.vendor_identifiers,
            note:
                "Folded across Array account groups: same bureau and exact full masked " +
                "account. Array supplied a different @ArrayAccountIdentifier, but the " +
                "bureau tradeline identity is the same. Retained as evidence; never " +
                "asserted as a separate account in a letter.",
        },
        ...(secondary.folded_observations ?? []),
    ];

    return {
        ...primary,

        // Preserve a known bureau-reported furnisher when the winning observation
        // is otherwise stronger but left the furnisher blank.
        furnisher:
            String(primary.furnisher ?? "").trim()
                ? primary.furnisher
                : (String(secondary.furnisher ?? "").trim() ? secondary.furnisher : null),

        // Keep the first-emitted stable key so key identity does not change merely
        // because a later duplicate observation was more complete.
        stable_item_key: existing.stable_item_key,

        signatures: [
            ...new Set([
                ...(existing.signatures ?? []),
                ...(incoming.signatures ?? []),
            ]),
        ],

        folded_observations: folded,
    };
}

/**
 * Consolidate exact duplicate bureau tradelines that escaped the per-Array-ID
 * folding pass.
 *
 * This is deliberately stricter than sameTradelineIdentity():
 *   - same bureau
 *   - same FULL masked account, not merely last-4
 *
 * It never merges an item whose masked account is missing.
 */
function consolidateCrossGroupDuplicates(accounts, warnings, keyResolution) {
    const seen = new Map();
    const output = [];

    for (const account of accounts) {
        const keptTradelines = [];

        for (const tradeline of account.bureau_tradelines ?? []) {
            const masked = canonicalMaskedAccount(tradeline.masked_account);

            if (!masked) {
                keptTradelines.push(tradeline);
                continue;
            }

            const key = `${tradeline.bureau}|${masked}`;
            const prior = seen.get(key);

            if (!prior) {
                keptTradelines.push(tradeline);
                seen.set(key, {
                    accountRef: account,
                    tradelineRef: tradeline,
                    keptTradelines,
                    index: keptTradelines.length - 1,
                });
                continue;
            }

            const merged = mergeExactDuplicateTradelines(prior.tradelineRef, tradeline);
            prior.keptTradelines[prior.index] = merged;
            prior.tradelineRef = merged;

            keyResolution.tradelines.folded_cross_group =
                (keyResolution.tradelines.folded_cross_group ?? 0) + 1;

            warnings.push(
                `Folded duplicate ${tradeline.bureau} tradeline with masked account ` +
                `"${tradeline.masked_account}" across different Array account groups.`
            );
        }

        if (keptTradelines.length > 0) {
            output.push({
                ...account,
                bureau_tradelines: keptTradelines,
            });
        }
    }

    return output;
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

                const furnisher = readCreditor(liability);
                const maskedAccount = readField(liability, "masked_account", track);
                const observation = buildObservation(liability, basis, sharedWith, track);

                const candidateTradeline = {
                    bureau,
                    furnisher,
                    masked_account: maskedAccount,
                    observation,
                    vendor_identifiers: readVendorIdentifiers(liability),
                    source_row_index: index,
                    identity: tradelineIdentity(bureau, maskedAccount, furnisher),
                    raw: liability,
                };

                // ---- COLLISION IS THE NORMAL CASE. FOLD, DON'T REJECT. --------
                //
                // The legal unit is the BUREAU TRADELINE, not Array's row. Array
                // may describe one TransUnion tradeline as a merged {TU, EXP} row
                // AND a separate {TU} row in the same report. Both observe the SAME
                // tradeline; they are folded, not treated as two.
                // Slot key is bureau + last-4, NOT bureau alone. Two DIFFERENT
                // accounts reported by the same bureau (different last-4 — e.g. two
                // separate Aidvantage student loans) must occupy DIFFERENT slots and
                // remain independent tradelines. Same last-4 shares a slot and folds.
                const bureauSlot = `${bureau}|${candidateTradeline.identity.last4 ?? "no-last4"}`;

                if (byBureau.has(bureauSlot)) {
                    const existing = byBureau.get(bureauSlot);

                    // FAIL CLOSED ONLY ON A GENUINE IDENTITY CONFLICT.
                    //
                    // Identity = bureau + masked-last-4 + normalized furnisher. If
                    // these do not match, Array has put two DIFFERENT tradelines on
                    // the same account+bureau slot, and folding would force us to
                    // pick a masked account or a furnisher — fabrication. That still
                    // routes to manual review.
                    if (!sameTradelineIdentity(existing.identity, candidateTradeline.identity)) {
                        errors.push(
                            `(account, bureau) IDENTITY CONFLICT: account ${stableAccountKey}, ` +
                            `bureau ${bureau}, rows ${existing.source_row_index} and ${index} share an ` +
                            `Array account id and bureau but differ in tradeline IDENTITY ` +
                            `(masked account or furnisher). These are not the same tradeline and we ` +
                            `will not choose between them. Manual review.`
                        );

                        keyResolution.tradelines.ambiguous.push({
                            stable_account_key: stableAccountKey,
                            bureau,
                            rows: [existing.source_row_index, index],
                            existing_identity: existing.identity,
                            conflicting_identity: candidateTradeline.identity,
                        });

                        continue;
                    }

                    // Same identity -> fold. Bureau-specific wins; the other is kept
                    // as folded-away evidence, never discarded, never asserted.
                    const folded = foldInto(existing, candidateTradeline);

                    // The folded tradeline keeps the existing key (identity is
                    // unchanged), but adopts the winning observation and notes.
                    byBureau.set(bureauSlot, {
                        ...existing,
                        observation: folded.observation,
                        vendor_identifiers: folded.vendor_identifiers,
                        source_row_index: folded.source_row_index,
                        folded_observations: folded.folded_observations,
                    });

                    keyResolution.tradelines.folded =
                        (keyResolution.tradelines.folded ?? 0) + 1;

                    continue;
                }

                const tlSigs = tradelineSignatures(
                    {
                        "@TradelineHashSimple": liability["@TradelineHashSimple"] ?? null,
                        masked_account: maskedAccount,
                        furnisher,
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

                byBureau.set(bureauSlot, {
                    stable_item_key: tlResolved.key,
                    ...candidateTradeline,
                    signatures: tlSigs.map((s) => s.value),
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

    // Array can assign different @ArrayAccountIdentifier values to rows that
    // nevertheless describe the same bureau tradeline. Consolidate only when the
    // bureau and FULL masked account match exactly after normalization.
    const consolidatedAccounts = consolidateCrossGroupDuplicates(
        accounts,
        warnings,
        keyResolution
    );

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

    const tradelines = consolidatedAccounts.flatMap((a) => a.bureau_tradelines);

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

            accounts: consolidatedAccounts,
            inquiries,
            scores,

            key_index: {
                accounts: consolidatedAccounts.map((a) => ({
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
            unique_accounts: consolidatedAccounts.length,
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
