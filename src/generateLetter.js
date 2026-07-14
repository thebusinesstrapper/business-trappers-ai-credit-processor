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
import { selectOpening, selectClosing } from "./openings.js";

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

const AUTH = {
    ACCURACY: "FCRA § 607(b) (15 U.S.C. § 1681e(b)) — reasonable procedures to assure maximum possible accuracy.",
    REINVESTIGATION: "FCRA § 611 (15 U.S.C. § 1681i) — reinvestigation of disputed information.",
    OBSOLETE: "FCRA § 605 (15 U.S.C. § 1681c) — obsolete information may not be reported.",
    DOFD: "FCRA § 605(c) (15 U.S.C. § 1681c(c)) — the reporting period runs from the date of first delinquency.",
};

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
        defect: (e) => `Reported with a past-due amount of ${money(e.past_due)} and a balance of $0.`,
        standard: "An account with no balance cannot carry an amount past due. The reporting is internally inconsistent.",
        authority: AUTH.ACCURACY,
    },

    TL_PAST_DUE_EXCEEDS_BALANCE: {
        bureauLocal: true,
        defect: (e) => `Reported with a past-due amount of ${money(e.past_due)}, exceeding the reported balance of ${money(e.balance)}.`,
        standard: "A past-due amount cannot exceed the balance owed. The reporting is internally inconsistent.",
        authority: AUTH.ACCURACY,
    },

    TL_DEROGATORY_WITHOUT_DOFD: {
        bureauLocal: true,
        defect: (e) => `Reported with a status of "${e.status}" and no date of first delinquency.`,
        standard: "A derogatory account must carry a date of first delinquency. Without it, the permissible reporting period cannot be determined.",
        authority: AUTH.DOFD,
    },

    TL_DOFD_BEFORE_OPENED: {
        bureauLocal: true,
        defect: (e) => `Reported as first delinquent on ${e.date_of_first_delinquency}, before the account opened date of ${e.date_opened}.`,
        standard: "An account cannot become delinquent before it exists. The reporting is internally inconsistent.",
        authority: AUTH.ACCURACY,
    },

    TL_BEYOND_REPORTING_PERIOD: {
        bureauLocal: true,
        defect: (e) => `Reported with a date of first delinquency of ${e.date_of_first_delinquency}. The permissible reporting period has elapsed.`,
        standard: "Obsolete information may not be reported.",
        authority: AUTH.OBSOLETE,
    },

    TL_CLOSED_WITH_ACTIVE_STATUS: {
        bureauLocal: true,
        defect: () => `Reported as both closed and active.`,
        standard: "An account cannot be simultaneously closed and active. The reporting is internally inconsistent.",
        authority: AUTH.ACCURACY,
    },

    TL_STATUS_CONFLICTS_WITH_PAYMENT_HISTORY: {
        bureauLocal: true,
        defect: (e) => `Reported with a status of "${e.status}", while the payment history for the same account shows a recent late payment.`,
        standard: "The status and the payment history for one account must agree.",
        authority: AUTH.ACCURACY,
    },

    TL_DUPLICATE_WITHIN_BUREAU: {
        bureauLocal: true,
        defect: (e) => `Reported ${e.occurrences} times on my file.`,
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
        defect: () => `The same debt is reported by more than one collection agency.`,
        standard: "One debt may be reported as owed to one collector.",
        authority: AUTH.ACCURACY,
    },

    HIST_RE_AGING_INDICATOR: {
        bureauLocal: true,
        defect: (e) => `The date of first delinquency was previously reported as ${e.previous_dofd} and is now reported as ${e.current_dofd}.`,
        standard: "A date of first delinquency is a historical fact and does not change. Moving it forward extends the reporting period.",
        authority: AUTH.DOFD,
    },

    HIST_BALANCE_INCREASED_ON_CHARGED_OFF: {
        bureauLocal: true,
        defect: (e) => `The balance on this charged-off account increased from ${money(e.previous)} to ${money(e.current)}.`,
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

    // The bureau's OWN masked account number, per tradeline. Never another
    // bureau's, never a normalised one.
    const maskedByItem = new Map();
    const report = context.report ?? null;

    if (report) {
        for (const account of [...(report.accounts ?? []), ...(report.collections ?? []), ...(report.public_records ?? [])]) {
            for (const tradeline of account.bureau_tradelines ?? []) {
                maskedByItem.set(tradeline.stable_item_key, tradeline.masked_account ?? null);
            }
        }
    }

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

    const letters = [];

    for (const [bureau, items] of [...byBureau.entries()].sort()) {
        const bureauName = BUREAU_NAMES[bureau] ?? bureau;
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

            const masked = maskedByItem.get(item.stableItemKey);

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
                        `Requested action: If the information cannot be verified as complete and accurate, please delete or correct the reporting.`,
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
                ...local.map((x) => x.spec.defect(x.finding.evidence ?? {})),
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
                text: lines.join("\n"),
            });
        }

        if (sections.length === 0) continue;

        // A HISTORY-NEUTRAL OPENING, SELECTED — NOT GENERATED.
        //
        // The opening asserts something about EVERY account in the letter, and a
        // bureau letter carries first-round and escalated accounts side by side.
        // So it says nothing about dispute history: "I previously disputed these"
        // would be FALSE for any account being disputed for the first time.
        // Per-account history lives in the account section, where it is true.
        //
        // Variation comes from SELECTION over an approved library, seeded on the
        // client, bureau, round and report date. Deterministic: the same letter
        // regenerates word-for-word, and no sentence can appear that a human did
        // not approve.
        const openingChoice = selectOpening({
            crcClientId: identity.crcClientId,
            bureau,
            round,
            reportDate: context.reportDate ?? null,
        });

        const closingChoice = selectClosing({
            crcClientId: identity.crcClientId,
            bureau,
            round,
            reportDate: context.reportDate ?? null,
        });

        const opening = openingChoice.text;

        const body = [
            identity.name,
            mailingAddress,
            "",
            letterDate.toISOString().slice(0, 10),
            "",
            BUREAU_ADDRESSES[bureau] ?? bureauName,
            "",
            `Re: Dispute — ${identity.name}`,
            "",
            opening,
            "",
            "---",
            "",
            sections.map((s) => s.text).join("\n\n---\n\n"),
            "",
            "---",
            "",
            closingChoice.text,
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
            accountSections: sections,
            body,

            openingIndex: openingChoice.index,   // audit: which approved opening was used
            closingIndex: closingChoice.index,

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

    return {
        schemaVersion: LETTER_SCHEMA_VERSION,
        lettersOk: leaks.length === 0,
        errors: leaks.length
            ? [`CROSS-BUREAU LEAK: a letter referenced another bureau. ${JSON.stringify(leaks)}`]
            : [],

        letters,
        withheld,

        summary: {
            lettersGenerated: letters.length,
            bureaus: letters.map((l) => l.bureauName),
            itemsWithheld: withheld.length,
            identitySource: identity.source,
            identityCrcClientId: identity.crcClientId,
            identityRetrievedAt: identity.retrievedAt,
            crossBureauLeakCheck: leaks.length === 0 ? "PASS" : "FAIL",
        },
    };
}
