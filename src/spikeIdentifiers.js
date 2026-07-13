/**
 * spikeIdentifiers.js
 *
 * IDENTIFIER COMPARISON SPIKE — analysis engine.
 *
 * PURE. No browser. No Playwright. Fully unit-testable.
 *
 * ---------------------------------------------------------------------------
 * TWO IDENTITIES. THIS IS THE WHOLE POINT OF THIS FILE.
 *
 *   UNDERLYING FINANCIAL ACCOUNT — the real-world account (one Chase Visa).
 *       Exists for CONTEXT, HISTORY, and CROSS-BUREAU COMPARISON.
 *       It is NOT the legal unit of dispute.
 *
 *   BUREAU TRADELINE — one bureau's reporting of that account.
 *       THIS is the legal unit of work. Disputes, strategies, and letters are
 *       generated separately for each bureau.
 *
 *   Underlying Financial Account
 *       |-- TransUnion Tradeline    CHASE BANK USA NA    ****6095
 *       |-- Experian Tradeline      JPMCB CARD SERVICES  6095XXXXXXXX
 *       +-- Equifax Tradeline       CHASE                XXXX6095
 *
 * THE FURNISHER NAME IS NOT IDENTITY EVIDENCE ACROSS BUREAUS.
 *
 * An earlier version of this analyzer keyed accounts on
 * normalized_creditor + last4 + opened_ym. That was WRONG, and wrong in the
 * most dangerous possible direction:
 *
 *   - "NAVY FEDERAL CR UNION | 6095" and "NAVY FCU | 6095" produced DIFFERENT
 *     keys, so ONE account looked like SEVERAL.
 *   - Cross-bureau GROUPING therefore became undetectable.
 *   - Worse: an identifier that CORRECTLY groups all three bureaus was seen as
 *     one value spanning several "different accounts" -> flagged as a COLLISION
 *     -> REJECTED.
 *
 *   The better an identifier was at its job, the more likely it was to be
 *   thrown out. ArrayAccountIdentifier -- the one we most expect to be correct
 *   -- was the most likely casualty.
 *
 * Accounts are therefore CLUSTERED on evidence that does not vary by bureau
 * (masked account trailing digits, opened month), never on furnisher strings.
 * ---------------------------------------------------------------------------
 *
 * FROZEN RULING (unchanged by any result this spike produces):
 *   - Business Trappers mints and persists its own UUID keys.
 *   - No Array.io or MISMO identifier ever becomes a permanent key.
 *   - Vendor identifiers are EVIDENCE within the matching cascade. Nothing more.
 *   - TradelineHashComplex is captured for change detection and NEVER identity.
 *
 * This spike PROPOSES tiers. It does not confer identity.
 */

export const IDENTIFIERS = [
    "ArrayAccountIdentifier",
    "TradelineHashSimple",
    "TradelineHashComplex",
    "CreditLiabilityID",
];

export const NEVER_AN_IDENTITY_KEY = ["TradelineHashComplex"];

// ---------------------------------------------------------------------------
// Defensive field extraction (MISMO decorates keys with @ and _ prefixes)
// ---------------------------------------------------------------------------

const CREDITOR_KEYS = /^(_?full_?name|creditor|creditorname|subscribername|_name|name|furnisher)$/i;
const ACCOUNT_KEYS = /account.?(identifier|number)|accountnumber/i;
const ACCOUNT_TYPE_KEYS = /account.?type|liability.?type/i;
const OPENED_KEYS = /account.?opened|opened.?date|dateopened/i;
const BUREAU_KEYS = /repository|bureau|source.?type/i;

const BUREAU_VALUES = {
    transunion: /trans\s*union|transunion|^tu$|tui/i,
    experian: /experian|^exp$/i,
    equifax: /equifax|^eqf?$/i,
};

function bareKey(key) {
    return key.replace(/^[@_]+/, "");
}

/**
 * Is this key one of the vendor identifiers we are EVALUATING?
 *
 * This guard is load-bearing. "@ArrayAccountIdentifier" bare-keys to
 * "ArrayAccountIdentifier", which CONTAINS the substring "AccountIdentifier" --
 * so an unanchored account-number pattern happily matches it and reads the
 * VENDOR IDENTIFIER as the ACCOUNT NUMBER.
 *
 * That is circular in the worst way: the evidence used to cluster accounts
 * would be derived from the identifier whose clustering behaviour we are trying
 * to measure. The analyzer would then "prove" the identifier groups accounts
 * correctly -- because it had grouped them BY that identifier.
 *
 * Validation evidence must be independent of the thing under test.
 */
function isIdentifierKey(key) {
    const bare = bareKey(key).toLowerCase();
    return IDENTIFIERS.some((id) => id.toLowerCase() === bare);
}

function normalizeBureau(value) {
    if (typeof value !== "string") return null;

    for (const [bureau, pattern] of Object.entries(BUREAU_VALUES)) {
        if (pattern.test(value)) return bureau;
    }

    return null;
}

function findField(obj, pattern, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 4) return null;

    for (const [key, value] of Object.entries(obj)) {
        if (isIdentifierKey(key)) continue; // never source evidence from the thing under test

        if (pattern.test(bareKey(key)) && (typeof value === "string" || typeof value === "number")) {
            return String(value);
        }
    }

    for (const value of Object.values(obj)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const found = findField(value, pattern, depth + 1);
            if (found) return found;
        }
    }

    return null;
}

function normalizeCreditor(name) {
    if (!name) return null;

    const cleaned = String(name)
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .replace(/\b(NA|INC|LLC|CORP|CO|THE|BANK|USA|CARD|SERVICES)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return cleaned || null;
}

function last4(accountNumber) {
    if (!accountNumber) return null;

    const digits = String(accountNumber).replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(-4) : null;
}

function openedYearMonth(date) {
    if (!date) return null;

    const iso = String(date).match(/(\d{4})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}`;

    const us = String(date).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) return `${us[3]}-${String(us[1]).padStart(2, "0")}`;

    return null;
}

/**
 * Extract every BUREAU TRADELINE record from an Array.io / MISMO payload.
 *
 * Each record is ONE BUREAU'S reporting of an account -- the legal unit of
 * dispute. Records are NOT merged here. Grouping into underlying accounts is a
 * separate step (clusterIntoAccounts), and it never flattens.
 */
export function extractTradelineRecords(json) {
    const records = [];

    const walk = (node, inheritedBureau) => {
        if (!node || typeof node !== "object") return;

        if (Array.isArray(node)) {
            for (const item of node) walk(item, inheritedBureau);
            return;
        }

        let bureau = inheritedBureau;

        for (const [key, value] of Object.entries(node)) {
            if (BUREAU_KEYS.test(bareKey(key))) {
                const detected = normalizeBureau(String(value));
                if (detected) bureau = detected;
            }
        }

        const hasIdentifier = IDENTIFIERS.some((id) =>
            Object.keys(node).some((k) => bareKey(k).toLowerCase() === id.toLowerCase())
        );

        if (hasIdentifier) {
            const identifiers = {};

            for (const id of IDENTIFIERS) {
                const key = Object.keys(node).find(
                    (k) => bareKey(k).toLowerCase() === id.toLowerCase()
                );
                identifiers[id] = key ? String(node[key]) : null;
            }

            const creditor = findField(node, CREDITOR_KEYS);
            const accountNumber = findField(node, ACCOUNT_KEYS);
            const openedDate = findField(node, OPENED_KEYS);
            const accountType = findField(node, ACCOUNT_TYPE_KEYS);

            records.push({
                bureau: bureau ?? null,
                identifiers,

                validation: {
                    creditor,
                    account_number: accountNumber,
                    account_type: accountType,
                    opened_date: openedDate,
                },

                // Bureau-INVARIANT evidence. This -- NOT the furnisher name --
                // identifies the underlying financial account.
                evidence: {
                    last4: last4(accountNumber),
                    opened_ym: openedYearMonth(openedDate),
                    creditor_norm: normalizeCreditor(creditor),
                    account_type: accountType ? String(accountType).toUpperCase().trim() : null,
                },
            });
        }

        for (const value of Object.values(node)) walk(value, bureau);
    };

    walk(json, null);

    return records;
}

// ---------------------------------------------------------------------------
// Account clustering
// ---------------------------------------------------------------------------

/**
 * Are these two bureau tradelines DEMONSTRABLY different financial accounts?
 *
 * This is the bar the ruling sets for a true collision:
 *
 *   "A true collision means one identifier maps to two demonstrably different
 *    underlying financial accounts. Differences in bureau naming conventions
 *    alone are not sufficient evidence."
 *
 * Differing trailing digits, or differing open months, PROVE difference.
 * A differing furnisher STRING proves nothing -- bureaus are EXPECTED to
 * disagree about the name.
 */
export function demonstrablyDifferentAccounts(a, b) {
    const ea = a.evidence;
    const eb = b.evidence;

    if (ea.last4 && eb.last4 && ea.last4 !== eb.last4) return true;
    if (ea.opened_ym && eb.opened_ym && ea.opened_ym !== eb.opened_ym) return true;

    return false;
}

/**
 * Do these two bureau tradelines report the SAME underlying financial account?
 *
 * Positive evidence required. The furnisher name is corroboration at best, and
 * is NEVER allowed to SPLIT an account that account-number evidence joins.
 */
export function sameAccount(a, b) {
    const ea = a.evidence;
    const eb = b.evidence;

    if (demonstrablyDifferentAccounts(a, b)) return false;

    // Strongest available evidence: trailing digits agree.
    if (ea.last4 && eb.last4 && ea.last4 === eb.last4) return true;

    // Neither side has account-number evidence. Fall back to creditor + opened,
    // used only because nothing better exists.
    if (!ea.last4 && !eb.last4) {
        if (ea.creditor_norm && eb.creditor_norm && ea.opened_ym && eb.opened_ym) {
            const bTokens = eb.creditor_norm.split(" ");

            const sharedToken = ea.creditor_norm
                .split(" ")
                .some((token) => token.length > 2 && bTokens.includes(token));

            return sharedToken && ea.opened_ym === eb.opened_ym;
        }
    }

    return false;
}

/**
 * Cluster bureau tradelines into underlying financial accounts (union-find).
 *
 * Returns Map: account_cluster_label -> [bureau tradeline records]
 *
 * The cluster label is SCAFFOLDING for this spike. It is not a proposed key and
 * never becomes one.
 */
export function clusterIntoAccounts(records) {
    const parent = records.map((_, i) => i);

    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));

    const union = (i, j) => {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[rj] = ri;
    };

    for (let i = 0; i < records.length; i++) {
        for (let j = i + 1; j < records.length; j++) {
            if (sameAccount(records[i], records[j])) union(i, j);
        }
    }

    const roots = new Map();

    records.forEach((record, i) => {
        const root = find(i);

        if (!roots.has(root)) roots.set(root, []);
        roots.get(root).push(record);
    });

    const labelled = new Map();

    for (const group of roots.values()) {
        const anchor = group.find((r) => r.evidence.last4) ?? group[0];

        const label = [
            anchor.evidence.last4 ?? "no4",
            anchor.evidence.opened_ym ?? "nodate",
            anchor.evidence.creditor_norm?.split(" ")[0] ?? "unknown",
        ].join("|");

        let key = label;
        let n = 2;
        while (labelled.has(key)) key = `${label}#${n++}`;

        labelled.set(key, group);
    }

    return labelled;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * @param {Array<{report_date: string, records: Array}>} reports
 */
export function analyzeIdentifiers(reports) {
    const indexed = reports.map((report) => ({
        report_date: report.report_date,
        accounts: clusterIntoAccounts(report.records),
        total_tradelines: report.records.length,
    }));

    // Recommendations are GATED on genuinely distinct report dates.
    //
    // Two captures of the SAME report tell us nothing about cross-time
    // stability: every identifier would trivially "match itself" and look
    // STABLE. That is an artefact, not a finding, and promoting an identifier on
    // it would be the worst kind of false confidence.
    const distinctDates = new Set(reports.map((r) => r.report_date));
    const haveTwoDistinctReports = distinctDates.size >= 2;

    const results = {};

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

        // ---- PROPERTY 1: CROSS-BUREAU CORRELATION -------------------------
        //
        // Within ONE report, do the bureau tradelines of ONE underlying account
        // share this identifier?
        //
        //   GROUPS     -> identifies the ACCOUNT    (correlation, intelligence)
        //   PER-BUREAU -> identifies the TRADELINE  (the legal unit of dispute)
        //
        // NEITHER is "better". They are different jobs. We need both.
        let groups = 0;
        let perBureau = 0;
        let bureauMixed = 0;
        let bureauInconclusive = 0;

        for (const report of indexed) {
            for (const [, tradelines] of report.accounts) {
                const bureaus = new Set(tradelines.map((t) => t.bureau).filter(Boolean));
                if (bureaus.size < 2) continue;

                const values = tradelines.map((t) => t.identifiers?.[identifier]).filter(Boolean);

                if (values.length < 2) {
                    bureauInconclusive++;
                    continue;
                }

                const distinct = new Set(values);

                if (distinct.size === 1) groups++;
                else if (distinct.size === values.length) perBureau++;
                else bureauMixed++;
            }
        }

        // ---- PROPERTY 2: CROSS-TIME STABILITY ------------------------------
        //
        // Compared PER BUREAU TRADELINE, because that is the legal unit and
        // because a per-bureau identifier compared account-wide would look
        // unstable when it is merely per-bureau. The two failures must not be
        // conflated.
        let stable = 0;
        let changed = 0;
        let timeInconclusive = 0;
        const changed_examples = [];

        if (haveTwoDistinctReports && indexed.length >= 2) {
            const [first, second] = indexed;

            for (const [account, firstTradelines] of first.accounts) {
                const secondTradelines = second.accounts.get(account);
                if (!secondTradelines) continue;

                for (const a of firstTradelines) {
                    const b = secondTradelines.find((t) => t.bureau === a.bureau);
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
                                [first.report_date]: va,
                                [second.report_date]: vb,
                            });
                        }
                    }
                }
            }
        }

        // ---- TRUE COLLISIONS ------------------------------------------------
        //
        // Per the ruling: ONE identifier value mapping to TWO DEMONSTRABLY
        // DIFFERENT underlying accounts.
        //
        // An identifier shared across the three bureau tradelines of ONE account
        // is CORRECT GROUPING, not a collision. The previous detector got this
        // backwards and would have rejected the best identifier we have.
        const collisions = [];
        const valueToEntries = new Map();

        for (const report of indexed) {
            for (const [account, tradelines] of report.accounts) {
                for (const record of tradelines) {
                    const value = record.identifiers?.[identifier];
                    if (!value) continue;

                    if (!valueToEntries.has(value)) valueToEntries.set(value, []);
                    valueToEntries.get(value).push({ record, account, report_date: report.report_date });
                }
            }
        }

        for (const [value, entries] of valueToEntries) {
            let proven = false;

            for (let i = 0; i < entries.length && !proven; i++) {
                for (let j = i + 1; j < entries.length && !proven; j++) {
                    if (!demonstrablyDifferentAccounts(entries[i].record, entries[j].record)) continue;

                    const a = entries[i];
                    const b = entries[j];

                    collisions.push({
                        identifier_value: value,
                        account_a: {
                            cluster: a.account,
                            report_date: a.report_date,
                            creditor: a.record.validation.creditor,
                            last4: a.record.evidence.last4,
                            opened_ym: a.record.evidence.opened_ym,
                        },
                        account_b: {
                            cluster: b.account,
                            report_date: b.report_date,
                            creditor: b.record.validation.creditor,
                            last4: b.record.evidence.last4,
                            opened_ym: b.record.evidence.opened_ym,
                        },
                        proof:
                            a.record.evidence.last4 &&
                            b.record.evidence.last4 &&
                            a.record.evidence.last4 !== b.record.evidence.last4
                                ? "different masked account trailing digits"
                                : "different account opened month",
                    });

                    proven = true;
                }
            }
        }

        results[identifier] = {
            coverage: {
                present,
                total,
                percent: total ? Math.round((present / total) * 100) : 0,
                missing: total - present,
            },

            cross_bureau_correlation: {
                accounts_where_identifier_groups_bureaus: groups,
                accounts_where_identifier_is_per_bureau: perBureau,
                mixed: bureauMixed,
                inconclusive: bureauInconclusive,
                verdict:
                    groups > 0 && perBureau === 0 && bureauMixed === 0
                        ? "GROUPS - one value shared by all bureau tradelines of an account. Identifies the ACCOUNT."
                        : perBureau > 0 && groups === 0 && bureauMixed === 0
                            ? "PER-BUREAU - a distinct value per bureau tradeline. Identifies the TRADELINE (the legal unit of dispute)."
                            : groups === 0 && perBureau === 0
                                ? "INCONCLUSIVE - no account observed at 2+ bureaus carrying this identifier."
                                : "MIXED - behaves inconsistently. Not trustworthy.",
            },

            cross_time_stability: {
                measured_at: "bureau_tradeline",
                stable,
                changed,
                inconclusive: timeInconclusive,
                changed_examples,
                verdict: !haveTwoDistinctReports
                    ? "NOT EVALUATED - two genuinely distinct report dates are required."
                    : stable > 0 && changed === 0
                        ? "STABLE - unchanged across report dates"
                        : changed > 0 && stable === 0
                            ? "REGENERATED - changes on every report. Useless for identity."
                            : changed > 0
                                ? "PARTIALLY UNSTABLE - changes for some tradelines. Unusable."
                                : "INCONCLUSIVE - no tradeline present in both reports with this identifier",
            },

            collisions,
        };
    }

    return {
        reports: indexed.map((r) => ({
            report_date: r.report_date,
            bureau_tradelines: r.total_tradelines,
            underlying_accounts: r.accounts.size,
        })),

        distinct_report_dates: [...distinctDates],
        two_distinct_reports_captured: haveTwoDistinctReports,

        identifiers: results,

        recommendation: haveTwoDistinctReports
            ? recommendTiers(results)
            : {
                  status: "WITHHELD",
                  reason:
                      "Two genuinely distinct report dates have not been captured and validated. " +
                      "Cross-time stability cannot be evaluated, and no identifier may be promoted " +
                      "or rejected on cross-bureau evidence alone.",
                  distinct_report_dates: [...distinctDates],
              },
    };
}

/**
 * PROPOSE matching tiers. The frozen cascade is not changed by this spike.
 *
 * Two SEPARATE tier lists, because there are two identities:
 *
 *   account_grouping_tiers   - correlate bureau tradelines into one account
 *   tradeline_identity_tiers - match a bureau tradeline across report dates
 */
export function recommendTiers(results) {
    const account_grouping_tiers = [];
    const tradeline_identity_tiers = [];
    const rejected = [];

    for (const [identifier, result] of Object.entries(results)) {
        if (NEVER_AN_IDENTITY_KEY.includes(identifier)) {
            rejected.push({
                identifier,
                reason:
                    "Frozen ruling: captured for change detection only, never used for identity. " +
                    "A content hash that appears stable across two reports is stable by coincidence " +
                    "(nothing changed that month), not by design.",
                use_instead: "change_detection_signal",
            });
            continue;
        }

        const stable = result.cross_time_stability.verdict.startsWith("STABLE");
        const collisionFree = result.collisions.length === 0;
        const covered = result.coverage.percent >= 90;

        if (!stable) {
            rejected.push({
                identifier,
                reason:
                    `Not stable across report dates (${result.cross_time_stability.verdict}). ` +
                    `An identifier that drifts detaches dispute history silently.`,
            });
            continue;
        }

        if (!collisionFree) {
            rejected.push({
                identifier,
                reason:
                    `${result.collisions.length} TRUE collision(s): the same value appears on ` +
                    `demonstrably different underlying accounts (different trailing digits or open ` +
                    `months - not merely different bureau naming).`,
                collisions: result.collisions.slice(0, 3),
            });
            continue;
        }

        if (!covered) {
            rejected.push({
                identifier,
                reason: `Coverage only ${result.coverage.percent}%. Too sparse to rely on.`,
            });
            continue;
        }

        const entry = { identifier, coverage_percent: result.coverage.percent };
        const verdict = result.cross_bureau_correlation.verdict;

        if (verdict.startsWith("GROUPS")) {
            account_grouping_tiers.push({
                ...entry,
                use:
                    "Correlate bureau tradelines into an underlying financial account. " +
                    "For intelligence and cross-bureau comparison only.",
            });
        } else if (verdict.startsWith("PER-BUREAU")) {
            tradeline_identity_tiers.push({
                ...entry,
                use: "Match a BUREAU TRADELINE across report dates - the legal unit of dispute.",
            });
        } else {
            rejected.push({
                identifier,
                reason:
                    `Cross-bureau behaviour is ${verdict} - we cannot tell whether it identifies ` +
                    `the account or the tradeline, so we cannot say what it would be evidence OF.`,
            });
        }
    }

    return {
        status: "PROPOSED",

        account_grouping_tiers: account_grouping_tiers.map((t, i) => ({ tier: `A${i + 1}`, ...t })),
        tradeline_identity_tiers: tradeline_identity_tiers.map((t, i) => ({ tier: `T0.${i + 1}`, ...t })),
        rejected,

        reminder:
            "PROPOSAL ONLY. The frozen cascade is unchanged. Business Trappers continues to mint and " +
            "persist its own UUID keys; vendor identifiers are evidence within the cascade and never " +
            "the permanent identity. ACCOUNT-grouping and TRADELINE-identity are DIFFERENT JOBS - an " +
            "identifier is not 'better' for doing one rather than the other. We need both.",
    };
}
