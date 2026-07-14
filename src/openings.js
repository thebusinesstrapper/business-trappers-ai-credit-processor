/**
 * openings.js
 *
 * THE APPROVED OPENING LIBRARY.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISTIC VARIATION. NOT GENERATION.
 *
 * The quality test in the Writing Style Guide: if a bureau compared 100 Business
 * Trappers letters, they must not appear mass-produced. A single fixed opening
 * fails that instantly — the letters are provably a template.
 *
 * The tempting fix is a language model. We do not do that, and the reason is not
 * squeamishness:
 *
 *   1. A generated opening cannot be REPRODUCED. A letter we cannot regenerate
 *      byte-for-byte is a letter we cannot defend in eighteen months when a
 *      bureau asks what we sent and why.
 *
 *   2. A generated opening cannot be REVIEWED. Every sentence here has been
 *      read and approved. A model can produce a sentence nobody approved, in the
 *      consumer's voice, over her signature — and the first anyone would know is
 *      when it arrives at a credit bureau.
 *
 * So variation comes from SELECTION, not from generation. Every opening below is
 * pre-approved, carries identical legal meaning, and is chosen by a deterministic
 * hash. The same letter regenerates identically, forever, and no sentence can
 * ever appear that a human did not sign off.
 *
 * ---------------------------------------------------------------------------
 * EVERY OPENING MUST BE TRUE OF EVERY ACCOUNT IN THE LETTER.
 *
 * The opening is an assertion about the WHOLE letter. A bureau letter carries
 * first-round and escalated accounts side by side, so an opening that says
 * "I previously disputed these accounts" would be FALSE for any account being
 * disputed for the first time — a false statement, made by the consumer.
 *
 * Every opening in this library is therefore HISTORY-NEUTRAL. Round and
 * escalation language lives in the ACCOUNT SECTION, where it is true of that
 * account and only that account.
 * ---------------------------------------------------------------------------
 */

export const OPENINGS_SCHEMA_VERSION = "BT-OPENINGS-1.0";

/**
 * APPROVED OPENINGS.
 *
 * Each must:
 *   - request an investigation of the items below,
 *   - assert NOTHING about dispute history,
 *   - assert NOTHING about any specific account,
 *   - carry the same legal meaning as every other entry,
 *   - sound like a person wrote it.
 *
 * Adding an entry is a governance change, not a code change. Nothing may be
 * added that alters the legal meaning.
 */
export const APPROVED_OPENINGS = Object.freeze([
    "I am writing to dispute information on my credit file. The accounts identified below are inaccurate or incomplete, and I am requesting a reasonable investigation of each one.",

    "After reviewing my credit report, I found information I believe is inaccurate or incomplete. I have listed each account below and am asking that you investigate them.",

    "I recently obtained a copy of my credit report and identified several entries I need to dispute. Each is described below, and I am requesting a reasonable investigation of each account.",

    "I am disputing the accuracy and completeness of the information listed below. Please conduct a reasonable investigation of each account and provide me with the results.",

    "This letter concerns information on my credit file that I believe is being reported inaccurately or incompletely. The specific accounts are identified below. I am requesting an investigation of each.",

    "I have reviewed my credit report and need to dispute the entries described below. I am asking that each account be investigated and that the results be provided to me in writing.",

    "I am contacting you about several accounts on my credit file that appear to be reported inaccurately or incompletely. Each one is set out below, and I am requesting a reasonable investigation.",

    "The information listed below appears on my credit report, and I dispute its accuracy and completeness. Please investigate each account and correct or remove anything that cannot be verified.",
]);

/**
 * APPROVED CLOSINGS. Same rules, same reasoning.
 */
export const APPROVED_CLOSINGS = Object.freeze([
    "Please provide the results of your investigation in writing.",

    "I would appreciate receiving the results of your investigation in writing once it is complete.",

    "Please send me the results of your investigation in writing when it has been completed.",

    "I ask that the results of your investigation be provided to me in writing.",

    "Please confirm the outcome of your investigation to me in writing.",
]);

/**
 * A stable, well-distributed hash. FNV-1a.
 *
 * Deliberately NOT Math.random(), NOT Date.now(), NOT an incrementing counter.
 * The selection must depend ONLY on facts about the letter, so that regenerating
 * the same letter tomorrow, or in two years, produces the same words.
 */
function fnv1a(input) {
    let hash = 0x811c9dc5;

    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash >>> 0;
}

/**
 * Build the selection seed.
 *
 * Includes the CLIENT so two clients' letters to the same bureau in the same
 * round differ — which is exactly the "mass-produced" pattern a bureau would
 * notice first.
 *
 * Includes the ROUND so a consumer's second letter to a bureau does not open
 * with the identical sentence as their first — which would look copy-pasted to
 * the one reader most likely to have both on file.
 */
export function openingSeed({ crcClientId, bureau, round, reportDate }) {
    return [
        crcClientId ?? "no-client",
        bureau ?? "no-bureau",
        round ?? 1,
        reportDate ?? "no-report",
    ].join("|");
}

/**
 * Select an approved opening. Deterministic.
 *
 * @returns {{ text: string, index: number, seed: string }}
 */
export function selectOpening(context) {
    const seed = openingSeed(context);
    const index = fnv1a(seed) % APPROVED_OPENINGS.length;

    return { text: APPROVED_OPENINGS[index], index, seed };
}

/**
 * Select an approved closing.
 *
 * Seeded DIFFERENTLY from the opening. If both used the same seed, opening #3
 * would always travel with closing #3, and the pairing itself would become a
 * fingerprint — the very repetition we are trying to avoid, one level up.
 */
export function selectClosing(context) {
    const seed = `closing|${openingSeed(context)}`;
    const index = fnv1a(seed) % APPROVED_CLOSINGS.length;

    return { text: APPROVED_CLOSINGS[index], index, seed };
}
