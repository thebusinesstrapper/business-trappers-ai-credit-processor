/**
 * index.js — BUSINESS TRAPPERS LETTER VOICE™
 *
 * Deterministic selection across three independently-maintained libraries:
 *
 *   Opening Library™     2–3 paragraph introductions
 *   Transition Library™  introduction -> account sections
 *   Closing Library™     professional conclusions
 *
 * ===========================================================================
 * SELECTION, NOT GENERATION. AND THE DIFFERENCE IS NOT COSMETIC.
 *
 * A language model could write a warmer opening than anything below. We do not
 * use one, for two reasons that do not go away as models improve:
 *
 *   1. A GENERATED LETTER CANNOT BE REGENERATED. If a bureau asks in eighteen
 *      months what we sent and why, "the model wrote it" is not an answer. Every
 *      letter this engine produces reconstructs byte-for-byte from the client,
 *      the bureau, the round and the report date. Forever.
 *
 *   2. A GENERATED SENTENCE HAS NEVER BEEN READ BY ANYONE. Every sentence in
 *      these libraries has been approved by Kris. A model can produce a fluent,
 *      plausible, entirely unapproved sentence in the consumer's voice, over her
 *      signature — and the first human to read it would be at a credit bureau.
 *
 * Variation therefore comes from COMBINATION. 10 openings x 8 transitions x
 * 7 closings = 560 distinct letter voices, every one of them pre-approved.
 * ===========================================================================
 */

import { OPENINGS, renderOpening, OPENING_LIBRARY_VERSION } from "./openingLibrary.js";
import { TRANSITIONS, TRANSITION_LIBRARY_VERSION } from "./transitionLibrary.js";
import { CLOSINGS, renderClosing, CLOSING_LIBRARY_VERSION } from "./closingLibrary.js";
import { resolveRecipient, RECIPIENT_STANDARD_VERSION } from "./recipientLibrary.js";

import { APPROVED_BY_BUSINESS_TRAPPERS as OPENINGS_APPROVED } from "./openingLibrary.js";
import { APPROVED_BY_BUSINESS_TRAPPERS as TRANSITIONS_APPROVED } from "./transitionLibrary.js";
import { APPROVED_BY_BUSINESS_TRAPPERS as CLOSINGS_APPROVED } from "./closingLibrary.js";

export { resolveRecipient };

export const VOICE_SCHEMA_VERSION = "BT-VOICE-1.0";

export { OPENINGS, TRANSITIONS, CLOSINGS };

/**
 * FNV-1a. Stable across processes, machines, and Node versions.
 *
 * Deliberately NOT Math.random(), NOT Date.now(), NOT a counter. Selection must
 * depend ONLY on facts about the letter, or the letter cannot be reproduced.
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
 * The seed.
 *
 * CLIENT is included so two consumers writing to the same bureau in the same
 * round do not send the same letter. That is the mass-production pattern a
 * bureau would spot first, and it is the one that discredits every other letter
 * we send.
 *
 * ROUND is included so a consumer's second letter to a bureau does not open with
 * the sentence her first one did — to the one reader most likely to have both on
 * file.
 */
function seedFor(part, context) {
    return [
        part,
        context.crcClientId ?? "no-client",
        context.bureau ?? "no-bureau",
        context.round ?? 1,
        context.reportDate ?? "no-report",
    ].join("|");
}

/**
 * Each library is seeded SEPARATELY.
 *
 * If one seed drove all three, opening #3 would always travel with transition #3
 * and closing #3. The 560 combinations would collapse to 10, and the PAIRING
 * would become the fingerprint — the same repetition we are avoiding, one level
 * up, and harder to notice.
 */
function pick(library, part, context) {
    const seed = seedFor(part, context);
    const index = fnv1a(seed) % library.length;

    return { entry: library[index], index, seed };
}

/**
 * Select a complete, approved letter voice.
 *
 * @param {object} context
 * @param {string|number} context.crcClientId
 * @param {string} context.bureau
 * @param {number} context.round
 * @param {string} context.reportDate
 */
export function selectVoice(context) {
    const opening = pick(OPENINGS, "opening", context);
    const transition = pick(TRANSITIONS, "transition", context);
    const closing = pick(CLOSINGS, "closing", context);

    return {
        schemaVersion: VOICE_SCHEMA_VERSION,

        opening: {
            id: opening.entry.id,
            text: renderOpening(opening.entry),
        },
        transition: {
            id: transition.entry.id,
            text: transition.entry.text,
        },
        closing: {
            id: closing.entry.id,
            text: renderClosing(closing.entry),
        },

        // Audit trail. Kris can reproduce any letter from this alone.
        provenance: {
            combination: `${opening.entry.id}/${transition.entry.id}/${closing.entry.id}`,
            libraries: {
                opening: OPENING_LIBRARY_VERSION,
                transition: TRANSITION_LIBRARY_VERSION,
                closing: CLOSING_LIBRARY_VERSION,
                recipient: RECIPIENT_STANDARD_VERSION,
            },
            generated: false, // INVARIANT. No model touches this text.

            // TRUE only when Business Trappers has authored and approved every
            // library. Surfaced on every letter so a placeholder library can never
            // be mistaken for an approved one — the mistake that put a fabricated
            // address on a dispute letter once already.
            librariesApproved: OPENINGS_APPROVED && TRANSITIONS_APPROVED && CLOSINGS_APPROVED,
        },
    };
}

/** Total approved combinations. Useful for governance review. */
export function combinationCount() {
    return OPENINGS.length * TRANSITIONS.length * CLOSINGS.length;
}
