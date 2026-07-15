/**
 * voice.js
 *
 * BUSINESS TRAPPERS VOICE SELECTOR™
 * Flat-src production module.
 *
 * Selects approved opening, transition, and closing content deterministically.
 * The same client/bureau/round/report-date combination always produces the same
 * voice combination.
 */

import {
    OPENINGS,
    OPENING_LIBRARY_VERSION,
    APPROVED_BY_BUSINESS_TRAPPERS as OPENINGS_APPROVED,
    APPROVAL as OPENINGS_APPROVAL,
    renderOpening,
} from "./openingLibrary.js";

import {
    TRANSITIONS,
    TRANSITION_LIBRARY_VERSION,
    APPROVED_BY_BUSINESS_TRAPPERS as TRANSITIONS_APPROVED,
    APPROVAL as TRANSITIONS_APPROVAL,
} from "./transitionLibrary.js";

import {
    CLOSINGS,
    CLOSING_LIBRARY_VERSION,
    APPROVED_BY_BUSINESS_TRAPPERS as CLOSINGS_APPROVED,
    APPROVAL as CLOSINGS_APPROVAL,
    renderClosing,
} from "./closingLibrary.js";

export const VOICE_SELECTOR_VERSION = "BT-VOICE-1.0";

/**
 * Small deterministic 32-bit hash.
 * This is selection logic only; it is not used for identity or security.
 */
function hash32(value) {
    const text = String(value ?? "");
    let hash = 0x811c9dc5;

    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }

    return hash >>> 0;
}

function choose(entries, seed) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error("Voice library is empty.");
    }

    return entries[hash32(seed) % entries.length];
}

/**
 * Deterministically select approved letter voice content.
 */
export function selectVoice({
    crcClientId,
    bureau,
    round = 1,
    reportDate = null,
} = {}) {
    const baseSeed = [
        String(crcClientId ?? ""),
        String(bureau ?? "").toLowerCase(),
        String(round ?? 1),
        String(reportDate ?? ""),
    ].join("|");

    const opening = choose(OPENINGS, `${baseSeed}|opening`);
    const transition = choose(TRANSITIONS, `${baseSeed}|transition`);
    const closing = choose(CLOSINGS, `${baseSeed}|closing`);

    const librariesApproved =
        OPENINGS_APPROVED === true &&
        TRANSITIONS_APPROVED === true &&
        CLOSINGS_APPROVED === true;

    return {
        opening: {
            id: opening.id,
            text: renderOpening(opening),
        },
        transition: {
            id: transition.id,
            text: transition.text,
        },
        closing: {
            id: closing.id,
            text: renderClosing(closing),
        },
        provenance: {
            selectorVersion: VOICE_SELECTOR_VERSION,
            seed: baseSeed,
            openingId: opening.id,
            transitionId: transition.id,
            closingId: closing.id,
            openingLibraryVersion: OPENING_LIBRARY_VERSION,
            transitionLibraryVersion: TRANSITION_LIBRARY_VERSION,
            closingLibraryVersion: CLOSING_LIBRARY_VERSION,
            openingApproval: OPENINGS_APPROVAL,
            transitionApproval: TRANSITIONS_APPROVAL,
            closingApproval: CLOSINGS_APPROVAL,
            librariesApproved,
        },
    };
}
