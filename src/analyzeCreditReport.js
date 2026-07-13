/**
 * analyzeCreditReport.js
 *
 * THE ANALYSIS ENGINE (Milestone 7).
 *
 *   Capture -> Normalize -> [ANALYZE FACTS] -> Decision -> Strategy -> Reason
 *           -> Instruction -> Letter Blueprint -> Letter Generation
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE DISCOVERS FACTS. IT DECIDES NOTHING.
 *
 *   It does NOT select strategies, laws, reasons, or instructions.
 *   It does NOT generate letters.
 *   It does NOT call GPT, a browser, a database, or the network.
 *
 *   It is PURE and DETERMINISTIC: the same report in, byte-identical findings
 *   out, forever. Downstream engines must be able to re-run analysis and get
 *   the same answer, or dispute history becomes irreproducible.
 *
 *   `async` is retained in the signature per the milestone contract, so the
 *   interface does not have to change later if a detector ever needs to await
 *   something. Nothing in here awaits anything today.
 *
 * ---------------------------------------------------------------------------
 * THE IDENTITY CONTRACT (Extraction System v1.1, Decision 5)
 *
 *   Every ITEM-level finding carries BOTH keys:
 *
 *     stable_item_key    -> THE BUREAU TRADELINE. The legal unit of dispute.
 *                           Findings attach HERE.
 *     stable_account_key -> the underlying financial account. Carried for
 *                           cross-bureau intelligence and context.
 *
 *   CROSS-BUREAU FINDINGS ARE DETECTED AT THE ACCOUNT LEVEL AND EMITTED PER
 *   BUREAU TRADELINE. They are never flattened into one account-level finding.
 *
 *   This matters concretely: a dispute is filed WITH A BUREAU, ABOUT THAT
 *   BUREAU'S REPORTING. A finding that says only "the three bureaus disagree"
 *   cannot be turned into a letter to anyone. So when TransUnion says
 *   "Charge-off" and Experian says "Current", BOTH bureau tradelines receive a
 *   finding, each describing what THAT bureau reports and how it differs.
 * ---------------------------------------------------------------------------
 */

import { FINDING_CODES, SEVERITY, SEVERITY_RANK, LEVEL, REQUIRES, getCode } from "./findingCodes.js";

export const ANALYSIS_SCHEMA_VERSION = "BT-INTEL-1.0";

// Tolerances. Named, not scattered as magic numbers.
const BALANCE_TOLERANCE_DOLLARS = 50; // bureaus report on different cycle dates
const DUPLICATE_INQUIRY_WINDOW_DAYS = 30;
const DEROGATORY_REPORTING_YEARS = 7;
const INQUIRY_REPORTING_YEARS = 2;

const DEROGATORY_STATUS = /charge.?off|collection|repossession|foreclosure|settled|default|written.?off/i;
const ACTIVE_STATUS = /^(open|current|pays as agreed|paid as agreed)$/i;
const CLOSED_STATUS = /closed|paid|transferred/i;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;

    const n = Number(String(value).replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : null;
}

function toDate(value) {
    if (!value) return null;

    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function yearsBetween(from, to) {
    return (to.getTime() - from.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

function daysBetween(a, b) {
    return Math.abs(a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000);
}

function normalizeStatus(status) {
    return status ? String(status).trim().toUpperCase() : null;
}

function isDerogatory(status) {
    return !!status && DEROGATORY_STATUS.test(String(status));
}

function distinct(values) {
    return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ""))];
}

/**
 * Build a finding. Severity and level come from the frozen registry — a
 * detector may not invent its own, or severity stops meaning anything.
 */
function finding(code, explanation, evidence = null) {
    const spec = getCode(code);

    const result = {
        code,
        severity: spec.severity,
        level: spec.level,
        explanation,
    };

    if (evidence) result.evidence = evidence;

    return result;
}

// ---------------------------------------------------------------------------
// Detectors: single bureau tradeline, internal consistency (Metro 2)
//
// The record contradicts ITSELF. No external reference is needed, so these are
// the strongest facts obtainable from one report.
// ---------------------------------------------------------------------------

function detectInternalInconsistencies(tradeline, asOf) {
    const findings = [];
    const obs = tradeline.observation ?? {};

    const balance = toNumber(obs.balance);
    const pastDue = toNumber(obs.past_due);
    const status = normalizeStatus(obs.status);
    const dofd = toDate(obs.date_of_first_delinquency);
    const opened = toDate(obs.date_opened);

    if (pastDue !== null && pastDue > 0 && balance === 0) {
        findings.push(
            finding(
                "TL_PAST_DUE_ON_ZERO_BALANCE",
                `A past-due amount of ${pastDue} is reported while the balance is 0.`,
                { balance, past_due: pastDue }
            )
        );
    }

    if (pastDue !== null && balance !== null && balance > 0 && pastDue > balance) {
        findings.push(
            finding(
                "TL_PAST_DUE_EXCEEDS_BALANCE",
                `The past-due amount (${pastDue}) exceeds the reported balance (${balance}).`,
                { balance, past_due: pastDue }
            )
        );
    }

    if (isDerogatory(status) && !dofd) {
        findings.push(
            finding(
                "TL_DEROGATORY_WITHOUT_DOFD",
                `Status "${obs.status}" is derogatory, but no Date of First Delinquency is reported. ` +
                    `Without a DOFD the lawful reporting period cannot be computed.`,
                { status: obs.status, date_of_first_delinquency: null }
            )
        );
    }

    if (dofd && opened && dofd < opened) {
        findings.push(
            finding(
                "TL_DOFD_BEFORE_OPENED",
                `The Date of First Delinquency (${obs.date_of_first_delinquency}) precedes the ` +
                    `account opened date (${obs.date_opened}). An account cannot go delinquent ` +
                    `before it exists.`,
                { date_of_first_delinquency: obs.date_of_first_delinquency, date_opened: obs.date_opened }
            )
        );
    }

    if (dofd) {
        const age = yearsBetween(dofd, asOf);

        if (age > DEROGATORY_REPORTING_YEARS) {
            findings.push(
                finding(
                    "TL_BEYOND_REPORTING_PERIOD",
                    `The Date of First Delinquency (${obs.date_of_first_delinquency}) is ` +
                        `${age.toFixed(1)} years old, which exceeds the ${DEROGATORY_REPORTING_YEARS}-year ` +
                        `reporting period, yet the item is still reported.`,
                    { date_of_first_delinquency: obs.date_of_first_delinquency, age_years: Number(age.toFixed(2)) }
                )
            );
        }
    }

    if (status && CLOSED_STATUS.test(status) && ACTIVE_STATUS.test(status)) {
        findings.push(
            finding(
                "TL_CLOSED_WITH_ACTIVE_STATUS",
                `The account is reported both closed and active: "${obs.status}".`,
                { status: obs.status }
            )
        );
    }

    // Status says current, but the account's own payment grid shows a recent late.
    const history = Array.isArray(obs.payment_history) ? obs.payment_history : [];
    const hasRecentLate = history.slice(0, 6).some((h) => h && /30|60|90|120|150|180/.test(String(h)));

    if (status && ACTIVE_STATUS.test(status) && hasRecentLate) {
        findings.push(
            finding(
                "TL_STATUS_CONFLICTS_WITH_PAYMENT_HISTORY",
                `Status is reported as "${obs.status}", but this account's own payment history ` +
                    `shows a late payment within the last six reporting periods.`,
                { status: obs.status, recent_history: history.slice(0, 6) }
            )
        );
    }

    return findings;
}

// ---------------------------------------------------------------------------
// Detectors: cross-bureau
//
// Detected across the bureau tradelines of ONE account. EMITTED PER TRADELINE.
// Returns Map<stable_item_key, finding[]> — never one account-level blob.
// ---------------------------------------------------------------------------

function detectCrossBureauInconsistencies(account) {
    const byItem = new Map();
    const tradelines = account.bureau_tradelines ?? [];

    if (tradelines.length < 2) return byItem;

    const push = (tradeline, f) => {
        if (!byItem.has(tradeline.stable_item_key)) byItem.set(tradeline.stable_item_key, []);
        byItem.get(tradeline.stable_item_key).push(f);
    };

    const compare = (code, extract, describe, differs) => {
        const values = tradelines.map((t) => ({ tradeline: t, value: extract(t) }));
        const reported = values.filter((v) => v.value !== null && v.value !== undefined);

        if (reported.length < 2) return;
        if (!differs(reported.map((r) => r.value))) return;

        // Every bureau that reports the field gets its own finding, describing
        // ITS value and how the others differ. This is what makes the finding
        // usable in a letter to that specific bureau.
        for (const { tradeline, value } of reported) {
            const others = reported
                .filter((r) => r.tradeline.stable_item_key !== tradeline.stable_item_key)
                .map((r) => `${r.tradeline.bureau}: ${describe(r.value)}`);

            push(
                tradeline,
                finding(code, `${tradeline.bureau} reports ${describe(value)}. Other bureaus report — ${others.join("; ")}.`, {
                    this_bureau: { bureau: tradeline.bureau, value: describe(value) },
                    other_bureaus: reported
                        .filter((r) => r.tradeline.stable_item_key !== tradeline.stable_item_key)
                        .map((r) => ({ bureau: r.tradeline.bureau, value: describe(r.value) })),
                })
            );
        }
    };

    compare(
        "TL_XB_STATUS_INCONSISTENT",
        (t) => normalizeStatus(t.observation?.status),
        (v) => `"${v}"`,
        (vals) => distinct(vals).length > 1
    );

    compare(
        "TL_XB_BALANCE_INCONSISTENT",
        (t) => toNumber(t.observation?.balance),
        (v) => `a balance of ${v}`,
        (vals) => Math.max(...vals) - Math.min(...vals) > BALANCE_TOLERANCE_DOLLARS
    );

    compare(
        "TL_XB_PAST_DUE_INCONSISTENT",
        (t) => toNumber(t.observation?.past_due),
        (v) => `past due of ${v}`,
        (vals) => Math.max(...vals) - Math.min(...vals) > BALANCE_TOLERANCE_DOLLARS
    );

    // DOFD drives the lawful reporting period. If bureaus disagree, they cannot
    // both be right, and the item's expiry date is in dispute.
    compare(
        "TL_XB_DOFD_INCONSISTENT",
        (t) => t.observation?.date_of_first_delinquency ?? null,
        (v) => `a DOFD of ${v}`,
        (vals) => distinct(vals).length > 1
    );

    // Bureaus routinely disagree by days; only a different MONTH is material.
    compare(
        "TL_XB_OPENED_DATE_INCONSISTENT",
        (t) => {
            const d = toDate(t.observation?.date_opened);
            return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : null;
        },
        (v) => `an opened date of ${v}`,
        (vals) => distinct(vals).length > 1
    );

    return byItem;
}

// ---------------------------------------------------------------------------
// Detectors: history-dependent (require the previous report)
//
// RE-AGING LIVES HERE, AND ONLY HERE. It is a DOFD moving LATER over time. It
// is invisible in a single snapshot. An analyzer that claimed to find re-aging
// in one report would be guessing.
// ---------------------------------------------------------------------------

function indexPreviousTradelines(previousReport) {
    const index = new Map();

    if (!previousReport) return index;

    const groups = [
        ...(previousReport.accounts ?? []),
        ...(previousReport.collections ?? []),
        ...(previousReport.public_records ?? []),
    ];

    for (const account of groups) {
        for (const tradeline of account.bureau_tradelines ?? []) {
            index.set(tradeline.stable_item_key, tradeline);
        }
    }

    return index;
}

function detectHistoricalFindings(tradeline, previousIndex) {
    const findings = [];
    const previous = previousIndex.get(tradeline.stable_item_key);

    if (!previous) return findings;

    const now = tradeline.observation ?? {};
    const before = previous.observation ?? {};

    const dofdNow = toDate(now.date_of_first_delinquency);
    const dofdBefore = toDate(before.date_of_first_delinquency);

    // RE-AGING. The DOFD moved LATER, which pushes back the date the item must
    // fall off. Moving it EARLIER is not re-aging — it shortens the reporting
    // period and works in the consumer's favour, so it is not flagged here.
    if (dofdNow && dofdBefore && dofdNow > dofdBefore) {
        findings.push(
            finding(
                "HIST_RE_AGING_INDICATOR",
                `The Date of First Delinquency moved LATER, from ${before.date_of_first_delinquency} ` +
                    `to ${now.date_of_first_delinquency}. A DOFD is a historical fact and cannot change. ` +
                    `Moving it later extends how long this item may lawfully be reported.`,
                {
                    previous_dofd: before.date_of_first_delinquency,
                    current_dofd: now.date_of_first_delinquency,
                    days_moved: Math.round(daysBetween(dofdBefore, dofdNow)),
                }
            )
        );
    }

    const openedNow = toDate(now.date_opened);
    const openedBefore = toDate(before.date_opened);

    if (openedNow && openedBefore && openedNow.getTime() !== openedBefore.getTime()) {
        findings.push(
            finding(
                "HIST_OPENED_DATE_CHANGED",
                `The account opened date changed from ${before.date_opened} to ${now.date_opened}. ` +
                    `An opened date is a historical fact and cannot change.`,
                { previous: before.date_opened, current: now.date_opened }
            )
        );
    }

    const statusNow = normalizeStatus(now.status);
    const statusBefore = normalizeStatus(before.status);

    if (statusNow && statusBefore && statusNow !== statusBefore) {
        findings.push(
            finding(
                "HIST_STATUS_CHANGED",
                `Status changed from "${before.status}" to "${now.status}" since the previous report.`,
                { previous: before.status, current: now.status }
            )
        );
    }

    const balNow = toNumber(now.balance);
    const balBefore = toNumber(before.balance);

    if (isDerogatory(statusNow) && balNow !== null && balBefore !== null && balNow > balBefore) {
        findings.push(
            finding(
                "HIST_BALANCE_INCREASED_ON_CHARGED_OFF",
                `The balance on a charged-off account increased from ${balBefore} to ${balNow}. ` +
                    `A charged-off balance should not grow.`,
                { previous: balBefore, current: balNow }
            )
        );
    }

    return findings;
}

// ---------------------------------------------------------------------------
// Detectors: personal information (report level)
// ---------------------------------------------------------------------------

function normalizeName(name) {
    return String(name).toUpperCase().replace(/[^A-Z ]/g, "").replace(/\s+/g, " ").trim();
}

function detectPersonalInformationFindings(report, clientIdentity) {
    const findings = [];
    const pi = report.reported_personal_information ?? {};

    const ssns = distinct(pi.ssns ?? []);
    const dobs = distinct(pi.dates_of_birth ?? []);
    const names = distinct((pi.names ?? []).map(normalizeName));
    const employers = pi.employers_by_bureau ?? {};

    if (ssns.length > 1) {
        findings.push(
            finding("PI_MULTIPLE_SSN", `${ssns.length} distinct SSNs appear on this report.`, { count: ssns.length })
        );
    }

    if (dobs.length > 1) {
        findings.push(
            finding("PI_MULTIPLE_DOB", `${dobs.length} distinct dates of birth appear on this report.`, {
                count: dobs.length,
                values: dobs,
            })
        );
    }

    // A single file carrying two SSNs or two DOBs is the classic signature of a
    // mixed file: two consumers' data merged into one. It outranks everything
    // else, because if the file is mixed, individual tradeline findings may
    // belong to a different person entirely.
    if (ssns.length > 1 || dobs.length > 1) {
        findings.push(
            finding(
                "PI_MIXED_FILE_INDICATOR",
                `This file carries ${ssns.length} SSN(s) and ${dobs.length} date(s) of birth. ` +
                    `More than one identity anchor on a single file is consistent with two consumers' ` +
                    `records having been merged.`,
                { ssn_count: ssns.length, dob_count: dobs.length }
            )
        );
    }

    if (names.length > 2) {
        findings.push(
            finding("PI_NAME_VARIANTS", `${names.length} name variants are reported.`, { count: names.length, values: names })
        );
    }

    const employerValues = distinct(Object.values(employers));

    if (employerValues.length > 1) {
        findings.push(
            finding("PI_EMPLOYER_INCONSISTENT_ACROSS_BUREAUS", `Bureaus report different employers.`, {
                by_bureau: employers,
            })
        );
    }

    // Comparisons against the identity of record. CRC is authoritative for
    // identity (Extraction Decision 3) — the report is evidence, never identity.
    // Without CRC identity we CANNOT say a name is "incorrect", only that
    // variants exist.
    if (clientIdentity) {
        if (clientIdentity.name && names.length && !names.includes(normalizeName(clientIdentity.name))) {
            findings.push(
                finding("PI_NAME_MISMATCH_VS_CRC", `No reported name matches the identity of record.`, {
                    identity_of_record: clientIdentity.name,
                    reported: names,
                })
            );
        }

        if (clientIdentity.date_of_birth && dobs.length && !dobs.includes(clientIdentity.date_of_birth)) {
            findings.push(
                finding("PI_DOB_MISMATCH_VS_CRC", `No reported date of birth matches the identity of record.`, {
                    identity_of_record: clientIdentity.date_of_birth,
                    reported: dobs,
                })
            );
        }

        if (clientIdentity.ssn && ssns.length && !ssns.includes(clientIdentity.ssn)) {
            findings.push(
                finding("PI_SSN_MISMATCH_VS_CRC", `No reported SSN matches the identity of record.`, {
                    reported_count: ssns.length,
                })
            );
        }
    }

    return findings;
}

// ---------------------------------------------------------------------------
// Detectors: duplicates, collections, inquiries, public records
// ---------------------------------------------------------------------------

function detectDuplicatesWithinBureau(accounts) {
    const byItem = new Map();
    const seen = new Map(); // "bureau|last4|opened_ym" -> [tradeline]

    for (const account of accounts) {
        for (const tradeline of account.bureau_tradelines ?? []) {
            const last4 = tradeline.masked_account
                ? String(tradeline.masked_account).replace(/\D/g, "").slice(-4)
                : null;

            const opened = toDate(tradeline.observation?.date_opened);
            const openedYm = opened ? `${opened.getUTCFullYear()}-${opened.getUTCMonth() + 1}` : null;

            if (!last4 || !openedYm) continue; // not enough evidence to claim a duplicate

            const key = `${tradeline.bureau}|${last4}|${openedYm}`;

            if (!seen.has(key)) seen.set(key, []);
            seen.get(key).push(tradeline);
        }
    }

    for (const [key, group] of seen) {
        if (group.length < 2) continue;

        for (const tradeline of group) {
            byItem.set(tradeline.stable_item_key, [
                finding(
                    "TL_DUPLICATE_WITHIN_BUREAU",
                    `${tradeline.bureau} reports this account ${group.length} times. The same account ` +
                        `should appear once per bureau.`,
                    { occurrences: group.length, signature: key }
                ),
            ]);
        }
    }

    return byItem;
}

function detectAccountLevelFindings(account) {
    const findings = [];
    const reporting = (account.bureau_tradelines ?? []).map((t) => t.bureau);
    const all = ["transunion", "experian", "equifax"];
    const missing = all.filter((b) => !reporting.includes(b));

    // Only meaningful if SOMEONE reports it. Absence everywhere is not a finding.
    if (reporting.length > 0 && missing.length > 0) {
        findings.push(
            finding(
                "ACCT_NOT_REPORTED_BY_BUREAU",
                `This account is reported by ${reporting.join(", ")} but not by ${missing.join(", ")}. ` +
                    `Absence is meaningful data, not missing data.`,
                { reported_by: reporting, not_reported_by: missing }
            )
        );
    }

    return findings;
}

function detectCollectionFindings(report) {
    const byItem = new Map();
    const collections = report.collections ?? [];
    const accounts = report.accounts ?? [];

    const push = (tradeline, f) => {
        if (!byItem.has(tradeline.stable_item_key)) byItem.set(tradeline.stable_item_key, []);
        byItem.get(tradeline.stable_item_key).push(f);
    };

    for (const collection of collections) {
        for (const tradeline of collection.bureau_tradelines ?? []) {
            if (!collection.original_creditor) {
                push(
                    tradeline,
                    finding(
                        "COL_MISSING_ORIGINAL_CREDITOR",
                        `${tradeline.bureau} reports this collection with no original creditor identified.`,
                        { collection_agency: tradeline.furnisher }
                    )
                );
            }

            // The same debt reported as BOTH a charged-off tradeline AND a
            // collection. Whether it is truly one debt is an INTELLIGENCE
            // question; we report only the observable coincidence.
            const balance = toNumber(tradeline.observation?.balance);

            if (collection.original_creditor && balance !== null && balance > 0) {
                for (const account of accounts) {
                    for (const accountTradeline of account.bureau_tradelines ?? []) {
                        if (accountTradeline.bureau !== tradeline.bureau) continue;
                        if (!isDerogatory(accountTradeline.observation?.status)) continue;

                        const accountBalance = toNumber(accountTradeline.observation?.balance);
                        const sameFurnisher =
                            normalizeName(accountTradeline.furnisher ?? "") ===
                            normalizeName(collection.original_creditor);

                        if (
                            sameFurnisher &&
                            accountBalance !== null &&
                            Math.abs(accountBalance - balance) <= BALANCE_TOLERANCE_DOLLARS
                        ) {
                            push(
                                tradeline,
                                finding(
                                    "COL_POSSIBLE_DUPLICATE_OF_TRADELINE",
                                    `${tradeline.bureau} reports this collection (original creditor ` +
                                        `"${collection.original_creditor}", balance ${balance}) alongside a ` +
                                        `charged-off tradeline from the same creditor with a matching balance.`,
                                    {
                                        collection_balance: balance,
                                        tradeline_balance: accountBalance,
                                        tradeline_item_key: accountTradeline.stable_item_key,
                                    }
                                )
                            );
                        }
                    }
                }
            }
        }
    }

    // Two DIFFERENT agencies collecting the same original creditor + balance.
    const byDebt = new Map();

    for (const collection of collections) {
        if (!collection.original_creditor) continue;

        for (const tradeline of collection.bureau_tradelines ?? []) {
            const balance = toNumber(tradeline.observation?.balance);
            if (balance === null || balance <= 0) continue;

            const key = `${tradeline.bureau}|${normalizeName(collection.original_creditor)}|${balance}`;

            if (!byDebt.has(key)) byDebt.set(key, []);
            byDebt.get(key).push({ collection, tradeline });
        }
    }

    for (const [, group] of byDebt) {
        const agencies = distinct(group.map((g) => normalizeName(g.tradeline.furnisher ?? "")));
        if (agencies.length < 2) continue;

        for (const { tradeline } of group) {
            push(
                tradeline,
                finding(
                    "COL_DUPLICATE_COLLECTION",
                    `${agencies.length} different collection agencies report the same original creditor ` +
                        `and balance at ${tradeline.bureau}.`,
                    { agencies }
                )
            );
        }
    }

    return byItem;
}

function detectInquiryFindings(report, asOf) {
    const results = [];
    const inquiries = report.inquiries ?? [];

    const byFurnisherBureau = new Map();

    for (const inquiry of inquiries) {
        const key = `${inquiry.bureau}|${normalizeName(inquiry.furnisher ?? "")}`;

        if (!byFurnisherBureau.has(key)) byFurnisherBureau.set(key, []);
        byFurnisherBureau.get(key).push(inquiry);
    }

    for (const inquiry of inquiries) {
        const findings = [];
        const date = toDate(inquiry.inquiry_date);

        if (date) {
            const age = yearsBetween(date, asOf);

            if (age > INQUIRY_REPORTING_YEARS) {
                findings.push(
                    finding(
                        "INQ_BEYOND_REPORTING_PERIOD",
                        `This inquiry is ${age.toFixed(1)} years old, exceeding the ` +
                            `${INQUIRY_REPORTING_YEARS}-year reporting period, yet it is still reported.`,
                        { inquiry_date: inquiry.inquiry_date, age_years: Number(age.toFixed(2)) }
                    )
                );
            }
        }

        const siblings = byFurnisherBureau.get(`${inquiry.bureau}|${normalizeName(inquiry.furnisher ?? "")}`) ?? [];

        const duplicates = siblings.filter((other) => {
            if (other === inquiry) return false;

            const a = toDate(inquiry.inquiry_date);
            const b = toDate(other.inquiry_date);

            return a && b && daysBetween(a, b) <= DUPLICATE_INQUIRY_WINDOW_DAYS;
        });

        if (duplicates.length > 0) {
            findings.push(
                finding(
                    "INQ_DUPLICATE",
                    `${inquiry.furnisher} made ${duplicates.length + 1} inquiries at ${inquiry.bureau} ` +
                        `within ${DUPLICATE_INQUIRY_WINDOW_DAYS} days.`,
                    { occurrences: duplicates.length + 1 }
                )
            );
        }

        // WE DO NOT ASSERT THAT AN INQUIRY WAS UNAUTHORIZED.
        //
        // Authorization is a fact about what the CONSUMER permitted. It is not
        // in the credit report and cannot be derived from it. This finding
        // states what we do NOT know, and routes the question to the consumer.
        findings.push(
            finding(
                "INQ_AUTHORIZATION_UNVERIFIABLE",
                `Whether ${inquiry.furnisher} was authorized to pull this report cannot be determined ` +
                    `from the credit report. It requires confirmation from the consumer.`,
                { furnisher: inquiry.furnisher, inquiry_date: inquiry.inquiry_date }
            )
        );

        results.push({
            stableItemKey: inquiry.stable_item_key,
            stableAccountKey: null, // an inquiry exists at ONE bureau; there is no account to correlate
            bureau: inquiry.bureau,
            furnisher: inquiry.furnisher ?? null,
            findings: sortFindings(findings),
        });
    }

    return results;
}

function detectPublicRecordFindings(report, asOf) {
    const results = [];

    for (const record of report.public_records ?? []) {
        const crossBureau = detectCrossBureauInconsistencies({
            bureau_tradelines: record.bureau_tradelines ?? [],
        });

        for (const tradeline of record.bureau_tradelines ?? []) {
            const findings = [];
            const obs = tradeline.observation ?? {};
            const filed = toDate(obs.filing_date ?? obs.date_filed);

            if (!filed) {
                findings.push(
                    finding("PR_MISSING_FILING_DATE", `${tradeline.bureau} reports this public record with no filing date.`, {
                        record_type: record.record_type,
                    })
                );
            } else {
                const age = yearsBetween(filed, asOf);

                if (age > DEROGATORY_REPORTING_YEARS) {
                    findings.push(
                        finding(
                            "PR_BEYOND_REPORTING_PERIOD",
                            `This public record was filed ${age.toFixed(1)} years ago, exceeding the ` +
                                `${DEROGATORY_REPORTING_YEARS}-year reporting period, yet it is still reported.`,
                            { filing_date: obs.filing_date ?? obs.date_filed, age_years: Number(age.toFixed(2)) }
                        )
                    );
                }
            }

            // Re-code cross-bureau differences under the public-record code.
            const xb = crossBureau.get(tradeline.stable_item_key) ?? [];

            for (const f of xb) {
                findings.push(finding("PR_XB_INCONSISTENT", f.explanation, f.evidence));
            }

            results.push({
                stableItemKey: tradeline.stable_item_key,
                stableAccountKey: record.stable_account_key,
                bureau: tradeline.bureau,
                recordType: record.record_type ?? null,
                findings: sortFindings(findings),
            });
        }
    }

    return results;
}

// ---------------------------------------------------------------------------
// Determinism
//
// Sorting is not cosmetic. Downstream engines and dispute history must be able
// to re-run analysis and get a byte-identical result. Object key iteration
// order is stable in JS, but detector ORDER is not something we want to depend
// on, so every collection is explicitly sorted.
// ---------------------------------------------------------------------------

function sortFindings(findings) {
    return [...findings].sort((a, b) => {
        const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        return rank !== 0 ? rank : a.code.localeCompare(b.code);
    });
}

function sortItems(items) {
    return [...items].sort((a, b) => String(a.stableItemKey).localeCompare(String(b.stableItemKey)));
}

function topSeverity(findings) {
    if (!findings.length) return null;

    return findings.reduce(
        (best, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[best] ? f.severity : best),
        SEVERITY.INFO
    );
}

// ---------------------------------------------------------------------------
// Input validation — fail closed
// ---------------------------------------------------------------------------

function validateReport(report) {
    const errors = [];

    if (!report || typeof report !== "object") {
        errors.push("report is not an object");
        return errors;
    }

    if (report.extraction_ok === false) {
        errors.push(
            "extraction_ok is false. A report the Extraction System does not trust is not analyzed. " +
            "A partially-captured report is indistinguishable from one where tradelines were deleted, " +
            "and analyzing it would produce findings about accounts that were merely not captured."
        );
    }

    for (const collection of ["accounts", "collections", "public_records", "inquiries"]) {
        if (report[collection] !== undefined && !Array.isArray(report[collection])) {
            errors.push(`${collection} must be an array if present`);
        }
    }

    return errors;
}

// ---------------------------------------------------------------------------
// THE ENGINE
// ---------------------------------------------------------------------------

/**
 * Analyze a normalized BT Credit Report Model™ and return factual findings.
 *
 * @param {BTCreditReportModel} report
 * @param {object} [context]
 * @param {BTCreditReportModel|null} [context.previousReport]
 *        Required for re-aging and every other history-dependent finding.
 *        Without it, those detectors do not run and are listed in `notEvaluated`.
 * @param {object|null} [context.clientIdentity]
 *        CRC identity — authoritative per Extraction Decision 3. Required to say
 *        a reported name/DOB/SSN is WRONG rather than merely VARIANT.
 * @param {Date} [context.asOf] Defaults to now. Injectable for deterministic tests.
 *
 * @returns {Promise<object>} structured intelligence. Facts only. No remedies.
 */
export async function analyzeCreditReport(report, context = {}) {

    const { previousReport = null, clientIdentity = null, asOf = new Date() } = context;

    const errors = validateReport(report);

    if (errors.length > 0) {
        return {
            schemaVersion: ANALYSIS_SCHEMA_VERSION,
            analysisOk: false,
            errors,
            clientSummary: {},
            personalInformation: [],
            tradelines: [],
            collections: [],
            inquiries: [],
            publicRecords: [],
            accountFindings: [],
            itemsRequiringReview: [],
            overallPriority: [],
            notEvaluated: [],
            analysisReadyForDecision: false,
        };
    }

    const accounts = report.accounts ?? [];
    const previousIndex = indexPreviousTradelines(previousReport);

    // ---- What we CANNOT evaluate, and why. Explainability by construction. --
    const notEvaluated = [];

    if (!previousReport) {
        notEvaluated.push({
            requires: REQUIRES.PREVIOUS_REPORT,
            reason:
                "No previous BT Credit Report Model was supplied. History-dependent findings cannot be " +
                "evaluated from a single report. RE-AGING IN PARTICULAR IS UNDETECTABLE without a prior " +
                "report — it is defined as a Date of First Delinquency moving later over TIME.",
            codes_not_evaluated: Object.entries(FINDING_CODES)
                .filter(([, spec]) => spec.requires === REQUIRES.PREVIOUS_REPORT)
                .map(([code]) => code)
                .sort(),
        });
    }

    if (!clientIdentity) {
        notEvaluated.push({
            requires: REQUIRES.CLIENT_IDENTITY,
            reason:
                "No CRC identity was supplied. Whether a reported name, date of birth, or SSN is " +
                "INCORRECT cannot be determined from the credit report alone — CRC is authoritative " +
                "for identity (Extraction Decision 3). Variants are still reported.",
            codes_not_evaluated: Object.entries(FINDING_CODES)
                .filter(([, spec]) => spec.requires === REQUIRES.CLIENT_IDENTITY)
                .map(([code]) => code)
                .sort(),
        });
    }

    // ---- Personal information (report level) ------------------------------
    const personalInformation = sortFindings(detectPersonalInformationFindings(report, clientIdentity));

    // ---- Bureau tradelines -------------------------------------------------
    const duplicateFindings = detectDuplicatesWithinBureau(accounts);
    const tradelines = [];
    const accountFindings = [];

    for (const account of accounts) {
        const crossBureau = detectCrossBureauInconsistencies(account);

        for (const tradeline of account.bureau_tradelines ?? []) {
            const findings = [
                ...detectInternalInconsistencies(tradeline, asOf),
                ...(crossBureau.get(tradeline.stable_item_key) ?? []),
                ...(duplicateFindings.get(tradeline.stable_item_key) ?? []),
                ...detectHistoricalFindings(tradeline, previousIndex),
            ];

            tradelines.push({
                stableItemKey: tradeline.stable_item_key,
                stableAccountKey: account.stable_account_key, // context, never the dispute unit
                bureau: tradeline.bureau,
                furnisher: tradeline.furnisher ?? null,
                findings: sortFindings(findings),
            });
        }

        const acctFindings = detectAccountLevelFindings(account);

        if (acctFindings.length > 0) {
            accountFindings.push({
                stableAccountKey: account.stable_account_key,
                findings: sortFindings(acctFindings),
            });
        }
    }

    // ---- Collections -------------------------------------------------------
    const collectionFindings = detectCollectionFindings(report);
    const collections = [];

    for (const collection of report.collections ?? []) {
        const crossBureau = detectCrossBureauInconsistencies(collection);

        for (const tradeline of collection.bureau_tradelines ?? []) {
            const xb = (crossBureau.get(tradeline.stable_item_key) ?? []).map((f) =>
                f.code === "TL_XB_BALANCE_INCONSISTENT"
                    ? finding("COL_XB_BALANCE_INCONSISTENT", f.explanation, f.evidence)
                    : f
            );

            const findings = [
                ...detectInternalInconsistencies(tradeline, asOf),
                ...xb,
                ...(collectionFindings.get(tradeline.stable_item_key) ?? []),
                ...detectHistoricalFindings(tradeline, previousIndex),
            ];

            collections.push({
                stableItemKey: tradeline.stable_item_key,
                stableAccountKey: collection.stable_account_key,
                bureau: tradeline.bureau,
                furnisher: tradeline.furnisher ?? null,
                originalCreditor: collection.original_creditor ?? null,
                findings: sortFindings(findings),
            });
        }
    }

    // ---- Inquiries and public records --------------------------------------
    const inquiries = sortItems(detectInquiryFindings(report, asOf));
    const publicRecords = sortItems(detectPublicRecordFindings(report, asOf));

    // ---- Summary -----------------------------------------------------------
    const allItems = [...tradelines, ...collections, ...inquiries, ...publicRecords];
    const allFindings = [
        ...personalInformation,
        ...allItems.flatMap((i) => i.findings),
        ...accountFindings.flatMap((a) => a.findings),
    ];

    const bySeverity = {};

    for (const level of Object.keys(SEVERITY)) {
        bySeverity[level] = allFindings.filter((f) => f.severity === level).length;
    }

    const clientSummary = {
        crcClientId: report.crc_client_id ?? null,
        reportDate: report.report_date ?? null,
        modelVersion: report.model_version ?? null,
        underlyingAccounts: accounts.length,
        bureauTradelines: tradelines.length,
        collections: collections.length,
        inquiries: inquiries.length,
        publicRecords: publicRecords.length,
        totalFindings: allFindings.length,
        findingsBySeverity: bySeverity,
        comparedAgainstPreviousReport: !!previousReport,
        comparedAgainstClientIdentity: !!clientIdentity,
    };

    // ---- itemsRequiringReview / overallPriority ------------------------------
    //
    // THESE ARE INDEXES, NOT PLANS.
    //
    // This engine selects no strategy, no law, no reason, and no instruction.
    // What it produces is a PRIORITIZED INDEX of items that carry findings, so
    // the Decision Engine knows where to look without re-discovering facts.
    //
    // "Which items have findings, worst first" is a fact.
    // "What to do about them" is the Decision Engine's job, and this engine
    // deliberately expresses no opinion on it. Nothing here approves an action.
    const itemsWithFindings = sortItems(allItems.filter((i) => i.findings.length > 0));

    const itemsRequiringReview = itemsWithFindings
        .map((item) => ({
            stableItemKey: item.stableItemKey,
            stableAccountKey: item.stableAccountKey,
            bureau: item.bureau,
            topSeverity: topSeverity(item.findings),
            findingCodes: item.findings.map((f) => f.code),
            action: "REVIEW_BY_DECISION_ENGINE", // the ONLY value. No remedy is chosen here.
        }))
        .sort((a, b) => {
            const rank = SEVERITY_RANK[b.topSeverity] - SEVERITY_RANK[a.topSeverity];
            return rank !== 0 ? rank : String(a.stableItemKey).localeCompare(String(b.stableItemKey));
        });

    const overallPriority = itemsRequiringReview.map((a, i) => ({
        rank: i + 1,
        stableItemKey: a.stableItemKey,
        stableAccountKey: a.stableAccountKey,
        bureau: a.bureau,
        topSeverity: a.topSeverity,
    }));

    // ---- analysisReadyForDecision ------------------------------------------
    //
    // A DATA-READINESS FLAG. NOT AN APPROVAL.
    //
    // True means only: "the analysis completed against a trustworthy report and
    // produced findings, so the DECISION ENGINE has something to consume."
    //
    // It does NOT mean a letter should be sent, that any finding is disputable,
    // or that a strategy exists. Those judgements belong to the Decision,
    // Strategy, and Letter engines, and this engine must not pre-empt them.
    const analysisReadyForDecision = allFindings.length > 0;

    return {
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        analysisOk: true,
        errors: [],

        clientSummary,
        personalInformation,
        tradelines: sortItems(tradelines),
        collections: sortItems(collections),
        inquiries,
        publicRecords,
        accountFindings: [...accountFindings].sort((a, b) =>
            String(a.stableAccountKey).localeCompare(String(b.stableAccountKey))
        ),

        itemsRequiringReview,
        overallPriority,
        notEvaluated,

        analysisReadyForDecision,
    };
}
