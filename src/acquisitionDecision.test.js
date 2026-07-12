/**
 * acquisitionDecision.test.js
 *
 * The decision to spend a client's entitlement is a pure function, so it is
 * tested exhaustively with no browser, no credentials, and no live session.
 *
 * Run: node src/acquisitionDecision.test.js
 *
 * EVERY test that expects manual_review is a test that a client's money stays
 * where it is. They matter more than the happy path.
 */

import { decideAcquisition, DECISIONS } from "./acquisitionDecision.js";
import { parseCost, parseAvailableFrom, FREE_OPTION_ID, PAID_OPTION_ID } from "./orderPageReader.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    const ok = actual === expected;
    if (ok) passed++;
    else failed++;
    console.log(
        `${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} -> ${actual}${ok ? "" : `  (expected ${expected})`}`
    );
}

/** A well-formed page: free option at $0.00, paid option at $39.99. */
function goodPage(overrides = {}) {
    return {
        page_read: true,
        url: "https://creditheroscore.example/mcc_order_select_v2.asp",
        unaccounted_option_ids: [],
        options: [
            {
                id: FREE_OPTION_ID,
                cost: 0,
                cost_evidence: "$0.00",
                disabled: false,
                visible: true,
                is_known: true,
            },
            {
                id: PAID_OPTION_ID,
                cost: 39.99,
                cost_evidence: "$39.99",
                disabled: false,
                visible: true,
                is_known: true,
            },
        ],
        errors: [],
        ...overrides,
    };
}

const NEED = { newer_report_required: true, open_acquisition_intent: null };

console.log("\n=== parseCost ===\n");

check("$0.00 -> 0", parseCost("$0.00").cost, 0);
check("$0 -> 0", parseCost("Included $0").cost, 0);
check("$39.99 -> 39.99", parseCost("Only $39.99").cost, 39.99);
check("FREE -> 0", parseCost("FREE with membership").cost, 0);
check("empty -> null (NOT zero)", parseCost("").cost, null);
check("no price text -> null (NOT zero)", parseCost("Order your report").cost, null);
check("null input -> null", parseCost(null).cost, null);
check("two conflicting prices -> null (ambiguous)", parseCost("Was $39.99, now $0.00").cost, null);
check("strikethrough promo -> null (ambiguous)", parseCost("$0.00 (reg. $39.99)").cost, null);
check("same price twice -> priced (not ambiguous)", parseCost("$39.99 — only $39.99").cost, 39.99);
check("'FREE' plus a real price -> priced, not free", parseCost("FREE trial then $29.99").cost, 29.99);

console.log("\n=== Happy path ===\n");

check(
    "all preconditions met -> submit",
    decideAcquisition(goodPage(), NEED).decision,
    DECISIONS.SUBMIT_FREE_REPORT
);

console.log("\n=== Money-safety: every one of these must NOT submit ===\n");

check(
    "memory does not require a report -> no action",
    decideAcquisition(goodPage(), { newer_report_required: false }).decision,
    DECISIONS.NO_ACTION_REQUIRED
);

check(
    "unresolved intent record -> manual_review (idempotency)",
    decideAcquisition(goodPage(), {
        newer_report_required: true,
        open_acquisition_intent: { processing_run_id: "run_123", submitted_at: null },
    }).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "UNACCOUNTED option (productBuyNew_02) -> manual_review",
    decideAcquisition(
        goodPage({
            unaccounted_option_ids: ["productBuyNew_02"],
            options: [
                ...goodPage().options,
                {
                    id: "productBuyNew_02",
                    cost: null,
                    cost_evidence: null,
                    disabled: false,
                    visible: true,
                    is_known: false,
                },
            ],
        }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "an option is unpriced -> manual_review",
    decideAcquisition(
        goodPage({
            options: [
                { ...goodPage().options[0] },
                { ...goodPage().options[1], cost: null, cost_evidence: null },
            ],
        }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "free option is NOT actually zero-cost -> manual_review",
    decideAcquisition(
        goodPage({
            options: [
                { ...goodPage().options[0], cost: 19.99, cost_evidence: "$19.99" },
                { ...goodPage().options[1] },
            ],
        }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "free option disabled -> manual_review",
    decideAcquisition(
        goodPage({
            options: [{ ...goodPage().options[0], disabled: true }, { ...goodPage().options[1] }],
        }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "free option not visible -> manual_review",
    decideAcquisition(
        goodPage({
            options: [{ ...goodPage().options[0], visible: false }, { ...goodPage().options[1] }],
        }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "free option missing entirely -> manual_review",
    decideAcquisition(
        goodPage({ options: [goodPage().options[1]] }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "paid option missing (page unrecognised) -> manual_review",
    decideAcquisition(
        goodPage({ options: [goodPage().options[0]] }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "paid option priced at 0 (confused page) -> manual_review",
    decideAcquisition(
        goodPage({
            options: [
                { ...goodPage().options[0] },
                { ...goodPage().options[1], cost: 0, cost_evidence: "FREE" },
            ],
        }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "page could not be read -> manual_review",
    decideAcquisition({ page_read: false, options: [] }, NEED).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "no options on page -> manual_review",
    decideAcquisition(goodPage({ options: [] }), NEED).decision,
    DECISIONS.MANUAL_REVIEW
);

console.log("\n=== Availability window (real spike data, 2026-07-12) ===\n");

/**
 * THE OBSERVED STATE. Both radios disabled.
 *   free (_01, $0.00)  available 2026-08-10
 *   paid (_03, $18.95) available 2026-07-18
 *
 * Between 7/18 and 8/10 the PAID option is enabled and the FREE one is not.
 * Anything that "selects whatever is available" buys an $18.95 report.
 */
function observedPage(overrides = {}) {
    return {
        page_read: true,
        unaccounted_option_ids: [],
        options: [
            {
                id: FREE_OPTION_ID,
                cost: 0,
                cost_evidence: "FREE",
                available_from: "2026-08-10",
                disabled: true,
                visible: false,
                is_known: true,
            },
            {
                id: PAID_OPTION_ID,
                cost: 18.95,
                cost_evidence: "$18.95",
                available_from: "2026-07-18",
                disabled: true,
                visible: false,
                is_known: true,
            },
        ],
        errors: [],
        ...overrides,
    };
}

check(
    "observed page today -> not yet available (NOT manual_review)",
    decideAcquisition(observedPage(), NEED).decision,
    DECISIONS.FREE_REPORT_NOT_YET_AVAILABLE
);

check(
    "not-yet-available surfaces the date",
    decideAcquisition(observedPage(), NEED).available_from,
    "2026-08-10"
);

check(
    "not-yet-available never submits",
    decideAcquisition(observedPage(), NEED).submitted,
    false
);

// THE CRITICAL TEST. Paid enabled, free still disabled — the 23-day window.
check(
    "PAID-ONLY WINDOW: paid enabled, free not -> must NOT submit",
    decideAcquisition(
        observedPage({
            options: [
                { ...observedPage().options[0] },                                  // free: still disabled
                { ...observedPage().options[1], disabled: false, visible: true },  // paid: NOW ENABLED
            ],
        }),
        NEED
    ).decision,
    DECISIONS.FREE_REPORT_NOT_YET_AVAILABLE
);

check(
    "disabled with NO availability date -> manual_review (unexplained)",
    decideAcquisition(
        observedPage({
            options: [
                { ...observedPage().options[0], available_from: null },
                { ...observedPage().options[1] },
            ],
        }),
        NEED
    ).decision,
    DECISIONS.MANUAL_REVIEW
);

check(
    "free option becomes enabled on 8/10 -> submit",
    decideAcquisition(
        observedPage({
            options: [
                { ...observedPage().options[0], disabled: false, visible: true },
                { ...observedPage().options[1], disabled: false, visible: true },
            ],
        }),
        NEED
    ).decision,
    DECISIONS.SUBMIT_FREE_REPORT
);

console.log("\n=== parseAvailableFrom ===\n");

check(
    "parses the observed label format",
    parseAvailableFrom("(Available 8/10/2026) 3 Bureau Report & Score FREE."),
    "2026-08-10"
);
check(
    "parses the paid label format",
    parseAvailableFrom("(Available 7/18/2026) 3 Bureau ... $18.95."),
    "2026-07-18"
);
check("no date -> null", parseAvailableFrom("3 Bureau Report & Score FREE."), null);
check("non-string -> null", parseAvailableFrom(null), null);

console.log("\n=== Invariant ===\n");

const submitDecision = decideAcquisition(goodPage(), NEED);
check("engine never reports submitted=true", submitDecision.submitted, false);
check("selected option is the FREE one", submitDecision.selected_option.id, FREE_OPTION_ID);
check("paid option positively excluded", submitDecision.excluded_paid_option.id, PAID_OPTION_ID);

console.log(`\n${passed} passed, ${failed} failed.\n`);

if (failed > 0) process.exit(1);
