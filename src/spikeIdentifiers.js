/**
 * spikeIdentifiers.js
 *
 * IDENTIFIER COMPARISON SPIKE — analysis engine.
 *
 * PURE. No browser. No Playwright. Fully unit-testable.
 *
 * Answers two independent questions about each vendor identifier:
 *
 *   1. CROSS-TIME STABILITY
 *      Does the same underlying account keep this identifier across report
 *      dates? An identifier that drifts detaches dispute history — silently,
 *      and unrecoverably.
 *
 *   2. CROSS-BUREAU CORRELATION
 *      Within one ListAndStack report, an account arrives as up to THREE
 *      stacked single-bureau records. Does this identifier group them?
 *
 * These are DIFFERENT properties. An identifier can be perfectly stable over
 * time and still be unique per bureau record (so it groups nothing), or group
 * bureaus perfectly and be regenerated every refresh (so it remembers nothing).
 * We need both, and we test them separately.
 *
 * ---------------------------------------------------------------------------
 * FROZEN RULING (unchanged by any result this spike produces):
 *
 *   - Business Trappers mints and persists its own UUID stable_item_key.
 *   - No Array.io or MISMO identifier ever becomes the permanent key.
 *   - Vendor identifiers are EVIDENCE within the matching cascade. Nothing more.
 *   - TradelineHashComplex is captured for change detection and NEVER used for
 *     identity.
 *
 * This spike proposes TIERS. It does not confer identity.
 * ---------------------------------------------------------------------------
 */

export const IDENTIFIERS = [
    "ArrayAccountIdentifier",
    "TradelineHashSimple",
    "TradelineHashComplex",
    "CreditLiabilityID",
];

/**
 * Identifier we will capture but must NEVER promote to an identity tier,
 * regardless of what the evidence says.
 *
 * Rationale: a "complex" hash almost certainly incorporates balance, status,
 * and dates — fields that change every month BY DESIGN. Its purpose is to
 * differ when the data differs. That makes it a superb change-detection signal
 * and a catastrophic identity key. Even if it appeared stable across two
 * reports (because nothing happened to change), promoting it would be reasoning
 * from a coincidence.
 */
export const NEVER_AN_IDENTITY_KEY = ["TradelineHashComplex"];

// ---------------------------------------------------------------------------
// Defensive field extraction
//
// We have not seen the real MISMO payload, so we do NOT hardcode paths. We walk
// the object and recognise fields by name. This is the same evidence-first
// posture used everywhere else in this project: recognise what is there rather
// than assert what should be.
// ---------------------------------------------------------------------------

const CREDITOR_KEYS = /^(_?full_?name|creditor|creditorname|subscribername|_name|name|furnisher)$/i;
const ACCOUNT_KEYS = /account.?(identifier|number)|_accountidentifier|accountnumber/i;
const ACCOUNT_TYPE_KEYS = /account.?type|_type$|liability.?type/i;
const OPENED_KEYS = /account.?opened|_accountopeneddate|opened.?date|dateopened/i;
const BUREAU_KEYS = /repository|bureau|source.?type|_creditrepositorysourcetype/i;

const BUREAU_VALUES = {
    transunion: /trans\s*union|transunion|^tu$|tui/i,
    experian: /experian|^exp$/i,
    equifax: /equifax|^eqf?$/i,
};

function normalizeBureau(value) {
    if (typeof value !== "string") return null;

    for (const [bureau, pattern] of Object.entries(BUREAU_VALUES)) {
        if (pattern.test(value)) return bureau;
    }

    return null;
}

/**
 * MISMO decorates keys with "@" (attribute) and "_" (element) prefixes:
 *
 *     "@_AccountIdentifier", "_CREDITOR", "@_FullName"
 *
 * Matching against the raw key silently fails — and a silent extraction failure
 * here does not throw, it just produces null fields, which makes every account
 * unvalidatable and every verdict INCONCLUSIVE. The analysis would look like it
 * ran and tell us nothing.
 */
function bareKey(key) {
    return key.replace(/^[@_]+/, "");
}

/**
 * Walk an object collecting the first value whose key matches a pattern.
 */
function findField(obj, pattern, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 4) return null;

    for (const [key, value] of Object.entries(obj)) {
        if (pattern.test(bareKey(key)) && (typeof value === "string" || typeof value === "number")) {
            return String(value);
        }
    }

    // Descend into nested objects (MISMO nests heavily).
    for (const value of Object.values(obj)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const found = findField(value, pattern, depth + 1);
            if (found) return found;
        }
    }

    return null;
}

/**
 * Extract every tradeline-like record from an Array.io / MISMO payload.
 *
 * A record qualifies if it carries ANY of the four identifiers we are studying.
 * We do not require a particular path — we find them wherever they live.
 */
export function extractTradelineRecords(json) {
    const records = [];

    const walk = (node, inheritedBureau) => {
        if (!node || typeof node !== "object") return;

        if (Array.isArray(node)) {
            for (const item of node) walk(item, inheritedBureau);
            return;
        }

        // Bureau attribution can sit on an ancestor in a ListAndStack payload.
        let bureau = inheritedBureau;

        for (const [key, value] of Object.entries(node)) {
            if (BUREAU_KEYS.test(bareKey(key))) {
                const detected = normalizeBureau(String(value));
                if (detected) bureau = detected;
            }
        }

        const hasIdentifier = IDENTIFIERS.some((id) =>
            Object.keys(node).some((k) => k.replace(/^[@_]/, "").toLowerCase() === id.toLowerCase())
        );

        if (hasIdentifier) {
            const identifiers = {};

            for (const id of IDENTIFIERS) {
                const key = Object.keys(node).find(
                    (k) => k.replace(/^[@_]/, "").toLowerCase() === id.toLowerCase()
                );
                identifiers[id] = key ? String(node[key]) : null;
            }

            records.push({
                bureau: bureau ?? normalizeBureau(findField(node, BUREAU_KEYS) ?? "") ?? null,
                identifiers,
                validation: {
                    creditor: findField(node, CREDITOR_KEYS),
                    account_number: findField(node, ACCOUNT_KEYS),
                    account_type: findField(node, ACCOUNT_TYPE_KEYS),
                    opened_date: findField(node, OPENED_KEYS),
                },
            });
        }

        for (const value of Object.values(node)) walk(value, bureau);
    };

    walk(json, null);

    return records;
}

// ---------------------------------------------------------------------------
// Validation key
//
// This is how we decide two records are "the same underlying account" FOR THE
// PURPOSE OF TESTING. It is scaffolding, NOT a proposed key. Per the ruling,
// these fields never become the permanent Business Trappers key.
// ---------------------------------------------------------------------------

function normalizeCreditor(name) {
    if (!name) return null;

    return String(name)
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, "")
        .replace(/\b(NA|INC|LLC|CORP|BANK USA|CARD SERVICES|THE)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function last4(accountNumber) {
    if (!accountNumber) return null;

    const digits = String(accountNumber).replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(-4) : null;
}

function openedYearMonth(date) {
    if (!date) return null;

    const match = String(date).match(/(\d{4})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}`;

    const us = String(date).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) return `${us[3]}-${String(us[1]).padStart(2, "0")}`;

    return null;
}

/**
 * The account this record belongs to, for validation purposes only.
 * Returns null when we cannot confidently identify it — such records are
 * reported as unvalidatable rather than guessed at.
 */
export function validationKey(record) {
    const creditor = normalizeCreditor(record.validation?.creditor);
    const acct = last4(record.validation?.account_number);
    const opened = openedYearMonth(record.validation?.opened_date);

    if (!creditor) return null;
    if (!acct && !opened) return null; // creditor alone is not enough

    return [creditor, acct ?? "?", opened ?? "?"].join("|");
}

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

/**
 * @param {Array<{report_date: string, records: Array}>} reports
 *        Two or more reports, each with its extracted tradeline records.
 */
export function analyzeIdentifiers(reports) {
    const results = {};

    // Index every record by validation key, per report.
    const indexed = reports.map((report) => {
        const byAccount = new Map();
        const unvalidatable = [];

        for (const record of report.records) {
            const key = validationKey(record);

            if (!key) {
                unvalidatable.push(record);
                continue;
            }

            if (!byAccount.has(key)) byAccount.set(key, []);
            byAccount.get(key).push(record);
        }

        return { report_date: report.report_date, byAccount, unvalidatable, total: report.records.length };
    });

    for (const identifier of IDENTIFIERS) {
        // ---- Coverage -----------------------------------------------------
        let present = 0;
        let total = 0;

        for (const report of reports) {
            for (const record of report.records) {
                total++;
                if (record.identifiers?.[identifier]) present++;
            }
        }

        // ---- Cross-bureau correlation, WITHIN each report -----------------
        //
        // For one account, do the stacked per-bureau records SHARE this
        // identifier (it groups) or each carry their own (it does not)?
        let groupsAcrossBureaus = 0;
        let uniquePerBureauRecord = 0;
        let bureauInconclusive = 0;

        for (const report of indexed) {
            for (const [, records] of report.byAccount) {
                // Only meaningful when the account appears at 2+ bureaus.
                const bureaus = new Set(records.map((r) => r.bureau).filter(Boolean));
                if (bureaus.size < 2) continue;

                const values = records.map((r) => r.identifiers?.[identifier]).filter(Boolean);

                if (values.length < 2) {
                    bureauInconclusive++;
                    continue;
                }

                const distinct = new Set(values);

                if (distinct.size === 1) groupsAcrossBureaus++;
                else if (distinct.size === values.length) uniquePerBureauRecord++;
                else bureauInconclusive++;
            }
        }

        // ---- Cross-time stability, ACROSS reports -------------------------
        //
        // For an account present in two reports, does the identifier survive?
        //
        // Compared PER BUREAU, because if the identifier is unique per bureau
        // record, comparing a TU value against an EXP value would look unstable
        // when it is merely per-bureau. We must not conflate the two failures.
        let stable = 0;
        let changed = 0;
        let timeInconclusive = 0;
        const changed_examples = [];

        if (indexed.length >= 2) {
            const [first, second] = indexed;

            for (const [account, firstRecords] of first.byAccount) {
                const secondRecords = second.byAccount.get(account);
                if (!secondRecords) continue; // account absent from the other report

                for (const a of firstRecords) {
                    const b = secondRecords.find((r) => r.bureau === a.bureau);
                    if (!b) continue;

                    const va = a.identifiers?.[identifier];
                    const vb = b.identifiers?.[identifier];

                    if (!va || !vb) {
                        timeInconclusive++;
                        continue;
                    }

                    if (va === vb) {
                        stable++;
                    } else {
                        changed++;
                        if (changed_examples.length < 5) {
                            changed_examples.push({
                                account,
                                bureau: a.bureau,
                                [`${first.report_date}`]: va,
                                [`${second.report_date}`]: vb,
                            });
                        }
                    }
                }
            }
        }

        // ---- Collisions ---------------------------------------------------
        //
        // The same identifier value appearing on TWO DIFFERENT accounts. This is
        // the worst possible defect: it would attach one account's dispute
        // history to another's, undetectably and irreversibly.
        //
        // Checked BOTH within a report AND across reports. The across-reports
        // case is the one that actually bites: a document-local identifier like
        // CreditLiabilityID is sequential WITHIN a report, so it never collides
        // inside one — but when a new tradeline appears at the top of next
        // month's list, every ID shifts down, and CL_001 now names a DIFFERENT
        // account than it did last month.
        //
        // A within-report-only check would see no collisions and wave it through.
        const collisions = [];
        const globalValueToAccounts = new Map();

        for (const report of indexed) {
            const valueToAccounts = new Map();

            for (const [account, records] of report.byAccount) {
                for (const record of records) {
                    const value = record.identifiers?.[identifier];
                    if (!value) continue;

                    if (!valueToAccounts.has(value)) valueToAccounts.set(value, new Set());
                    valueToAccounts.get(value).add(account);

                    if (!globalValueToAccounts.has(value)) globalValueToAccounts.set(value, new Map());
                    globalValueToAccounts.get(value).set(account, report.report_date);
                }
            }

            for (const [value, accounts] of valueToAccounts) {
                if (accounts.size > 1) {
                    collisions.push({
                        scope: "within_report",
                        report_date: report.report_date,
                        identifier_value: value,
                        accounts: [...accounts],
                    });
                }
            }
        }

        // Across reports: the same value naming different accounts over time.
        for (const [value, accountMap] of globalValueToAccounts) {
            if (accountMap.size > 1) {
                collisions.push({
                    scope: "across_reports",
                    identifier_value: value,
                    accounts: [...accountMap.entries()].map(([account, report_date]) => ({
                        account,
                        report_date,
                    })),
                    note:
                        "The same identifier value names DIFFERENT accounts in different reports. " +
                        "Keying on this would attach one account's dispute history to another.",
                });
            }
        }

        results[identifier] = {
            coverage: {
                present,
                total,
                percent: total ? Math.round((present / total) * 100) : 0,
                missing: total - present,
            },
            cross_bureau: {
                groups_across_bureaus: groupsAcrossBureaus,
                unique_per_bureau_record: uniquePerBureauRecord,
                inconclusive: bureauInconclusive,
                verdict:
                    groupsAcrossBureaus > 0 && uniquePerBureauRecord === 0
                        ? "GROUPS — shared across the stacked bureau records for one account"
                        : uniquePerBureauRecord > 0 && groupsAcrossBureaus === 0
                            ? "PER-BUREAU — a different value on each bureau record (does not group)"
                            : groupsAcrossBureaus === 0 && uniquePerBureauRecord === 0
                                ? "INCONCLUSIVE — no account observed at 2+ bureaus with this identifier"
                                : "MIXED — behaves inconsistently. Not trustworthy.",
            },
            cross_time: {
                stable,
                changed,
                inconclusive: timeInconclusive,
                changed_examples,
                verdict:
                    stable > 0 && changed === 0
                        ? "STABLE — unchanged across report dates"
                        : changed > 0 && stable === 0
                            ? "REGENERATED — changes on every report. Useless for identity."
                            : changed > 0
                                ? "PARTIALLY UNSTABLE — changes for some accounts. Unusable."
                                : "INCONCLUSIVE — no account present in both reports with this identifier",
            },
            collisions,
        };
    }

    return {
        reports: indexed.map((r) => ({
            report_date: r.report_date,
            tradeline_records: r.total,
            distinct_accounts: r.byAccount.size,
            unvalidatable_records: r.unvalidatable.length,
        })),
        identifiers: results,
        recommendation: recommendTiers(results),
    };
}

/**
 * Propose matching tiers. PROPOSE — the cascade is not changed by this spike.
 *
 * An identifier qualifies as an identity tier only if it is:
 *   - stable across time (or we cannot use it to remember anything),
 *   - collision-free (or it corrupts history),
 *   - reasonably covered (or it is unusable in practice),
 *   - and not on the NEVER_AN_IDENTITY_KEY list, whatever the evidence says.
 */
export function recommendTiers(results) {
    const proposed = [];
    const rejected = [];

    for (const [identifier, result] of Object.entries(results)) {
        if (NEVER_AN_IDENTITY_KEY.includes(identifier)) {
            rejected.push({
                identifier,
                reason:
                    "Frozen ruling: captured for change detection only, never used for identity. " +
                    "A content hash that appears stable across two reports is stable by coincidence " +
                    "(nothing changed), not by design.",
                use_instead: "change_detection_signal",
            });
            continue;
        }

        const stableOverTime = result.cross_time.verdict.startsWith("STABLE");
        const collisionFree = result.collisions.length === 0;
        const covered = result.coverage.percent >= 90;

        if (!stableOverTime) {
            rejected.push({
                identifier,
                reason: `Not stable across report dates (${result.cross_time.verdict}). ` +
                    `An identifier that drifts detaches dispute history silently.`,
            });
            continue;
        }

        if (!collisionFree) {
            rejected.push({
                identifier,
                reason: `${result.collisions.length} collision(s): the same value appears on ` +
                    `different accounts. A wrong key attaches one account's history to another.`,
            });
            continue;
        }

        if (!covered) {
            rejected.push({
                identifier,
                reason: `Coverage only ${result.coverage.percent}%. Too sparse to rely on; ` +
                    `would fall through to the cascade for most items anyway.`,
            });
            continue;
        }

        proposed.push({
            identifier,
            groups_bureaus: result.cross_bureau.verdict.startsWith("GROUPS"),
            coverage_percent: result.coverage.percent,
            note: result.cross_bureau.verdict.startsWith("GROUPS")
                ? "Stable AND groups the stacked bureau records. Strongest possible evidence tier."
                : "Stable, but PER-BUREAU: it identifies a bureau observation, not the tradeline. " +
                  "Usable as evidence only once bureau records are already grouped by other means.",
        });
    }

    // Strongest first: grouping identifiers before per-bureau ones.
    proposed.sort((a, b) => Number(b.groups_bureaus) - Number(a.groups_bureaus));

    return {
        proposed_tiers: proposed.map((p, i) => ({ tier: `T0.${i + 1}`, ...p })),
        rejected,
        reminder:
            "PROPOSAL ONLY. The frozen cascade is unchanged. Business Trappers continues to mint " +
            "and persist its own UUID stable_item_key; vendor identifiers are evidence within the " +
            "cascade and never the permanent key.",
    };
}
