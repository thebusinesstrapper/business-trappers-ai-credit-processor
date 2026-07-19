/**
 * generateLetter.js
 *
 * LETTER GENERATION ENGINE.
 *
 * ---------------------------------------------------------------------------
 * THE ANALYSIS ENGINE EXPLAINS. THE LETTER ENGINE ASSERTS.
 *
 * The bureau does not need our reasoning. It needs the dispute:
 *
 *     Creditor
 *     Account number — EXACTLY as THIS bureau reports it
 *     The reporting defect
 *     The standard or law it fails
 *     The requested remedy
 *
 * Nothing else. No narration, no explanation of how we found it, no argument.
 *
 * ---------------------------------------------------------------------------
 * RULE 1 — CROSS-BUREAU EVIDENCE IS INTERNAL ONLY.
 *
 * A letter to TransUnion NEVER mentions Experian or Equifax. Cross-bureau
 * findings drive STRATEGY; they never appear in correspondence.
 *
 * This has a consequence that must not be papered over:
 *
 *   A cross-bureau conflict proves ONE bureau is wrong. It does NOT prove WHICH.
 *
 * So the engine holds a hard line in its own wording:
 *
 *   SELF-EVIDENT defect (the bureau's record contradicts ITSELF)
 *       -> ASSERT.  "This account is reported with a past-due amount of $4,200
 *                    and a balance of $0."
 *
 *   CROSS-BUREAU conflict (someone else disagrees)
 *       -> DISPUTE. "I dispute the accuracy of the status reported for this
 *                    account and request reinvestigation."
 *
 * The consumer genuinely DOES dispute it — that is true, and she may say so
 * under FCRA §611 without proving anything. What she may NOT say is that THIS
 * bureau is the wrong one, because we do not know that. Writing "Experian
 * reports this inaccurately" on cross-bureau evidence alone would invent a fact.
 *
 * ---------------------------------------------------------------------------
 * RULE 2 — THE ACCOUNT NUMBER IS THE BUREAU'S OWN.
 *
 * The bureau tradeline is the legal unit of dispute, so the dispute must carry
 * THAT BUREAU'S masked account number, verbatim. TransUnion's "****6095" and
 * Experian's "6095XXXXXXXX" are the same account and DIFFERENT strings. Sending
 * a bureau a format it does not use invites "unable to locate".
 *
 * An account we cannot identify to the bureau is an account we do not dispute.
 * No account number -> the item is withheld and routed to a human, never sent
 * unidentifiable.
 *
 * ---------------------------------------------------------------------------
 * NO GPT. DETERMINISTIC. Every sentence traces to a finding the Analysis Engine
 * observed. Invention is structurally impossible, and the same letter
 * regenerates byte-identically — a letter we cannot reproduce is a letter we
 * cannot defend later.
 * ---------------------------------------------------------------------------
 */

import { verifyIdentity, formatAddress } from "./clientIdentity.js";
import { selectVoice, resolveRecipient } from "./voice/index.js";
import { createBureauFidelity, hasReported, NO_REPORTED_VALUE } from "../bureauFidelity.js";

export const LETTER_SCHEMA_VERSION = "BT-LETTER-3.0";

const BUREAU_NAMES = {
    transunion: "TransUnion",
    experian: "Experian",
    equifax: "Equifax",
};

const BUREAU_ADDRESSES = {
    transunion: "TransUnion Consumer Solutions\nP.O. Box 2000\nChester, PA 19016-2000",
    experian: "Experian\nP.O. Box 4500\nAllen, TX 75013",
    equifax: "Equifax Information Services LLC\nP.O. Box 740256\nAtlanta, GA 30374-0256",
};

// Authorities. ONE per defect — the STRONGEST applicable, never a stack.
// (Consumer Law Reference: "Apply the strongest applicable authority — not the
// greatest number of authorities." "Do not cite laws to intimidate.")
// Money as the bureau writes it.
function money(v) {
    const n = Number(v);
    return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : `$${v}`;
}

/**
 * ===========================================================================
 * quote() — THE BUREAU FIDELITY ENFORCEMENT POINT.
 *
 * A defect template receives a `q` object, and the ONLY way it may emit a bureau
 * value is through `q`. `q` reads exclusively from the tradeline's reported view
 * (Layer 2). There is no path from `q` to the normalized layer, so a template
 * CANNOT quote a coerced value even by mistake.
 *
 * When the reported value is absent, `q` returns a LOUD marker string, not "".
 * A blank would print as an intentional gap in a letter; the marker is visible to
 * a human and is caught by the leak-check against the generated body. A template
 * that quotes an absent value fails LOUDLY, never silently.
 *
 * The values printed are the bureau's OWN strings, verbatim — "$4,200.00" stays
 * "$4,200.00". money() is NOT applied: reformatting a reported number is itself a
 * fidelity violation (it would turn the bureau's "$4,200.00" into our "$4,200").
 * ===========================================================================
 */
export const FIDELITY_MISSING_MARKER = "[REPORTED VALUE UNAVAILABLE — DO NOT SEND]";

// Consumer-facing tokens that must NEVER appear in a finished letter body. A body
// containing any of these is unsendable and must be withheld + routed to review.
export const FORBIDDEN_LETTER_TOKENS = Object.freeze([
    FIDELITY_MISSING_MARKER,   // "[REPORTED VALUE UNAVAILABLE — DO NOT SEND]"
    "DO NOT SEND",
    "undefined",
    "null",
]);

/**
 * Screen finished letters for unsendable content. Pure and side-effect free.
 * Returns, for each letter, which forbidden tokens (if any) its body contains.
 */
export function screenLetterContent(letters) {
    // The DO-NOT-SEND marker and "DO NOT SEND" are distinctive literals — substring
    // matching is safe. But "null"/"undefined" appear inside ordinary words
    // ("annulled", "fundamentally"), so those must match only as WHOLE TOKENS —
    // the stringified-value defect always emits them standalone, never mid-word.
    const literalTokens = [FIDELITY_MISSING_MARKER, "DO NOT SEND"];
    const wholeWordTokens = [
        { token: "undefined", re: /\bundefined\b/ },
        { token: "null", re: /\bnull\b/ },
    ];
    // KRIS FIRM-LANGUAGE GATE (2026-07-16). These consumer-facing patterns are
    // prohibited in production letters: the "only" conditional-deletion clause,
    // and soft/courtesy phrasing that makes a legally required action sound
    // optional. Case-insensitive; matched only in finished letter prose.
    const prohibitedLanguage = [
        { token: "delete the item only if", re: /delete the item only if/i },
        { token: "delete only if", re: /delete only if/i },
        { token: "I would appreciate", re: /I would appreciate/i },
        { token: "thank you for your", re: /thank you for your/i },
        { token: "please investigate", re: /please investigate/i },
    ];
    return letters.map((letter) => {
        const body = letter.body ?? "";
        const hits = [
            ...literalTokens.filter((tok) => body.includes(tok)),
            ...wholeWordTokens.filter((w) => w.re.test(body)).map((w) => w.token),
            ...prohibitedLanguage.filter((w) => w.re.test(body)).map((w) => w.token),
        ];
        return {
            bureau: letter.bureau,
            bureauName: letter.bureauName,
            stableItemKeys: letter.stableItemKeys ?? [],
            hits,
        };
    });
}

function makeQuoter(reportedView) {
    // Each quoter method returns the verbatim reported string, or the loud marker.
    const q = (accessorValue) =>
        hasReported(accessorValue) ? String(accessorValue) : FIDELITY_MISSING_MARKER;

    return {
        balance: () => q(reportedView.balance()),
        pastDue: () => q(reportedView.pastDue()),
        status: () => q(reportedView.status()),
        dofd: () => q(reportedView.dateOfFirstDelinquency()),
        dateOpened: () => q(reportedView.dateOpened()),
        furnisher: () => q(reportedView.furnisher()),
    };
}

const AUTH = {
    ACCURACY: "FCRA § 607(b) (15 U.S.C. § 1681e(b)) — reasonable procedures to assure maximum possible accuracy.",
    REINVESTIGATION: "FCRA § 611 (15 U.S.C. § 1681i) — reinvestigation of disputed information.",
    OBSOLETE: "FCRA § 605 (15 U.S.C. § 1681c) — obsolete information may not be reported.",
    DOFD: "FCRA § 605(c) (15 U.S.C. § 1681c(c)) — the reporting period runs from the date of first delinquency.",
    // BT-DM-0001 v2.1 Addendum / BT-CW-0003. Deliberately NOT added to
    // AUTHORITY_PRIORITY: it governs inquiries only, and must not alter the
    // authority chosen for any tradeline.
    PERMISSIBLE_PURPOSE:
        "FCRA § 604 (15 U.S.C. § 1681b) — a consumer report may be furnished only for a permissible purpose.",
};

// BT-DM-0001 v2.1 Addendum — required wording, stated verbatim.
const INQUIRY_STATEMENT =
    "I do not recognize this inquiry. Please identify and verify the permissible purpose " +
    "for accessing my credit file. If you cannot verify a lawful permissible purpose, " +
    "delete the inquiry.";

// Mirrors BT-DM-0001's governed remedy. Used only when the Strategy Engine
// supplies none, so the letter still does not invent a remedy of its own.
const INQUIRY_REMEDY =
    "Identify and verify the permissible purpose for this inquiry, and delete the inquiry " +
    "if a lawful permissible purpose cannot be verified.";

// STRONGEST FIRST. Exactly ONE authority is cited per account.
//
// Consumer Law Reference: "Apply the strongest applicable authority — not the
// greatest number of authorities." "Do not stack statutes unnecessarily."
// "Do not cite laws to intimidate."
//
// Stacking three statutes on one tradeline reads as intimidation, and it dilutes
// the one that actually governs. An obsolete account is an obsolescence case; it
// does not become a stronger one by also invoking accuracy and reinvestigation.
const AUTHORITY_PRIORITY = [AUTH.OBSOLETE, AUTH.DOFD, AUTH.ACCURACY, AUTH.REINVESTIGATION];

// NOTE: the Letter Engine no longer chooses the remedy. The STRATEGY chooses it,
// and it arrives on the chain item as `requestedRemedy`. A letter that picks its
// own remedy is a letter arguing with its own strategy.

/**
 * Each finding -> the four lines the bureau needs.
 *
 * `bureauLocal: false` marks a CROSS-BUREAU finding. It is still allowed into
 * the letter, but ONLY in disputed form and ONLY describing this bureau's own
 * value. It never names another bureau.
 *
 * A finding with no entry here produces NO letter text and the item is escalated
 * to human review — see `withheld`. It is never silently dropped.
 */
const SPEC = {
    TL_PAST_DUE_ON_ZERO_BALANCE: {
        bureauLocal: true,
        defect: (q) => `Reported with a past-due amount of ${q.pastDue()} and a balance of ${q.balance()}.`,
        standard: "An account with no balance cannot carry an amount past due. The reporting is internally inconsistent.",
        authority: AUTH.ACCURACY,
    },

    TL_PAST_DUE_EXCEEDS_BALANCE: {
        bureauLocal: true,
        defect: (q) => `Reported with a past-due amount of ${q.pastDue()}, exceeding the reported balance of ${q.balance()}.`,
        standard: "A past-due amount cannot exceed the balance owed. The reporting is internally inconsistent.",
        authority: AUTH.ACCURACY,
    },

    TL_DEROGATORY_WITHOUT_DOFD: {
        bureauLocal: true,
        defect: (q) => `Reported with a status of "${q.status()}" and no date of first delinquency.`,
        standard: "A derogatory account must carry a date of first delinquency. Without it, the permissible reporting period cannot be determined.",
        authority: AUTH.DOFD,
    },

    TL_DOFD_BEFORE_OPENED: {
        bureauLocal: true,
        defect: (q) => `Reported as first delinquent on ${q.dofd()}, before the account opened date of ${q.dateOpened()}.`,
        standard: "An account cannot become delinquent before it exists. The reporting is internally inconsistent.",
        authority: AUTH.ACCURACY,
    },

    TL_BEYOND_REPORTING_PERIOD: {
        bureauLocal: true,
        defect: (q) => `Reported with a date of first delinquency of ${q.dofd()}. The permissible reporting period has elapsed.`,
        standard: "Obsolete information may not be reported.",
        authority: AUTH.OBSOLETE,
    },

    TL_CLOSED_WITH_ACTIVE_STATUS: {
        bureauLocal: true,
        defect: () => `Reported as both closed and active.`,  // no quoted value
        standard: "An account cannot be simultaneously closed and active. The reporting is internally inconsistent.",
        authority: AUTH.ACCURACY,
    },

    TL_STATUS_CONFLICTS_WITH_PAYMENT_HISTORY: {
        bureauLocal: true,
        defect: (q) => `Reported with a status of "${q.status()}", while the payment history for the same account shows a recent late payment.`,
        standard: "The status and the payment history for one account must agree.",
        authority: AUTH.ACCURACY,
    },

    TL_DUPLICATE_WITHIN_BUREAU: {
        bureauLocal: true,
        // NAMED EXCEPTION (derived). `occurrences` is a COUNT the processor
        // computed — the bureau never reported it as a string, so it cannot come
        // from the Fidelity Layer. It is a derived fact about the reporting, not a
        // quoted reported value, and the leak-check permits it by name.
        derivedValues: ["occurrences"],
        defect: (q, e) => `Reported ${e.occurrences} times on my file.`,
        standard: "A single account may appear only once.",
        authority: AUTH.ACCURACY,
    },

    COL_MISSING_ORIGINAL_CREDITOR: {
        bureauLocal: true,
        // We may state what the report DOES NOT SAY. We may NOT conclude from
        // that silence that the debt "cannot be verified" — the bureau may hold
        // information we cannot see. Absence of a field in the report is not
        // proof of absence of verification.
        defect: () =>
            `The reporting does not identify the original creditor. I dispute the completeness and ` +
            `accuracy of this collection account and request a reasonable reinvestigation.`,
        standard: null,
        authority: AUTH.REINVESTIGATION,
    },

    COL_DUPLICATE_COLLECTION: {
        bureauLocal: true,
        defect: () => `The same debt is reported by more than one collection agency.`,  // no quoted value
        standard: "One debt may be reported as owed to one collector.",
        authority: AUTH.ACCURACY,
    },

    HIST_RE_AGING_INDICATOR: {
        bureauLocal: true,
        // NAMED EXCEPTION (cross-report). This defect compares THIS report against
        // a PRIOR one. `current_dofd` is this report's reported value; `previous_dofd`
        // is the prior report's reported value, which is not in the current
        // Fidelity Layer. Both are reported values from their respective reports —
        // a legitimate historical comparison the single-report view cannot express.
        // Permitted by name; see the cross-report fidelity note.
        derivedValues: ["previous_dofd", "current_dofd"],
        defect: (q, e) => `The date of first delinquency was previously reported as ${e.previous_dofd} and is now reported as ${e.current_dofd}.`,
        standard: "A date of first delinquency is a historical fact and does not change. Moving it forward extends the reporting period.",
        authority: AUTH.DOFD,
    },

    HIST_BALANCE_INCREASED_ON_CHARGED_OFF: {
        bureauLocal: true,
        // NAMED EXCEPTION (cross-report). Compares this report to a prior one.
        // `current` and `previous` are reported balances from their respective
        // reports. NOTE: this still routes through evidence, because the PRIOR
        // report's reported layer is not held by the current Fidelity Layer. When
        // multi-report Fidelity lands, `current` should be quoted via q.balance();
        // `previous` needs the prior report's view. Flagged, not silently accepted.
        derivedValues: ["previous", "current"],
        defect: (q, e) => `The balance on this charged-off account increased from ${e.previous} to ${e.current}.`,
        standard: "A charged-off balance does not increase.",
        authority: AUTH.ACCURACY,
    },

    // ---- CROSS-BUREAU: DISPUTED, NEVER ASSERTED --------------------------
    //
    // We know SOMEONE is wrong. We do not know it is THIS bureau. So the letter
    // records a dispute and requests reinvestigation — it does not claim this
    // bureau's value is false, and it names no other bureau.

    TL_XB_STATUS_INCONSISTENT: {
        bureauLocal: false,
        defect: (e) => `The account status is reported as ${e.this_bureau?.value ?? "shown"}. I dispute the accuracy of this status.`,
        standard: null,
        authority: AUTH.REINVESTIGATION,
    },

    TL_XB_BALANCE_INCONSISTENT: {
        bureauLocal: false,
        defect: () => `I dispute the accuracy of the balance reported for this account.`,
        standard: null,
        authority: AUTH.REINVESTIGATION,
    },

    TL_XB_PAST_DUE_INCONSISTENT: {
        bureauLocal: false,
        defect: () => `I dispute the accuracy of the past-due amount reported for this account.`,
        standard: null,
        authority: AUTH.REINVESTIGATION,
    },

    TL_XB_DOFD_INCONSISTENT: {
        bureauLocal: false,
        defect: (e) => `I dispute the accuracy of the date of first delinquency reported for this account.`,
        standard: "This date determines the permissible reporting period.",
        authority: AUTH.DOFD,
    },

    COL_XB_BALANCE_INCONSISTENT: {
        bureauLocal: false,
        defect: () => `I dispute the accuracy of the balance reported for this collection.`,
        standard: null,
        authority: AUTH.REINVESTIGATION,
    },

    // ---- BASELINE REINVESTIGATION (BT-DM-0054) ---------------------------
    //
    // ASSERTS NO DEFECT. This is the consumer exercising a §611 right, and the
    // wording must not drift one inch beyond it. It says what she disputes and
    // what she asks for. It does NOT say the account is inaccurate, false, or
    // unverifiable — the processor has established none of those things, and to
    // claim otherwise would be to invent a fact in her name.
    TL_BASELINE_REINVESTIGATION: {
        bureauLocal: true,
        defect: () =>
            `I dispute the completeness and accuracy of this account and request a reasonable ` +
            `reinvestigation.`,
        standard: null,
        authority: AUTH.REINVESTIGATION,
    },

    COL_BASELINE_REINVESTIGATION: {
        bureauLocal: true,
        defect: () =>
            `I dispute the completeness and accuracy of this collection account and request a ` +
            `reasonable reinvestigation.`,
        standard: null,
        authority: AUTH.REINVESTIGATION,
    },

    // ---- COMPLIANCE-GATED (BT-DM-0052) -----------------------------------
    // States the AGE, which is a fact. Asserts NO illegality and NO required
    // deletion — the gate forbids both until the legal basis is reviewed.
    INQ_BEYOND_REPORTING_PERIOD: {
        bureauLocal: true,
        complianceGated: true,
        defect: (e) => `This inquiry is dated ${e.inquiry_date} and is more than two years old.`,
        standard: "I request confirmation that this inquiry remains properly reportable.",
        authority: AUTH.REINVESTIGATION,
    },

    INQ_DUPLICATE: {
        bureauLocal: true,
        defect: (e) => `This furnisher is reported as having made ${e.occurrences} inquiries within a short period.`,
        standard: "A single authorization supports a single inquiry.",
        authority: AUTH.REINVESTIGATION,
    },
};

/**
 * @param {object} chain     buildDisputeChain() output
 * @param {object} analysis  analyzeCreditReport() output
 * @param {object} context
 * @param {object} context.clientIdentity  CRC PROFILE — the ONLY source of identity.
 */
export async function generateLetters(chain, analysis, context = {}) {

    const {
        clientIdentity,
        letterDate = new Date(),
        // FIRST PRODUCTION VALIDATION. Every letter is reviewed by a human,
        // regardless of what the automation policy would otherwise permit. The
        // first real package is not the place to discover we trusted a tier.
        firstProductionValidation = false,
    } = context;

    if (!chain?.chainOk) {
        return { schemaVersion: LETTER_SCHEMA_VERSION, lettersOk: false, errors: ["Chain incomplete."], letters: [], withheld: [] };
    }

    // ---- IDENTITY PROVENANCE — VERIFIED, NOT ASSERTED ---------------------
    //
    // This engine previously accepted any object with a name and an address, and
    // then PRINTED "IDENTITY SOURCE: CRC client profile (authoritative)" beneath
    // it. That line was a string literal. A fabricated demo address passed
    // straight through onto a dispute letter, and the package certified itself.
    //
    // A guarantee that is asserted rather than enforced is worse than none,
    // because it stops people looking. Identity now carries PROVENANCE and is
    // CHECKED. No fallback. If CRC cannot be read, no letter is written.
    const verified = verifyIdentity(clientIdentity);

    if (!verified.ok) {
        return {
            schemaVersion: LETTER_SCHEMA_VERSION,
            lettersOk: false,
            errors: verified.errors,
            letters: [],
            withheld: [],
        };
    }

    const identity = verified.identity;
    const mailingAddress = formatAddress(identity);

    const findingsByItem = new Map();

    for (const item of [
        ...(analysis.tradelines ?? []),
        ...(analysis.collections ?? []),
        ...(analysis.inquiries ?? []),
        ...(analysis.publicRecords ?? []),
    ]) {
        findingsByItem.set(item.stableItemKey, item);
    }

    // THE BUREAU FIDELITY LAYER. The single access point for reported values.
    //
    // The Letter Engine does not know where a reported value lives — it asks
    // Fidelity by stable_item_key and quotes what it gets. This is the Bureau
    // Fidelity Standard's one enforcement point: no template reaches into
    // observation.reported, and no normalized value can reach a letter.
    const report = context.report ?? null;
    const fidelity = createBureauFidelity(report);

    // ONE LETTER PER BUREAU. Business Trappers sends one letter per bureau,
    // containing every disputed tradeline for that bureau.
    //
    // Splitting on escalation posture was my earlier fix for a real bug: an
    // escalation opening ("I previously disputed the accounts below") is an
    // assertion about EVERY account in the letter, and a fresh round-1 account
    // swept into it would have the consumer claiming correspondence that never
    // happened.
    //
    // The correct fix is not two letters. It is an opening that ASSERTS NOTHING
    // ABOUT HISTORY. Round and escalation belong to the ACCOUNT SECTION, where
    // they are true of that account specifically — not to the letter, where they
    // would be claimed of all of them.
    const byBureau = new Map();
    const withheld = [];

    for (const item of chain.items) {
        if (!item.chainComplete || !item.bureau) continue;

        if (!byBureau.has(item.bureau)) byBureau.set(item.bureau, []);
        byBureau.get(item.bureau).push(item);
    }

    // ---- REPORT ORDER — Letter Intelligence Standard §4 ---------------------
    //
    // Tradelines must appear in the EXACT order shown on that bureau's report. The
    // dispute chain hands items in decision order, which is NOT report order. We
    // re-sort each bureau's items by the tradeline's position in the report, read
    // through the Fidelity Layer so the Letter Engine never inspects report
    // structure itself. Stable: equal positions keep chain order.
    for (const [bureau, items] of byBureau.entries()) {
        items.sort((a, b) => {
            const va = fidelity.forItem(a.stableItemKey);
            const vb = fidelity.forItem(b.stableItemKey);
            const oa = va ? va.reportOrder() : Infinity;
            const ob = vb ? vb.reportOrder() : Infinity;
            return oa - ob;
        });
    }

    const letters = [];

    for (const [bureau, items] of [...byBureau.entries()].sort()) {
        // ---- RECIPIENT ------------------------------------------------------
        //
        // Derived from the bureau, never selected. There is exactly ONE correct
        // legal entity and dispute address per bureau; "variation" here would
        // mean getting it wrong. Fails closed — an unknown bureau does NOT fall
        // back to "Dear Credit Reporting Agency", which is the single clearest
        // tell that a letter was mail-merged.
        const recipient = resolveRecipient(bureau);

        if (!recipient.ok) {
            withheld.push({
                bureau,
                stableItemKey: null,
                furnisher: null,
                reason: recipient.error,
            });
            continue;
        }

        const bureauName = recipient.shortName;
        const escalated = items.some((i) => i.escalated);
        const round = Math.max(...items.map((i) => i.round ?? 1));

        const sections = [];

        for (const item of items) {
            const source = findingsByItem.get(item.stableItemKey);

            // A BASELINE item legitimately has no analysis findings — that is its
            // entire premise. Only a NON-baseline item missing from analysis is a bug.
            if (!source && !item.baseline) {
                withheld.push({
                    stableItemKey: item.stableItemKey,
                    bureau: item.bureau,
                    furnisher: item.furnisher,
                    reason: "Item reached letter generation but has no analysis record. THIS IS A BUG.",
                });
                continue;
            }

            // ---- BT-DM-0001 v2.1 ADDENDUM: PERMISSIBLE-PURPOSE INQUIRY -----
            //
            // An inquiry is not a tradeline. It has no account number, and the
            // Bureau Fidelity Layer indexes tradelines only — so both guards below
            // (reported view, masked account) would withhold every inquiry dispute
            // for reasons that simply do not apply to an inquiry.
            //
            // Scoped to INQ_NO_ASSOCIATED_ACCOUNT alone. Every other inquiry
            // finding keeps its existing behavior exactly.
            //
            // The values quoted are the inquiry's OWN reported values, captured
            // verbatim in the finding evidence at analysis time — not derived,
            // not reformatted.
            const permissiblePurpose = source?.findings?.find(
                (f) => f.code === "INQ_NO_ASSOCIATED_ACCOUNT"
            );

            if (permissiblePurpose) {
                const ev = permissiblePurpose.evidence ?? {};
                const inquirySource = ev.furnisher ?? item.furnisher ?? null;

                // A dispute that cannot name the inquiry source cannot identify
                // what it is disputing.
                if (!inquirySource) {
                    withheld.push({
                        stableItemKey: item.stableItemKey,
                        bureau,
                        furnisher: null,
                        reason:
                            "No inquiry source is reported for this inquiry, so the dispute cannot " +
                            "identify it. Withheld rather than sent unidentifiable.",
                    });
                    continue;
                }

                const dateLine = ev.inquiry_date ? [`Inquiry Date: ${ev.inquiry_date}`] : [];
                const historyLine = item.escalated
                    ? [`Previously disputed. The inquiry remains on my file and was not removed.`, ``]
                    : [];

                sections.push({
                    stableItemKey: item.stableItemKey,
                    stableAccountKey: null, // an inquiry exists at ONE bureau
                    furnisher: inquirySource,
                    maskedAccount: null,    // an inquiry has no account number
                    round: item.round,
                    escalated: item.escalated,
                    requestedRemedy: item.requestedRemedy ?? INQUIRY_REMEDY,
                    strategy: item.strategy?.strategy ?? null,
                    decisionRecord: item.decisionRecord,
                    reason: item.reason?.reason ?? null,
                    instruction: item.instruction?.instruction ?? null,
                    blueprint: item.blueprint?.blueprint ?? null,
                    baseline: false,
                    complianceGated: false,
                    unspeccedFindings: [],
                    findingCodes: ["INQ_NO_ASSOCIATED_ACCOUNT"],
                    // AN INQUIRY IS NOT AN ACCOUNT. Reconciliation balances letter
                    // ACCOUNT sections against disputed TRADELINES; an inquiry is
                    // neither, so counting it there would break a true invariant
                    // with a false population.
                    isInquiry: true,
                    text: [
                        `${inquirySource}`,
                        ...dateLine,
                        ``,
                        ...historyLine,
                        INQUIRY_STATEMENT,
                        ``,
                        AUTH.PERMISSIBLE_PURPOSE,
                        ``,
                        `Requested action: ${item.requestedRemedy ?? INQUIRY_REMEDY}`,
                    ].join("\n"),
                });
                continue;
            }

            // Resolve THIS tradeline's reported view. A tradeline the Fidelity
            // Layer has never heard of cannot be quoted — that is a fail-closed
            // signal, not a value to invent.
            const reportedView = fidelity.forItem(item.stableItemKey);

            if (!reportedView) {
                withheld.push({
                    stableItemKey: item.stableItemKey,
                    bureau,
                    furnisher: item.furnisher,
                    reason:
                        "The Bureau Fidelity Layer has no reported record for this tradeline, so no " +
                        "value can be quoted faithfully. Withheld for human review rather than " +
                        "generated from an unknown source.",
                });
                continue;
            }

            const itemQuoter = makeQuoter(reportedView);

            const maskedValue = reportedView.maskedAccount();
            const masked = hasReported(maskedValue) ? maskedValue : null;

            // AN ACCOUNT WE CANNOT IDENTIFY TO THE BUREAU IS AN ACCOUNT WE DO NOT
            // DISPUTE. Sending a dispute with no account number invites "unable to
            // locate" — and burns a round.
            if (!masked) {
                withheld.push({
                    stableItemKey: item.stableItemKey,
                    bureau,
                    furnisher: item.furnisher,
                    reason:
                        "No masked account number is reported by this bureau for this tradeline. The " +
                        "dispute cannot identify the account, so it is withheld rather than sent " +
                        "unidentifiable.",
                });
                continue;
            }

            // ---- BASELINE REINVESTIGATION ----------------------------------
            //
            // No findings. Nothing has been proven about this account. The letter
            // says EXACTLY that and no more: it disputes, and it requests. It does
            // not allege.
            //
            // Note what is absent: no "this is inaccurate", no "this cannot be
            // verified", no invented defect. Every word below is true of an account
            // the processor has examined and found nothing wrong with.
            if (item.baseline) {
                sections.push({
                    stableItemKey: item.stableItemKey,
                    stableAccountKey: item.stableAccountKey,
                    furnisher: item.furnisher,
                    maskedAccount: masked,
                    round: item.round,
                    escalated: item.escalated,
                    requestedRemedy: item.requestedRemedy,
                    strategy: item.strategy?.strategy ?? null,
                    decisionRecord: item.decisionRecord,
                    baseline: true,
                    complianceGated: false,
                    unspeccedFindings: [],
                    text: [
                        `${item.furnisher ?? "Account"}`,
                        `Account Number: ${masked}`,
                        ``,
                        ...(item.escalated
                            ? [`Previously disputed. The information remains on my file and was not corrected.`, ``]
                            : []),
                        `I dispute the completeness and accuracy of this account and request a reasonable investigation.`,
                        ``,
                        AUTH.REINVESTIGATION,
                        ``,
                        `Requested action: Conduct a reasonable reinvestigation; correct or update the reporting as necessary, and delete the item if it cannot be verified or accurately corrected.`,
                    ].join("\n"),
                });
                continue;
            }

            const specced = source.findings
                .map((f) => ({ finding: f, spec: SPEC[f.code] }))
                .filter((x) => x.spec);

            const unspecced = source.findings.filter((f) => !SPEC[f.code]);

            if (specced.length === 0) {
                withheld.push({
                    stableItemKey: item.stableItemKey,
                    bureau,
                    furnisher: item.furnisher,
                    reason:
                        `No approved letter wording exists for the findings on this item ` +
                        `(${source.findings.map((f) => f.code).join(", ")}). Withheld for human review ` +
                        `rather than dropped.`,
                });
                continue;
            }

            // Deterministic, and self-evident assertions lead. Cross-bureau
            // disputes are weaker and follow.
            specced.sort((a, b) => {
                const rank = Number(b.spec.bureauLocal) - Number(a.spec.bureauLocal);
                return rank !== 0 ? rank : a.finding.code.localeCompare(b.finding.code);
            });

            // Bureau-local defects are ASSERTED, each on its own line.
            const local = specced.filter((x) => x.spec.bureauLocal);

            // Cross-bureau findings are DISPUTED, and collapse into ONE sentence.
            //
            // Three consecutive lines of "I dispute the accuracy of X." is exactly
            // the repeated sentence structure the Writing Style Guide forbids, and
            // it reads as padding. One sentence naming the disputed fields says the
            // same thing and sounds like a person wrote it.
            const crossBureau = specced.filter((x) => !x.spec.bureauLocal);

            const CROSS_FIELD = {
                TL_XB_STATUS_INCONSISTENT: "status",
                TL_XB_BALANCE_INCONSISTENT: "balance",
                TL_XB_PAST_DUE_INCONSISTENT: "past-due amount",
                TL_XB_DOFD_INCONSISTENT: "date of first delinquency",
                COL_XB_BALANCE_INCONSISTENT: "balance",
            };

            const disputedFields = [...new Set(crossBureau.map((x) => CROSS_FIELD[x.finding.code]).filter(Boolean))];

            const defects = [
                // The quoter reads ONLY this tradeline's reported view. Every
                // template quotes bureau values through it; the finding evidence is
                // passed second, for reasoning context and named derived values
                // only — never for quoting a reported value.
                ...local.map((x) => x.spec.defect(itemQuoter, x.finding.evidence ?? {})),
                ...(disputedFields.length
                    ? [
                          // Cross-bureau variance SUPPORTS OPENING A DISPUTE. It does
                          // not prove the RECIPIENT bureau is the wrong one. So we
                          // never say "cannot be verified as accurate" — that is a
                          // conclusion we have not earned. We say the consumer
                          // disputes it, which is true by construction.
                          `I dispute the completeness and accuracy of the ${
                              disputedFields.length === 1
                                  ? disputedFields[0]
                                  : `${disputedFields.slice(0, -1).join(", ")}, and ${disputedFields.slice(-1)}`
                          } reported for this account and request a reasonable reinvestigation.`,
                      ]
                    : []),
            ];

            const standards = [...new Set(local.map((x) => x.spec.standard).filter(Boolean))];

            // ONE authority. The strongest that applies.
            const authority =
                AUTHORITY_PRIORITY.find((a) => specced.some((x) => x.spec.authority === a)) ??
                AUTH.REINVESTIGATION;

            // THE REMEDY COMES FROM THE STRATEGY. The letter does not choose it.
            //
            // A Failure to Investigate escalation asks for the METHOD OF
            // VERIFICATION — not another round of the same investigation, because
            // the point at issue is HOW the bureau reached its conclusion. Only
            // the Strategy Engine knows that; the letter must not second-guess it.
            const remedy = item.requestedRemedy;

            if (!remedy) {
                withheld.push({
                    stableItemKey: item.stableItemKey,
                    bureau,
                    furnisher: item.furnisher,
                    reason:
                        "The Strategy Engine supplied no requested remedy for this item. A dispute " +
                        "that asks for nothing is not sent.",
                });
                continue;
            }

            // Creditor / Account number / Defect / Authority / Remedy. Nothing more.
            // History belongs to the ACCOUNT, never to the letter.
            const historyLine = item.escalated
                ? [`Previously disputed. The information remains on my file and was not corrected.`]
                : [];

            const lines = [
                `${item.furnisher ?? "Account"}`,
                `Account Number: ${masked}`,
                ``,
                ...historyLine,
                ...(historyLine.length ? [``] : []),
                ...defects,
                ...(standards.length ? [``, ...standards] : []),
                ``,
                authority,
                ``,
                `Requested action: ${remedy}`,
            ];

            sections.push({
                stableItemKey: item.stableItemKey,
                stableAccountKey: item.stableAccountKey,
                furnisher: item.furnisher,
                maskedAccount: masked,
                round: item.round,          // belongs to the ACCOUNT, not the letter
                escalated: item.escalated,  // ditto
                requestedRemedy: remedy,
                strategy: item.strategy?.strategy ?? null,
                decisionRecord: item.decisionRecord,
                reason: item.reason.reason,
                instruction: item.instruction.instruction,
                blueprint: item.blueprint.blueprint,
                // Marks a section as the BASELINE path: a §611 request with no proven
                // defect. Downstream (reconciliation, review UI) must be able to tell
                // "we found a contradiction" from "we found nothing and said so".
                baseline: specced.some((x) => /_BASELINE_REINVESTIGATION$/.test(x.finding.code)),
                complianceGated: specced.some((x) => x.spec.complianceGated),
                unspeccedFindings: unspecced.map((f) => f.code),
                // Finding codes on this section, for the fact-specific opening gate.
                findingCodes: specced.map((x) => x.finding.code),
                text: lines.join("\n"),
            });
        }

        if (sections.length === 0) continue;

        // ---- LETTER VOICE ---------------------------------------------------
        //
        // Three approved libraries, seeded on the client, bureau, round and report
        // date. Deterministic: this letter regenerates word-for-word in two years.
        //
        // Every sentence in these libraries is HISTORY-NEUTRAL and makes no
        // account-specific claim, because the opening speaks for the WHOLE letter
        // — and a bureau letter carries first-round and escalated accounts side by
        // side. "As I told you previously" would be false for the new ones.
        // Per-account history lives in the account section, where it is true.
        // ---- FACT-SPECIFIC OPENING GATE -------------------------------------
        //
        // The Kris-approved Metro 2 missing-DOFD opening makes a shared-defect
        // statement about EVERY tradeline in the letter. It may be used ONLY when
        // that statement is true of every disputed section — i.e. BOTH:
        //   (a) every disputed (non-baseline) section is BT-DM-0033, AND
        //   (b) every one of those sections carries TL_DEROGATORY_WITHOUT_DOFD
        //       ("CollectionOrChargeOff" status with no Date of First Delinquency).
        // If a letter mixes reasons, sharedDefect is null and the engine falls
        // back to the general firm opening. This is the ONLY place the fact-specific
        // opening can be enabled; the voice library never self-selects it.
        const disputedSections = sections.filter((sec) => !sec.baseline);
        const everyMetro2Dofd =
            disputedSections.length > 0 &&
            disputedSections.every(
                (sec) =>
                    sec.decisionRecord === "BT-DM-0033" &&
                    (sec.findingCodes ?? []).includes("TL_DEROGATORY_WITHOUT_DOFD")
            );
        const sharedDefect = everyMetro2Dofd ? "metro2_missing_dofd" : null;

        const voice = selectVoice({
            crcClientId: identity.crcClientId,
            bureau,
            round,
            reportDate: context.reportDate ?? null,
            sharedDefect,
        });

        const body = [
            identity.name,
            mailingAddress,
            "",
            letterDate.toISOString().slice(0, 10),
            "",
            recipient.addressBlock,
            "",
            `Re: Dispute — ${identity.name}`,
            "",
            recipient.greeting,
            "",
            voice.opening.text,
            "",
            voice.transition.text,
            "",
            "---",
            "",
            sections.map((s) => s.text).join("\n\n---\n\n"),
            "",
            "---",
            "",
            voice.closing.text,
            "",
            "Sincerely,",
            "",
            identity.name,
        ].join("\n");

        letters.push({
            bureau,
            bureauName,
            round,
            escalated,
            itemCount: sections.length,
            stableItemKeys: sections.map((s) => s.stableItemKey),
            // Account sections only — the population reconciliation balances against
            // disputed tradelines. Inquiry sections are reported separately.
            accountSections: sections.filter((sec) => !sec.isInquiry),
            inquirySections: sections.filter((sec) => sec.isInquiry),
            body,

            // Audit: Kris can reproduce this letter's voice from the combination alone.
            voice: voice.provenance,
            recipient: { legalName: recipient.legalName, greeting: recipient.greeting },

            requiresHumanReview: firstProductionValidation || items.some((i) => i.humanReview),
            reviewReason: firstProductionValidation
                ? "FIRST_PRODUCTION_VALIDATION"
                : (items.some((i) => i.humanReview) ? "POLICY" : null),
            complianceGated: sections.some((s) => s.complianceGated),

            // NOT part of the letter. Kris reads this beside it.
            reasoningTrace: items.map((i) => ({
                stableItemKey: i.stableItemKey,
                furnisher: i.furnisher,
                chain: i.reasoningChain,
            })),
        });
    }

    // A letter must never name a bureau other than its recipient. This is checked
    // against the OUTPUT, not merely intended in the input — an assertion about
    // what we built, not about what we meant to build.
    const leaks = [];

    for (const letter of letters) {
        for (const [bureauKey, name] of Object.entries(BUREAU_NAMES)) {
            if (bureauKey === letter.bureau) continue;
            if (letter.body.includes(name)) {
                leaks.push({ letter: letter.bureauName, leaked: name });
            }
        }
    }

    // ---- FINAL FAIL-CLOSED CONTENT GATE ------------------------------------
    //
    // A letter body must never reach a consumer or a bureau carrying an unresolved
    // placeholder or a stringified absent value. If the Bureau Fidelity layer could
    // not supply a reported value, the section text contains the DO-NOT-SEND marker
    // (or, from a defect elsewhere, a literal "undefined"/"null"). Such a letter is
    // WITHHELD and routed to human review — it is never certified sendable. This
    // gate is checked against the OUTPUT, not the intent.
    const contentFailures = [];
    const sendableLetters = [];
    for (const screened of screenLetterContent(letters)) {
        const letter = letters.find((l) => l.bureau === screened.bureau);
        if (screened.hits.length > 0) {
            contentFailures.push({ letter: screened.bureauName, tokens: screened.hits });
            // Withhold the whole letter for this bureau and flag for human review.
            withheld.push({
                bureau: screened.bureau,
                bureauName: screened.bureauName,
                reason:
                    "Letter body contained an unresolved placeholder or absent value " +
                    `(${screened.hits.join(", ")}). Withheld and routed to human review; not sendable.`,
                requiresHumanReview: true,
                stableItemKeys: screened.stableItemKeys,
            });
        } else {
            sendableLetters.push(letter);
        }
    }

    const ok = leaks.length === 0 && contentFailures.length === 0;

    return {
        schemaVersion: LETTER_SCHEMA_VERSION,
        lettersOk: ok,
        errors: [
            ...(leaks.length
                ? [`CROSS-BUREAU LEAK: a letter referenced another bureau. ${JSON.stringify(leaks)}`]
                : []),
            ...(contentFailures.length
                ? [`UNSENDABLE CONTENT: placeholder/absent value in letter body. ${JSON.stringify(contentFailures)}`]
                : []),
        ],
        // Only letters that passed the content gate are returned as letters; the rest
        // are in withheld. requiresHumanReview is raised whenever anything was withheld
        // for content reasons.
        requiresHumanReview: contentFailures.length > 0,

        letters: sendableLetters,
        withheld,

        summary: {
            lettersGenerated: letters.length,
            bureaus: letters.map((l) => l.bureauName),
            itemsWithheld: withheld.length,
            identitySource: identity.source,
            identityCrcClientId: identity.crcClientId,
            identityRetrievedAt: identity.retrievedAt,
            crossBureauLeakCheck: leaks.length === 0 ? "PASS" : "FAIL",

            // If FALSE, the voice libraries are engineer-authored placeholders.
            // NOT SENDABLE. Business Trappers authors the approved text.
            voiceLibrariesApproved: letters[0]?.voice?.librariesApproved ?? null,
        },
    };
}
