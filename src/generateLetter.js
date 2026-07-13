/**
 * generateLetter.js
 *
 * LETTER GENERATION ENGINE.
 *
 * Assembles one dispute letter PER BUREAU from the completed reasoning chain.
 *
 * ---------------------------------------------------------------------------
 * NO GPT. DETERMINISTIC. AND THAT IS A FEATURE.
 *
 * Every sentence in the output traces to a specific finding produced by the
 * Analysis Engine. There is no step at which a model could introduce a fact
 * nobody verified. The Letter Generation Engine's first Never Rule is NEVER
 * INVENT FACTS — the cheapest way to guarantee that is to make invention
 * structurally impossible.
 *
 * Wording is VARIED, not random: phrasing is selected by a deterministic hash of
 * stable_item_key + round, so two letters differ but the SAME letter regenerates
 * identically. That satisfies the Anti-Boilerplate standard without making the
 * output irreproducible — a letter we cannot regenerate is a letter we cannot
 * defend later.
 *
 * ---------------------------------------------------------------------------
 * TWO HARD RULES THIS MODULE ENFORCES
 *
 * 1. IDENTITY COMES FROM CRC. NEVER FROM THE REPORT.
 *    Extraction Decision 3: reported_personal_information is EVIDENCE, never
 *    identity. Populating a letter header from the report would restate the
 *    bureau's own (possibly wrong) data back at it — and on a mixed file, would
 *    address the letter as though the wrong person's data were the client's.
 *
 * 2. COMPLIANCE GATES ARE OBEYED.
 *    A gated Decision Record may be described FACTUALLY but its legal conclusion
 *    may NOT be asserted. This engine refuses to write the forbidden sentence.
 *    A human reviewer approving the letter does not clear the gate.
 * ---------------------------------------------------------------------------
 */

export const LETTER_SCHEMA_VERSION = "BT-LETTER-1.0";

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

/** Deterministic selector. Same item + round -> same phrasing, always. */
function pick(options, seed) {
    let hash = 0;

    for (let i = 0; i < seed.length; i++) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }

    return options[hash % options.length];
}

const OPENINGS = [
    "I am writing to request an investigation into information appearing on my credit file.",
    "I have reviewed my credit report and am requesting an investigation into the entries described below.",
    "I am contacting you regarding information on my credit file that I believe is inaccurate or cannot be verified.",
];

const ESCALATION_OPENINGS = [
    "I previously disputed information on my credit file. The response I received does not resolve the matter, and I am writing again.",
    "I am following up on a previous dispute. The information at issue remains on my file, and the response I received does not address the problem I identified.",
];

const REQUESTS = [
    "Please conduct a reasonable investigation and delete or correct the reporting as required by applicable law.",
    "Please investigate this entry and, if it cannot be verified as accurate and complete, delete or correct it.",
    "I ask that you reinvestigate this entry and remove or correct it if it cannot be verified.",
];

/**
 * Turn ONE finding into ONE factual sentence in the consumer's voice.
 *
 * Every sentence here is a restatement of something the Analysis Engine
 * OBSERVED. Nothing is characterised, inferred, or embellished.
 */
function sentenceFor(finding, furnisher) {
    const e = finding.evidence ?? {};

    switch (finding.code) {
        case "TL_PAST_DUE_ON_ZERO_BALANCE":
            return `This account is reported with a past-due amount of $${e.past_due} while the balance is reported as $0. An account with no balance cannot have an amount past due.`;

        case "TL_PAST_DUE_EXCEEDS_BALANCE":
            return `This account is reported with a past-due amount of $${e.past_due}, which exceeds the reported balance of $${e.balance}.`;

        case "TL_DEROGATORY_WITHOUT_DOFD":
            return `This account is reported with a status of "${e.status}" but with no Date of First Delinquency. Without that date, the period for which this account may be reported cannot be determined.`;

        case "TL_DOFD_BEFORE_OPENED":
            return `This account is reported as first delinquent on ${e.date_of_first_delinquency}, which is before the account opened date of ${e.date_opened}.`;

        case "TL_BEYOND_REPORTING_PERIOD":
            return `This account is reported with a Date of First Delinquency of ${e.date_of_first_delinquency}. The period during which this information may be reported has elapsed.`;

        case "TL_XB_STATUS_INCONSISTENT":
            return `${BUREAU_NAMES[e.this_bureau?.bureau] ?? "This bureau"} reports the status of this account as ${e.this_bureau?.value}, while ${e.other_bureaus?.map((b) => `${BUREAU_NAMES[b.bureau]} reports ${b.value}`).join(" and ")}. These cannot all be accurate.`;

        case "TL_XB_BALANCE_INCONSISTENT":
            return `The balance reported for this account differs from the balance reported by other credit reporting agencies for the same account.`;

        case "TL_XB_DOFD_INCONSISTENT":
            return `The Date of First Delinquency reported for this account differs from the date reported by other credit reporting agencies. This date determines how long the account may be reported.`;

        case "TL_DUPLICATE_WITHIN_BUREAU":
            return `This account appears ${e.occurrences} times on my file. It is a single account and should appear once.`;

        case "COL_MISSING_ORIGINAL_CREDITOR":
            return `This collection is reported without identifying the original creditor. I cannot verify a debt when the original creditor is not stated.`;

        case "COL_DUPLICATE_COLLECTION":
            return `More than one collection agency is reporting the same debt on my file.`;

        case "HIST_RE_AGING_INDICATOR":
            return `The Date of First Delinquency for this account was previously reported as ${e.previous_dofd} and is now reported as ${e.current_dofd}. A date of first delinquency is a historical fact and does not change.`;

        case "HIST_BALANCE_INCREASED_ON_CHARGED_OFF":
            return `The balance on this charged-off account has increased from $${e.previous} to $${e.current}.`;

        case "TL_STATUS_CONFLICTS_WITH_PAYMENT_HISTORY":
            return `This account is reported as "${e.status}", but the payment history shown for the same account reflects a recent late payment.`;

        case "TL_CLOSED_WITH_ACTIVE_STATUS":
            return `This account is reported as both closed and active.`;

        // COMPLIANCE-GATED. State the FACT (the age). Assert no legal conclusion.
        case "INQ_BEYOND_REPORTING_PERIOD":
            return `This inquiry is dated ${e.inquiry_date} and is more than two years old. I ask that you confirm it remains properly reportable.`;

        default:
            return null; // We do not write a sentence we have not carefully authored.
    }
}

/**
 * @param {object} chain     output of buildDisputeChain()
 * @param {object} analysis  output of analyzeCreditReport()
 * @param {object} context
 * @param {object} context.clientIdentity  CRC PROFILE — the ONLY source of identity.
 */
export async function generateLetters(chain, analysis, context = {}) {

    const { clientIdentity, letterDate = new Date() } = context;

    if (!chain?.chainOk) {
        return { schemaVersion: LETTER_SCHEMA_VERSION, lettersOk: false, errors: ["Chain incomplete."], letters: [] };
    }

    // Identity is NOT optional and has NO fallback.
    //
    // The report contains names. It would be trivially easy to use one. That is
    // exactly the failure Extraction Decision 3 exists to prevent: on a mixed
    // file, the report's name may belong to somebody else, and we would be
    // signing the client's dispute with a stranger's identity.
    if (!clientIdentity?.name || !clientIdentity?.address) {
        return {
            schemaVersion: LETTER_SCHEMA_VERSION,
            lettersOk: false,
            errors: [
                "No CRC client identity supplied. Identity comes from the CRC client profile and " +
                "from nowhere else — the credit report is evidence, never identity. No letter is " +
                "generated without it.",
            ],
            letters: [],
        };
    }

    // Find the analysis findings for an item, so the letter states FACTS, not
    // codes. The letter is built from what we observed — never re-derived here.
    const findingsByItem = new Map();

    for (const item of [...(analysis.tradelines ?? []), ...(analysis.collections ?? []), ...(analysis.inquiries ?? []), ...(analysis.publicRecords ?? [])]) {
        findingsByItem.set(item.stableItemKey, item);
    }

    // ONE LETTER PER BUREAU **PER ESCALATION POSTURE**.
    //
    // Each bureau is a separate legal proceeding, so a letter to TransUnion
    // speaks only to TransUnion's reporting. But bureau alone is NOT a fine
    // enough grouping, and getting this wrong produces a FALSE STATEMENT:
    //
    //   An escalation letter opens "I am following up on a previous dispute."
    //   That sentence is an assertion about EVERY ACCOUNT IN THE LETTER. Batch a
    //   brand-new round-1 account into an escalation letter and the consumer has
    //   just signed a claim about correspondence that never happened for that
    //   account.
    //
    // The opening characterises the whole letter, so the whole letter must share
    // one posture. A bureau with both new and escalated items gets TWO letters.
    const byGroup = new Map();

    for (const item of chain.items) {
        if (!item.chainComplete) continue;
        if (!item.bureau) continue;

        const key = `${item.bureau}|${item.escalated ? "escalation" : "initial"}`;

        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key).push(item);
    }

    const letters = [];

    for (const [key, items] of [...byGroup.entries()].sort()) {
        const bureau = key.split("|")[0];

        // Every item in the group shares a posture — that is what the group IS.
        const escalated = items[0].escalated;
        const round = Math.max(...items.map((i) => i.round ?? 1));
        const seed = `${bureau}|${round}|${items[0].stableItemKey}`;

        const gates = items.flatMap((i) =>
            (i.humanReviewReasons ?? []).filter((r) => r.startsWith("COMPLIANCE GATE"))
        );

        const accountSections = [];

        for (const item of items) {
            const source = findingsByItem.get(item.stableItemKey);
            if (!source) continue;

            const sentences = source.findings
                .map((f) => sentenceFor(f, item.furnisher))
                .filter(Boolean);

            if (sentences.length === 0) continue;

            accountSections.push({
                stableItemKey: item.stableItemKey,
                stableAccountKey: item.stableAccountKey,
                furnisher: item.furnisher,
                decisionRecord: item.decisionRecord,
                reason: item.reason.reason,
                instruction: item.instruction.instruction,
                blueprint: item.blueprint.blueprint,
                text: [
                    `**${item.furnisher ?? "Account"}**`,
                    ...sentences,
                    pick(REQUESTS, `${seed}|${item.stableItemKey}`),
                ].join("\n\n"),
            });
        }

        if (accountSections.length === 0) continue;

        const opening = escalated
            ? pick(ESCALATION_OPENINGS, seed)
            : pick(OPENINGS, seed);

        const body = [
            clientIdentity.name,
            clientIdentity.address,
            "",
            letterDate.toISOString().slice(0, 10),
            "",
            BUREAU_ADDRESSES[bureau] ?? BUREAU_NAMES[bureau],
            "",
            `Re: Request for investigation — ${clientIdentity.name}`,
            "",
            opening,
            "",
            accountSections.map((s) => s.text).join("\n\n"),
            "",
            "Please provide the results of your investigation in writing.",
            "",
            "Thank you for your prompt attention to this matter.",
            "",
            "Sincerely,",
            "",
            clientIdentity.name,
        ].join("\n");

        letters.push({
            bureau,
            bureauName: BUREAU_NAMES[bureau] ?? bureau,
            round,
            escalated,
            itemCount: accountSections.length,
            stableItemKeys: accountSections.map((s) => s.stableItemKey),
            accountSections,
            body,

            requiresHumanReview: items.some((i) => i.humanReview),
            complianceGates: gates,

            // Kris reads this next to the letter.
            reasoningTrace: items.map((i) => ({
                stableItemKey: i.stableItemKey,
                furnisher: i.furnisher,
                chain: i.reasoningChain,
            })),
        });
    }

    return {
        schemaVersion: LETTER_SCHEMA_VERSION,
        lettersOk: true,
        errors: [],
        letters,
        summary: {
            lettersGenerated: letters.length,
            bureaus: letters.map((l) => l.bureauName),
            identitySource: "CRC client profile (authoritative). NOT the credit report.",
            allRequireReview: letters.every((l) => l.requiresHumanReview),
        },
    };
}
