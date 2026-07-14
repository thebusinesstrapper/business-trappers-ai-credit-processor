/**
 * baselineDispute.js
 *
 * THE BASELINE REINVESTIGATION PATH.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The Analysis Engine detects CONTRADICTIONS. A derogatory tradeline that is
 * internally consistent, consistent across bureaus, and within its reporting
 * period produces NO findings — and therefore, until now, produced NO dispute.
 *
 * That is not how credit repair works. A consumer may dispute the completeness
 * and accuracy of an account under FCRA §611 WITHOUT first proving a defect, and
 * demand that the bureau conduct a reasonable reinvestigation. The bureau must
 * then verify it with the furnisher or delete it.
 *
 * This is the difference between:
 *
 *     "dispute what is provably wrong"        <- what the system did
 *     "dispute what has not been proved right" <- what Business Trappers does
 *
 * ---------------------------------------------------------------------------
 * THE LINE THIS MODULE MUST NOT CROSS
 *
 * Disputing WITHOUT a proven defect is legitimate. ASSERTING a defect we have
 * not proven is not.
 *
 * So the baseline path says exactly this and nothing more:
 *
 *     "I dispute the completeness and accuracy of this account and request a
 *      reasonable reinvestigation. If the information cannot be verified as
 *      complete and accurate, please delete or correct the reporting."
 *
 * Every word of that is true when the processor has found nothing. It states a
 * DISPUTE (which the consumer genuinely has) and REQUESTS an outcome. It does
 * not claim the account is inaccurate, false, or unverifiable — those would be
 * claims about facts we do not possess, made in the consumer's voice.
 *
 * BT-RN-0022 "Cannot Verify" is therefore the REQUESTED INVESTIGATION OUTCOME.
 * It is NOT a finding, and it is NOT a fact the processor has established. The
 * name is a request, not a verdict.
 * ---------------------------------------------------------------------------
 */

import { EVIDENCE_CLASS } from "./decisionRecords.js";

export const BASELINE_SCHEMA_VERSION = "BT-BASELINE-1.0";

/** The Decision Record governing a bare §611 reinvestigation request. */
export const BASELINE_DECISION = Object.freeze({
    record: "BT-DM-0029",
    name: "Baseline Reinvestigation",
    reason: "BT-RN-0022",
    reasonName: "Cannot Verify (requested outcome — NOT a proven fact)",
    strategy: "BT-ST-0001",
    strategyName: "Bureau Investigation",

    // CIRCUMSTANTIAL, deliberately. We have proved NOTHING about this account.
    // The dispute rests on the consumer's right to demand verification, not on
    // evidence of error. Rating it any higher would let an unexamined account
    // automate through on the strength of an assertion nobody made.
    evidenceClass: EVIDENCE_CLASS.CIRCUMSTANTIAL.id,
});

const DEROGATORY_STATUS = /charge.?off|collection|repossession|foreclosure|settled|default|written.?off|late|delinquen|derogatory/i;

/**
 * Is this tradeline genuinely derogatory?
 *
 * A past-due balance counts even when the status word is unrecognised — the
 * money says what the label does not.
 */
export function isDerogatoryTradeline(observation = {}) {
    const pastDue = Number(observation.past_due ?? 0);

    return (
        DEROGATORY_STATUS.test(String(observation.status ?? "")) ||
        (Number.isFinite(pastDue) && pastDue > 0)
    );
}

/**
 * Decide whether a tradeline enters the baseline path.
 *
 * FAILS CLOSED at every gate. A tradeline we are unsure about does not get a
 * dispute manufactured for it.
 *
 * @param {object} ctx
 * @param {object} ctx.tradeline       the bureau tradeline from the report
 * @param {object} ctx.decision        the item's decision (if any) from decideDisputes
 * @param {object} ctx.itemHistory     item-level dispute memory for this stable_item_key
 * @param {boolean} ctx.mixedFile      report-level mixed-file / identity block
 */
export function baselineEligibility(ctx) {
    const { tradeline, decision = null, itemHistory = null, mixedFile = false } = ctx;

    const obs = tradeline.observation ?? {};
    const reasons = [];

    // 1. Genuinely derogatory. We never dispute a positive account — a dispute
    //    can get a BENEFICIAL tradeline deleted.
    if (!isDerogatoryTradeline(obs)) {
        return { eligible: false, reason: "Not a derogatory account. Positive accounts are never disputed." };
    }

    // 2. Authorized user. Constitutional exclusion, absolute.
    if (/authorized\s*user/i.test(String(obs.responsibility ?? ""))) {
        return {
            eligible: false,
            reason: "Authorized-user account. The Project Constitution forbids disputing these.",
        };
    }

    // 3. Mixed file / identity block.
    //
    //    Disputing an account's ACCURACY implicitly asserts the account is the
    //    client's. On a mixed file we do not know that, so we resolve identity
    //    first and dispute nothing beneath it.
    if (mixedFile) {
        return {
            eligible: false,
            reason:
                "Mixed-file or identity concern is unresolved. Disputing this account's accuracy would " +
                "implicitly assert it belongs to the client, which is the very question in doubt.",
        };
    }

    // 4. A bureau-specific account number must exist.
    //
    //    An account the bureau cannot locate is a dispute that returns "unable to
    //    locate" and burns a round.
    if (!tradeline.masked_account) {
        return {
            eligible: false,
            reason:
                "No masked account number is reported by this bureau. The dispute could not identify " +
                "the account.",
        };
    }

    // 5. Item-level memory: already resolved, or explicitly excluded.
    if (itemHistory) {
        const status = String(itemHistory.currentStatus ?? "").toLowerCase();

        if (["resolved", "excluded", "no_further_action"].includes(status)) {
            return {
                eligible: false,
                reason: `Item memory marks this tradeline "${itemHistory.currentStatus}". Not re-disputed.`,
            };
        }
    }

    // 6. A STRONGER, FACT-SPECIFIC STRATEGY WINS.
    //
    //    This is the anti-duplication gate, and it is the reason baseline is
    //    computed as a FALLBACK rather than as an additional dispute. A tradeline
    //    with a real Metro 2 contradiction gets ONE section, arguing the
    //    contradiction. Bolting a generic "I dispute completeness and accuracy"
    //    onto it would WEAKEN the letter: a specific, provable defect sitting next
    //    to a bare denial reads as though we are unsure of the defect.
    //
    //    Specific always supersedes baseline. One tradeline, one section, one
    //    strongest argument.
    if (decision && decision.outcome === "DISPUTE_CANDIDATE") {
        return {
            eligible: false,
            reason:
                "A stronger, fact-specific strategy already applies. Specific strategies always " +
                "supersede the baseline path, and one tradeline never receives two dispute sections.",
        };
    }

    if (decision && decision.outcome === "EXCLUDED") {
        return { eligible: false, reason: decision.exclusion?.reason ?? "Excluded by the Constitution." };
    }

    reasons.push("Derogatory account with no stronger fact-specific finding.");

    return {
        eligible: true,
        reason:
            "Eligible for baseline reinvestigation. The processor has NOT established that this " +
            "account is inaccurate — it disputes completeness and accuracy and requests verification, " +
            "which is the consumer's right under FCRA § 611.",
        decisionRecord: BASELINE_DECISION.record,
        reason_id: BASELINE_DECISION.reason,
        strategy: BASELINE_DECISION.strategy,
        evidenceClass: BASELINE_DECISION.evidenceClass,
    };
}

/**
 * Fold baseline candidates into an existing decision set.
 *
 * Runs AFTER decideDisputes(), so that every specific strategy has already had
 * its chance. Baseline never competes with a real finding; it only fills the gap
 * a real finding left.
 *
 * @param {object} decisions  decideDisputes() output
 * @param {object} report     BT Credit Report Model
 * @param {object} context    { itemHistory: { [stable_item_key]: {...} } }
 */
export function applyBaselineDisputes(decisions, report, context = {}) {
    const { itemHistory = {} } = context;

    const existing = new Map();
    for (const d of decisions.itemDecisions ?? []) existing.set(d.stableItemKey, d);

    const mixedFile = !!decisions.summary?.blockedByMixedFile;

    const added = [];
    const rejected = [];

    const groups = [
        ...(report.accounts ?? []).map((a) => ({ group: a, kind: "TRADELINE" })),
        ...(report.collections ?? []).map((a) => ({ group: a, kind: "COLLECTION" })),
    ];

    for (const { group, kind } of groups) {
        for (const tradeline of group.bureau_tradelines ?? []) {
            const key = tradeline.stable_item_key;
            const decision = existing.get(key) ?? null;

            const check = baselineEligibility({
                tradeline,
                decision,
                itemHistory: itemHistory[key] ?? null,
                mixedFile,
            });

            if (!check.eligible) {
                rejected.push({
                    stableItemKey: key,
                    bureau: tradeline.bureau,
                    furnisher: tradeline.furnisher,
                    reason: check.reason,
                });
                continue;
            }

            added.push({
                stableItemKey: key,
                stableAccountKey: group.stable_account_key,
                bureau: tradeline.bureau,
                furnisher: tradeline.furnisher ?? group.original_creditor ?? null,
                kind,

                outcome: "DISPUTE_CANDIDATE",
                baseline: true, // marks this as a §611 request, NOT a proven defect

                primaryDecision: {
                    record: BASELINE_DECISION.record,
                    name: BASELINE_DECISION.name,
                    evidenceClass: BASELINE_DECISION.evidenceClass,
                },
                decisionRecords: [
                    {
                        record: BASELINE_DECISION.record,
                        name: BASELINE_DECISION.name,
                        evidenceClass: BASELINE_DECISION.evidenceClass,
                    },
                ],

                evidenceClass: BASELINE_DECISION.evidenceClass,
                automationTier: "PROCESSOR_REVIEW",
                humanReview: true,
                humanReviewReasons: [
                    "Baseline reinvestigation: no specific defect was established. The dispute rests on " +
                    "the consumer's right to demand verification, not on evidence of error.",
                ],
                appliedOverrides: [],
                complianceGates: [],

                findings: [], // NONE. That is the point.

                reasoningChain: [
                    `BASELINE: derogatory account with no stronger fact-specific finding.`,
                    `DECISION: ${BASELINE_DECISION.record} (${BASELINE_DECISION.name}).`,
                    `EVIDENCE: ${BASELINE_DECISION.evidenceClass} — nothing has been proven about this account.`,
                    `The consumer disputes completeness and accuracy and requests reinvestigation under FCRA § 611.`,
                ],
            });
        }
    }

    return {
        schemaVersion: BASELINE_SCHEMA_VERSION,
        ...decisions,
        itemDecisions: [...(decisions.itemDecisions ?? []), ...added],
        baseline: {
            added: added.length,
            rejected: rejected.length,
            addedItems: added.map((a) => ({ stableItemKey: a.stableItemKey, bureau: a.bureau, furnisher: a.furnisher })),
            rejectedItems: rejected,
        },
        summary: {
            ...decisions.summary,
            baselineDisputes: added.length,
            disputeCandidates: (decisions.summary?.disputeCandidates ?? 0) + added.length,
        },
    };
}
