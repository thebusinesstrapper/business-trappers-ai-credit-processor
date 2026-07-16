/**
 * ===========================================================================
 * BUREAU FIDELITY LAYER — the single access point for reported values.
 *
 * Governed by the Business Trappers Bureau Fidelity Standard™ v1.0.
 *
 * CONSTITUTIONAL SEPARATION:
 *   - The Bureau Fidelity Layer owns STORAGE. It alone knows where a reported
 *     value lives inside the BT Credit Report Model™.
 *   - The Intelligence Engine owns REASONING. It reads the normalized layer.
 *   - The Letter Engine owns PRESENTATION. It asks THIS module for a value and
 *     quotes what it gets. It must never reach into observation.reported itself.
 *
 * WHY A MODULE, NOT A MAP THE LETTER ENGINE READS:
 *   Bureau Fidelity now applies to EVERY externally-consumed document — disputes,
 *   and later CFPB/FTC/AG complaints, demand letters, arbitration exhibits,
 *   consumer reports. If the accessor logic lived inside the Letter Engine, every
 *   future document type would duplicate it or import letter internals. One
 *   module is the only way "all correspondence quotes Layer 2" is enforceable
 *   rather than re-implemented per document.
 *
 * WHY A VIEW WITH ACCESSORS, NOT getReportedValue(key, field):
 *   A bare field-name string is an unenforced contract. getReportedValue(key,
 *   "balnce") compiles, returns null, and the leak-check cannot tell "the bureau
 *   did not report a balance" from "the caller typo'd the field name." A view
 *   with named accessors makes a typo a missing-method error at the call site —
 *   loud, immediate, local — instead of a silent null three layers away.
 *
 * INTENTIONALLY SMALL: exactly the accessors the current Letter Engine quotes.
 * Future document generators EXTEND this module; they do not fork it, and we do
 * not design for them now.
 * ===========================================================================
 */

/**
 * A fail-closed marker. Returned when a value is genuinely absent from the
 * reported layer. It is NOT an empty string — an empty string would print as a
 * blank in a letter and look intentional. This marker is detectable by the
 * leak-check and by callers, and it never silently becomes prose.
 */
export const NO_REPORTED_VALUE = Symbol("NO_REPORTED_VALUE");

/**
 * True when an accessor returned an actual reported value (not the fail-closed
 * marker). Callers use this to decide whether a value may be quoted at all.
 */
export function hasReported(value) {
    return value !== NO_REPORTED_VALUE && value !== null && value !== undefined;
}

/**
 * The reported view of ONE bureau tradeline. Every accessor returns the bureau's
 * value EXACTLY as reported — a verbatim string — or NO_REPORTED_VALUE.
 *
 * Accessors NEVER coerce, reformat, expand, or canonicalize. "$4,200.00" is
 * returned as "$4,200.00". A date is returned in the bureau's own format. That is
 * the entire point: this is what a consumer, bureau, regulator, court, or auditor
 * may see.
 *
 * `basis` is exposed as METADATA. It does NOT gate what may be quoted — Bureau
 * Fidelity preserves what the bureau presented to the consumer, even when Array
 * serialized the observation as SHARED. How strongly a value may be RELIED UPON
 * for reasoning is the Intelligence Engine's concern (Standard §3.3), enforced in
 * the analyzer, not here.
 */
function makeReportedView(tradeline) {
    const reported = tradeline?.observation?.reported ?? {};

    // Furnisher and masked account live at the tradeline level (they are part of
    // its identity as presented), not inside the observation. The view hides that
    // distinction from the caller — which is the point: the Letter Engine does not
    // know where anything lives.
    const read = (value) =>
        value === null || value === undefined || value === "" ? NO_REPORTED_VALUE : value;

    return {
        // ---- Account label ----
        furnisher: () => read(tradeline?.furnisher),
        maskedAccount: () => read(tradeline?.masked_account),

        // ---- Reported observation values (verbatim strings) ----
        balance: () => read(reported.balance),
        pastDue: () => read(reported.past_due),
        // Bureau-reported status, VERBATIM. On ListAndStack @RawAccountStatus
        // (account_status) is frequently absent; the bureau's reportable status
        // then lives verbatim in current_rating ("CollectionOrChargeOff") or
        // account_status_type ("Closed"). Quote the first present verbatim value.
        // All three are Layer 2 reported strings — the reasoning/normalized layer
        // is never consulted here.
        status: () =>
            read(reported.account_status)      !== NO_REPORTED_VALUE ? read(reported.account_status)
          : read(reported.current_rating)      !== NO_REPORTED_VALUE ? read(reported.current_rating)
          : read(reported.account_status_type),
        dateOfFirstDelinquency: () => read(reported.dofd),
        dateOpened: () => read(reported.date_opened),

        // ---- Metadata. Does NOT gate quoting. ----
        basis: () => tradeline?.observation?.basis ?? null,
        bureau: () => tradeline?.bureau ?? null,

        // The tradeline's position in the bureau's report. Letter Intelligence
        // Standard §4: tradelines appear in the EXACT order shown on that bureau's
        // report — never reordered, prioritized, or grouped. This is that order.
        // A tradeline with no recorded position sorts last (Infinity) rather than
        // silently jumping to the front.
        reportOrder: () =>
            Number.isFinite(tradeline?.source_row_index) ? tradeline.source_row_index : Infinity,
    };
}

/**
 * Build the Bureau Fidelity Layer over a BT Credit Report Model™.
 *
 * Returns { forItem, has }. `forItem(stable_item_key)` yields the reported view
 * for that tradeline, or null if the report does not contain it. The index is
 * PRIVATE — the caller never sees the map, only the view.
 */
export function createBureauFidelity(report) {
    const byItem = new Map();

    if (report) {
        const groups = [
            ...(report.accounts ?? []),
            ...(report.collections ?? []),
            ...(report.public_records ?? []),
        ];

        for (const account of groups) {
            for (const tradeline of account.bureau_tradelines ?? []) {
                if (tradeline?.stable_item_key) {
                    byItem.set(tradeline.stable_item_key, tradeline);
                }
            }
        }
    }

    return {
        /**
         * The reported view for one tradeline, or null if unknown.
         *
         * A null return is a HARD condition for the caller: a letter cannot quote
         * a tradeline the Fidelity Layer has never heard of. That is a fail-closed
         * signal, not a value to paper over.
         */
        forItem(stableItemKey) {
            const tradeline = byItem.get(stableItemKey);
            return tradeline ? makeReportedView(tradeline) : null;
        },

        /** Whether the Fidelity Layer knows this tradeline at all. */
        has(stableItemKey) {
            return byItem.has(stableItemKey);
        },
    };
}
