/**
 * creditHeroLandingState.js — READ-ONLY classification of the page CreditHero
 * lands on after "View CreditHeroScore Account" is opened.
 *
 * SEPARATE FROM importAuditState.js ON PURPOSE. That module reads the CRC
 * dashboard / Import-Audit tab. These markers live on CreditHero's OWN pages,
 * a different origin. Recognizing one page's state from another page's reader
 * would be a category error, so CreditHero landing recognition lives here.
 *
 * READ-ONLY. locator / textContent / getAttribute / count only. No click, fill,
 * submit, or navigation. This module never enters payment details, never clicks
 * "Update Payment Details", never confirms login, never orders anything.
 *
 * PRIVACY. Transaction and payment identifiers (epGUID, tGUID, payment_token,
 * and anything token-like) are never read, returned, logged, or persisted. Only
 * a classification and a short list of NON-sensitive text markers leave here.
 */

export const CH_LANDING_STATE = Object.freeze({
    PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
    CREDENTIALS_OR_AUTH_FAILED: "CREDENTIALS_OR_AUTH_FAILED",
    HEALTHY_MEMBER_DASHBOARD: "HEALTHY_MEMBER_DASHBOARD",
    UNKNOWN: "UNKNOWN",
});

const READ_TIMEOUT = 8000;

/**
 * Positive markers, from the supplied live DOM. Each state needs corroborating
 * evidence — a single stray phrase is not enough to act on.
 *
 * ORDER MATTERS. CREDENTIALS_OR_AUTH_FAILED is checked BEFORE PAYMENT_REQUIRED:
 * its page mentions payment ("payment information has already been updated") but
 * is explicitly NOT a payment-required page, so a payment-first check would
 * misfile it.
 */
const AUTH_MARKERS = [
    /payment information has already been updated/i,
    /please\s+login to confirm/i,
    /customer_login\.asp/i,
];

const PAYMENT_MARKERS = [
    /update payment details/i,
    /your last payment didn.?t go through/i,
    /please update your payment details/i,
    /payment_update\.asp/i,
    // OBSERVED LIVE (Brittney Jones, production pilot): CreditHero also states
    // the failure as a transaction line rather than a sentence —
    //   "Payment of $24.99 failed on 6/14/2026"
    // The amount and date vary, so both are matched as patterns rather than
    // literals. This wording shares NO phrase with the sentence form above,
    // which is why the previous single-phrase gate could not see it.
    /payment of \$\s*[\d,]+(?:\.\d{2})?\s+failed\s+on\b/i,
];

/**
 * THE DECISIVE PHRASES — either one is enough to be considered, neither is
 * enough to CONCLUDE.
 *
 * A page is only classified PAYMENT_REQUIRED when one of these appears AND a
 * second, independent signal corroborates it (another marker, or the
 * payment_update form). That two-signal rule is unchanged; all that has widened
 * is what counts as decisive, because CreditHero states the same fact two
 * different ways.
 *
 * Order still matters overall: CREDENTIALS_OR_AUTH_FAILED is evaluated BEFORE
 * this block, because its page also mentions payment ("payment information has
 * already been updated") and a payment-first check would misfile it. Neither
 * pattern below matches that sentence.
 */
const DECISIVE_PAYMENT_MARKERS = [
    /your last payment didn.?t go through/i,
    /payment of \$\s*[\d,]+(?:\.\d{2})?\s+failed\s+on\b/i,
];

// A healthy member dashboard is recognized positively too, rather than assumed
// from "nothing matched". These are conservative dashboard signals.
const HEALTHY_MARKERS = [
    /credit\s*hero\s*score/i,
    /member dashboard/i,
    /view\s+report/i,
];

/** Count how many patterns match the given text. */
function countMatches(patterns, text) {
    let n = 0;
    const matched = [];
    for (const re of patterns) {
        if (re.test(text)) {
            n += 1;
            // Store a SAFE label, not the raw match — never a URL token.
            matched.push(re.source.replace(/\\s\*|\\s\+|\\./g, " ").slice(0, 40));
        }
    }
    return { n, matched };
}

/**
 * Read the landed page's visible text across all frames. Text only — never
 * attributes, hrefs with tokens, or hidden inputs.
 */
async function readVisibleText(page) {
    let combined = "";

    for (const frame of page.frames()) {
        const text = await frame
            .locator("body")
            .innerText({ timeout: READ_TIMEOUT })
            .catch(() => "");
        if (text) combined += "\n" + text;
    }

    return combined;
}

/**
 * Whether a link to the given ASP page exists, checked by href attribute.
 * Returns only a boolean — the href itself (which may carry tGUID) never leaves.
 */
async function hasLinkTo(page, aspName) {
    for (const frame of page.frames()) {
        const link = frame.locator(`a[href*="${aspName}"]`).first();
        if ((await link.count().catch(() => 0)) > 0) return true;
    }
    return false;
}

/**
 * Classify the CreditHero landing page. Read-only.
 *
 * @param {import('playwright').Page} page  the page CreditHero landed on
 * @returns {Promise<{state: string, reason: string, evidence: string[]}>}
 */
export async function recognizeCreditHeroLanding(page) {
    const text = await readVisibleText(page).catch(() => "");

    if (!text) {
        return {
            state: CH_LANDING_STATE.UNKNOWN,
            reason: "Landing page produced no readable text.",
            evidence: [],
        };
    }

    // ---- 1. CREDENTIALS/AUTH first (its page also mentions payment) --------
    const auth = countMatches(AUTH_MARKERS, text);
    const authLink = await hasLinkTo(page, "customer_login.asp").catch(() => false);

    // "already updated ... login to confirm" is the decisive phrase; the login
    // link corroborates. Require the phrase plus one more signal.
    if (/payment information has already been updated/i.test(text) && (auth.n >= 2 || authLink)) {
        return {
            state: CH_LANDING_STATE.CREDENTIALS_OR_AUTH_FAILED,
            reason: "CreditHero login or authentication confirmation required.",
            evidence: [...auth.matched, ...(authLink ? ["link:customer_login"] : [])],
        };
    }

    // ---- 2. PAYMENT_REQUIRED ----------------------------------------------
    const pay = countMatches(PAYMENT_MARKERS, text);
    const payForm = await hasLinkTo(page, "payment_update.asp").catch(() => false);

    // Require one DECISIVE failed-payment statement (either observed wording)
    // plus a corroborating signal (another marker, or the payment_update form).
    const decisive = DECISIVE_PAYMENT_MARKERS.some((re) => re.test(text));

    if (decisive && (pay.n >= 2 || payForm)) {
        return {
            state: CH_LANDING_STATE.PAYMENT_REQUIRED,
            reason: "CreditHero reports the last payment failed and requires a payment update.",
            evidence: [...pay.matched, ...(payForm ? ["form:payment_update"] : [])],
        };
    }

    // ---- 3. HEALTHY member dashboard --------------------------------------
    const healthy = countMatches(HEALTHY_MARKERS, text);

    if (healthy.n >= 2) {
        return {
            state: CH_LANDING_STATE.HEALTHY_MEMBER_DASHBOARD,
            reason: "CreditHero member dashboard is present.",
            evidence: healthy.matched,
        };
    }

    // ---- 4. Nothing positively proven -------------------------------------
    //
    // Do NOT guess inactive or credentials-failed. UNKNOWN preserves the
    // existing manual-review / CREDIT_HERO_UNAVAILABLE behavior upstream.
    return {
        state: CH_LANDING_STATE.UNKNOWN,
        reason: "No CreditHero landing state was positively identified.",
        evidence: [],
    };
}
