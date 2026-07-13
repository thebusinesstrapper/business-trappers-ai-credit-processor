/**
 * decideDisputes.js
 *
 * THE DECISION ENGINE (Milestone 8).
 *
 *   Capture -> Normalize -> Analyze Facts -> [DECISION] -> Strategy -> Reason
 *           -> Instruction -> Letter Blueprint -> Letter Generation
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENGINE DOES
 *
 *   Consumes the Analysis Engine's findings and, FOR EACH BUREAU TRADELINE,
 *   determines:
 *
 *     1. Which Decision Record(s) govern the facts found.
 *     2. Whether a Constitutional exclusion forbids acting at all.
 *     3. A confidence score, and therefore whether a human must review.
 *     4. An explainable reasoning chain from fact to decision.
 *
 *   It does NOT re-discover facts. Analysis already did that, and re-deriving
 *   them here would let the two engines disagree — the exact duplication the
 *   Constitution's "no duplicate intelligence" rule exists to prevent.
 *
 *   It selects NO strategy, NO law, NO reason, NO instruction. It does not
 *   write letters. Those are the next engines.
 *
 *   PURE and DETERMINISTIC. No GPT. No browser. No network.
 * ---------------------------------------------------------------------------
 */

import {
    EVIDENCE_CLASS,
    FINDING_TO_DECISION,
    DECISION_NO_FURTHER_ACTION,
    DECISION_AUTHORIZED_USER,
    DECISION_HUMAN_EXCEPTION,
    DECISION_MIXED_FILE,
    automationTier,
} from "./decisionRecords.js";

export const DECISION_SCHEMA_VERSION = "BT-DECISION-1.0";

export const OUTCOME = Object.freeze({
    DISPUTE_CANDIDATE: "DISPUTE_CANDIDATE",
    HUMAN_REVIEW: "HUMAN_REVIEW",
    REQUIRES_CONSUMER_INPUT: "REQUIRES_CONSUMER_INPUT",
    EXCLUDED: "EXCLUDED",
    NO_ACTION: "NO_ACTION",
});

const DEROGATORY_STATUS = /charge.?off|collection|repossession|foreclosure|settled|default|written.?off|late|delinquent/i;
const AUTHORIZED_USER = /authorized\s*user|auth\s*user/i;

const SEVERITY_RANK = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };

// ---------------------------------------------------------------------------
// CONSTITUTIONAL EXCLUSIONS
//
// These run BEFORE any decision is reached, and they OVERRIDE every finding, no
// matter how strong. They are non-negotiables from the Project Constitution,
// not heuristics.
//
// The stakes are asymmetric and that asymmetry is the whole point: disputing an
// item we should not have touched can DELETE A BENEFICIAL TRADELINE and lower
// the client's score. Declining to dispute one we could have costs us a cycle.
// We take the cycle.
// ---------------------------------------------------------------------------

/**
 * Constitution: "Never dispute authorized user accounts."
 *
 * An authorized-user tradeline is usually on the file to HELP — it carries
 * someone else's good history. Disputing it invites its removal, and the
 * consumer loses that history. The account is not theirs to dispute in the
 * first place.
 */
function checkAuthorizedUser(observation) {
    const responsibility = observation?.responsibility;

    if (responsibility && AUTHORIZED_USER.test(String(responsibility))) {
        return {
            rule: "CONSTITUTION_NEVER_DISPUTE_AUTHORIZED_USER",
            reason:
                `Reported responsibility is "${responsibility}". The Project Constitution forbids ` +
                `disputing authorized user accounts. Disputing it risks removing beneficial history ` +
                `that is not the consumer's to dispute.`,
            decisionRecord: DECISION_AUTHORIZED_USER,
        };
    }

    return null;
}

/**
 * Constitution: "Never dispute positive accounts except to correct inaccurate
 * derogatory reporting."
 *
 * A positive tradeline HELPS the score. Disputing it to fix, say, a $60
 * cross-bureau balance variance risks the bureau simply DELETING the tradeline
 * — trading a trivial correction for the loss of a good account.
 *
 * The exception is precise: we may act on a positive account ONLY where the
 * inaccuracy is itself DEROGATORY (a late payment on an otherwise clean
 * account). Correcting that helps. Anything else, we leave alone.
 */
function checkPositiveAccount(observation, findings) {
    const status = observation?.status ?? "";
    const pastDue = Number(observation?.past_due ?? 0);

    const isDerogatory = DEROGATORY_STATUS.test(String(status)) || pastDue > 0;
    if (isDerogatory) return null; // not a positive account — normal rules apply

    // The account is positive. Does any finding concern DEROGATORY reporting?
    const derogatoryFindings = findings.filter((f) =>
        /PAYMENT_HISTORY|DEROGATORY|RE_AGING|PAST_DUE|BEYOND_REPORTING/.test(f.code)
    );

    if (derogatoryFindings.length > 0) return null; // the exception applies — proceed

    return {
        rule: "CONSTITUTION_NEVER_DISPUTE_POSITIVE_ACCOUNTS",
        reason:
            `This account reports no derogatory information (status "${status}", past due ${pastDue}), ` +
            `and no finding concerns inaccurate derogatory reporting. The Project Constitution forbids ` +
            `disputing positive accounts. Disputing to correct a non-derogatory discrepancy risks the ` +
            `bureau deleting a beneficial tradeline.`,
        decisionRecord: DECISION_NO_FURTHER_ACTION,
    };
}

// ---------------------------------------------------------------------------
// Decision assembly
// ---------------------------------------------------------------------------

function evidenceFor(mapping) {
    return mapping?.evidence ? EVIDENCE_CLASS[mapping.evidence] : null;
}

/**
 * Decide one bureau tradeline.
 *
 * `mixedFile` is passed in because a mixed file poisons EVERYTHING beneath it —
 * see the note in decideDisputes().
 */
function decideItem(item, { mixedFile, observationsByItemKey }) {
    // An INQUIRY is not an account. It has no status, no balance, no
    // responsibility, and no observation in the report.
    //
    // The Constitutional exclusions are about ACCOUNTS: "never dispute an
    // authorized user ACCOUNT", "never dispute a positive ACCOUNT". Running them
    // against an inquiry is a category error — and a silently harmful one. An
    // inquiry with no observation reads as status:"" and past_due:0, which looks
    // EXACTLY like a pristine positive tradeline, so the positive-account rule
    // fires and the inquiry is excluded before it can ever reach the consumer.
    const isAccountLike = item.kind === "TRADELINE" || item.kind === "COLLECTION";

    const hasObservation = observationsByItemKey.has(item.stableItemKey);
    const observation = observationsByItemKey.get(item.stableItemKey) ?? {};

    const base = {
        stableItemKey: item.stableItemKey,   // THE LEGAL UNIT OF DISPUTE
        stableAccountKey: item.stableAccountKey, // context only
        bureau: item.bureau,
        furnisher: item.furnisher ?? null,
        kind: item.kind,
    };

    // ---- No findings -------------------------------------------------------
    if (!item.findings.length) {
        return {
            ...base,
            outcome: OUTCOME.NO_ACTION,
            primaryDecision: DECISION_NO_FURTHER_ACTION,
            decisionRecords: [],
            confidence: null,
            automationTier: null,
            humanReview: false,
            humanReviewReasons: [],
            exclusion: null,
            unmappedFindings: [],
            reasoningChain: ["No findings were identified for this bureau tradeline. No action."],
        };
    }

    // ---- Constitutional exclusions FIRST -----------------------------------
    //
    // An account-like item whose observation we could NOT find cannot be checked
    // against the exclusions. It must NOT fall through as "positive" — an
    // unreadable account would then be silently excluded, and we would never
    // know. Absence of evidence fails to a human, never to silence.
    if (isAccountLike && !hasObservation) {
        return {
            ...base,
            outcome: OUTCOME.HUMAN_REVIEW,
            primaryDecision: DECISION_HUMAN_EXCEPTION,
            decisionRecords: [],
            confidence: null,
            automationTier: "HUMAN_REVIEW_REQUIRED",
            humanReview: true,
            humanReviewReasons: [
                "No observation was found in the BT Credit Report Model for this tradeline, so the " +
                "Constitutional exclusions (authorized user, positive account) could not be checked. " +
                "We do not dispute an account we cannot verify we are allowed to dispute.",
            ],
            exclusion: null,
            unmappedFindings: [],
            reasoningChain: [
                `Findings identified: ${item.findings.map((f) => f.code).join(", ")}.`,
                `The tradeline's observation could not be located, so exclusions could not be applied.`,
                `Routed to ${DECISION_HUMAN_EXCEPTION.record} (Human Exception Routing).`,
            ],
        };
    }

    const exclusion = isAccountLike
        ? (checkAuthorizedUser(observation) ?? checkPositiveAccount(observation, item.findings))
        : null;

    if (exclusion) {
        return {
            ...base,
            outcome: OUTCOME.EXCLUDED,
            primaryDecision: exclusion.decisionRecord,
            decisionRecords: [],
            confidence: null,
            automationTier: null,
            humanReview: false,
            humanReviewReasons: [],
            exclusion: { rule: exclusion.rule, reason: exclusion.reason },
            unmappedFindings: [],
            reasoningChain: [
                `${item.findings.length} finding(s) were identified: ${item.findings.map((f) => f.code).join(", ")}.`,
                `EXCLUDED BY ${exclusion.rule}.`,
                exclusion.reason,
                `No dispute is raised for this tradeline. Governing record: ${exclusion.decisionRecord.record}.`,
            ],
        };
    }

    // ---- Map findings to Decision Records ----------------------------------
    const decisionRecords = new Map();
    const unmapped = [];
    const consumerInput = [];

    for (const f of item.findings) {
        const mapping = FINDING_TO_DECISION[f.code];

        if (!mapping) {
            unmapped.push({ code: f.code, reason: "No mapping exists in decisionRecords.js." });
            continue;
        }

        if (mapping.evidence === "REQUIRES_CONSUMER") {
            consumerInput.push({ code: f.code, reason: mapping.reason });
            continue;
        }

        if (!mapping.record) {
            // Deliberately unmapped: either context-only, or a real library gap.
            if (mapping.gap) {
                unmapped.push({ code: f.code, reason: mapping.reason, libraryGap: true });
            }
            continue;
        }

        const evidence = evidenceFor(mapping);

        if (!decisionRecords.has(mapping.record)) {
            decisionRecords.set(mapping.record, {
                record: mapping.record,
                name: mapping.name,
                triggeredBy: [],
                evidenceClass: evidence.id,
                confidence: evidence.confidence,
                rationale: evidence.rationale,
            });
        }

        const entry = decisionRecords.get(mapping.record);
        entry.triggeredBy.push(f.code);

        // Where several findings support one record, keep the STRONGEST evidence
        // class. A record supported by both a self-evident contradiction and a
        // circumstantial pattern is carried by the contradiction.
        if (evidence.confidence > entry.confidence) {
            entry.confidence = evidence.confidence;
            entry.evidenceClass = evidence.id;
            entry.rationale = evidence.rationale;
        }
    }

    const records = [...decisionRecords.values()].sort(
        (a, b) => b.confidence - a.confidence || a.record.localeCompare(b.record)
    );

    // ---- Nothing actionable ------------------------------------------------
    if (records.length === 0) {
        const gaps = unmapped.filter((u) => u.libraryGap);

        // A library gap is NOT "no issue". It is a real, often strong finding
        // with no Decision Record to carry it. Sending it to NO_ACTION would
        // silently discard a valid dispute. It goes to a human.
        if (gaps.length > 0) {
            return {
                ...base,
                outcome: OUTCOME.HUMAN_REVIEW,
                primaryDecision: DECISION_HUMAN_EXCEPTION,
                decisionRecords: [],
                confidence: null,
                automationTier: "HUMAN_REVIEW_REQUIRED",
                humanReview: true,
                humanReviewReasons: gaps.map((g) => g.reason),
                exclusion: null,
                unmappedFindings: unmapped,
                reasoningChain: [
                    `Findings identified: ${item.findings.map((f) => f.code).join(", ")}.`,
                    `${gaps.length} finding(s) have NO governing Decision Record in the Master Decision Library.`,
                    `These are real findings — they are NOT discarded. Routed to ${DECISION_HUMAN_EXCEPTION.record} ` +
                        `(Human Exception Routing) so a person decides, and so the library gap is recorded.`,
                ],
            };
        }

        if (consumerInput.length > 0) {
            return {
                ...base,
                outcome: OUTCOME.REQUIRES_CONSUMER_INPUT,
                primaryDecision: null,
                decisionRecords: [],
                confidence: null,
                automationTier: null,
                humanReview: false,
                humanReviewReasons: [],
                exclusion: null,
                unmappedFindings: [],
                requiresConsumerInput: consumerInput,
                reasoningChain: [
                    `The only findings here depend on facts the consumer holds: ` +
                        `${consumerInput.map((c) => c.code).join(", ")}.`,
                    `This engine will not assume those facts. The question is routed to the consumer, ` +
                        `NOT converted into a dispute.`,
                ],
            };
        }

        return {
            ...base,
            outcome: OUTCOME.NO_ACTION,
            primaryDecision: DECISION_NO_FURTHER_ACTION,
            decisionRecords: [],
            confidence: null,
            automationTier: null,
            humanReview: false,
            humanReviewReasons: [],
            exclusion: null,
            unmappedFindings: unmapped,
            reasoningChain: [
                `Findings identified: ${item.findings.map((f) => f.code).join(", ")}.`,
                `None map to an actionable Decision Record. These are context, not inaccuracies.`,
            ],
        };
    }

    // ---- Confidence --------------------------------------------------------
    //
    // The primary decision is the one carried by the STRONGEST evidence, and the
    // item's confidence is ITS confidence.
    //
    // Note what we do NOT do: we do not add confidence together because several
    // findings agree. Three cross-bureau variances are still cross-bureau
    // evidence; they do not become self-evident by being numerous. Stacking
    // would manufacture certainty we have not earned.
    const primary = records[0];
    let confidence = primary.confidence;

    const humanReviewReasons = [];

    // MIXED FILE POISONS EVERYTHING BELOW IT.
    //
    // If two consumers' data is merged into one file, a tradeline finding may
    // describe SOMEONE ELSE'S ACCOUNT. Disputing its balance would implicitly
    // assert the account is the consumer's — confirming data that may not be
    // theirs, and undermining the mixed-file claim itself.
    //
    // The correct remedy is to resolve the mixed file FIRST. So every item on a
    // mixed file goes to a human, regardless of how strong its own findings are.
    if (mixedFile) {
        confidence = Math.min(confidence, 60);
        humanReviewReasons.push(
            "MIXED FILE INDICATED ON THIS REPORT. Findings on this tradeline may describe another " +
            "consumer's account. Disputing item-level details would implicitly assert that this " +
            "account belongs to the client. The mixed file must be resolved first."
        );
    }

    if (unmapped.some((u) => u.libraryGap)) {
        humanReviewReasons.push(
            `Additional findings have no governing Decision Record: ` +
            `${unmapped.filter((u) => u.libraryGap).map((u) => u.code).join(", ")}.`
        );
    }

    const tier = automationTier(confidence);

    if (tier === "HUMAN_REVIEW_REQUIRED" && humanReviewReasons.length === 0) {
        humanReviewReasons.push(`Confidence ${confidence} is below the 80% processor-review threshold.`);
    }

    const humanReview = tier === "HUMAN_REVIEW_REQUIRED" || tier === "PROCESSOR_REVIEW" || humanReviewReasons.length > 0;

    // ---- The reasoning chain — this is the deliverable ----------------------
    const reasoningChain = [
        `FACTS: ${item.findings.length} finding(s) on ${item.bureau}'s reporting of ` +
            `"${item.furnisher ?? "this item"}" — ${item.findings.map((f) => f.code).join(", ")}.`,

        ...item.findings.map((f) => `  [${f.severity}] ${f.code}: ${f.explanation}`),

        `DECISION: ${primary.record} (${primary.name}), triggered by ${primary.triggeredBy.join(", ")}.`,

        `EVIDENCE CLASS: ${primary.evidenceClass}. ${primary.rationale}`,

        ...(records.length > 1
            ? [`ALSO APPLICABLE: ${records.slice(1).map((r) => `${r.record} (${r.name})`).join(", ")}.`]
            : []),

        `CONFIDENCE: ${confidence} -> ${tier}.`,

        ...humanReviewReasons.map((r) => `HUMAN REVIEW: ${r}`),

        `SCOPE: this decision governs ${item.bureau}'s tradeline only (${item.stableItemKey}). ` +
            `Each bureau is decided independently.`,

        `NEXT: the Strategy Engine selects the approach. This engine selects no strategy, no law, ` +
            `no reason, and no instruction.`,
    ];

    return {
        ...base,
        outcome: humanReview ? OUTCOME.HUMAN_REVIEW : OUTCOME.DISPUTE_CANDIDATE,
        primaryDecision: { record: primary.record, name: primary.name },
        decisionRecords: records,
        confidence,
        automationTier: tier,
        humanReview,
        humanReviewReasons,
        exclusion: null,
        unmappedFindings: unmapped,
        ...(consumerInput.length ? { requiresConsumerInput: consumerInput } : {}),
        reasoningChain,
    };
}

// ---------------------------------------------------------------------------
// THE ENGINE
// ---------------------------------------------------------------------------

/**
 * Decide disputes from an Analysis Engine result.
 *
 * @param {object} analysis  output of analyzeCreditReport()
 * @param {object} [context]
 * @param {object} [context.report]
 *        The BT Credit Report Model the analysis was run against. Required to
 *        read `responsibility` and `status`, which the Constitutional exclusions
 *        depend on. WITHOUT IT, EXCLUSIONS CANNOT BE ENFORCED and every item is
 *        routed to human review rather than silently disputed.
 *
 * @returns {Promise<object>} decisions. No strategy. No law. No letters.
 */
export async function decideDisputes(analysis, context = {}) {

    const { report = null } = context;

    if (!analysis || analysis.analysisOk !== true) {
        return {
            schemaVersion: DECISION_SCHEMA_VERSION,
            decisionOk: false,
            errors: ["Analysis was not successful. A report we do not trust is never decided upon."],
            reportLevel: { blockers: [], decisions: [] },
            itemDecisions: [],
            libraryGaps: [],
            summary: {},
        };
    }

    // Index the raw observations. The exclusions need `responsibility` and
    // `status`, which are facts about the tradeline, not findings about it — so
    // they live in the report, not the analysis.
    const observationsByItemKey = new Map();

    if (report) {
        const groups = [...(report.accounts ?? []), ...(report.collections ?? []), ...(report.public_records ?? [])];

        for (const account of groups) {
            for (const tradeline of account.bureau_tradelines ?? []) {
                observationsByItemKey.set(tradeline.stable_item_key, tradeline.observation ?? {});
            }
        }
    }

    // ---- Report-level: mixed file ------------------------------------------
    const mixedFileFinding = (analysis.personalInformation ?? []).find(
        (f) => f.code === "PI_MIXED_FILE_INDICATOR"
    );

    const mixedFile = !!mixedFileFinding;
    const blockers = [];
    const reportDecisions = [];

    if (mixedFile) {
        blockers.push({
            blocker: "MIXED_FILE",
            decisionRecord: DECISION_MIXED_FILE,
            reason:
                "More than one identity anchor appears on this file. Until the mixed file is resolved, " +
                "item-level disputes are unsafe: a dispute about a tradeline's balance implicitly " +
                "asserts the tradeline is the client's. Resolve identity first.",
            explanation: mixedFileFinding.explanation,
        });

        reportDecisions.push({
            record: DECISION_MIXED_FILE.record,
            name: DECISION_MIXED_FILE.name,
            triggeredBy: ["PI_MIXED_FILE_INDICATOR"],
            confidence: EVIDENCE_CLASS.SELF_EVIDENT.confidence,
            priority: "FIRST — before any item-level dispute",
        });
    }

    // Other personal-information decisions.
    for (const f of analysis.personalInformation ?? []) {
        const mapping = FINDING_TO_DECISION[f.code];
        if (!mapping?.record || mapping.record === DECISION_MIXED_FILE.record) continue;

        const evidence = evidenceFor(mapping);

        if (!reportDecisions.some((d) => d.record === mapping.record)) {
            reportDecisions.push({
                record: mapping.record,
                name: mapping.name,
                triggeredBy: [f.code],
                confidence: evidence.confidence,
                priority: "Personal information",
            });
        }
    }

    // ---- Item-level ---------------------------------------------------------
    // Tag each item with WHAT IT IS. The Constitutional exclusions are about
    // accounts; applying them to an inquiry or a public record is a category
    // error, so the engine must never be in a position to guess.
    const allItems = [
        ...(analysis.tradelines ?? []).map((i) => ({ ...i, kind: "TRADELINE" })),
        ...(analysis.collections ?? []).map((i) => ({ ...i, kind: "COLLECTION" })),
        ...(analysis.inquiries ?? []).map((i) => ({ ...i, kind: "INQUIRY" })),
        ...(analysis.publicRecords ?? []).map((i) => ({ ...i, kind: "PUBLIC_RECORD" })),
    ];

    const itemDecisions = allItems
        .map((item) => decideItem(item, { mixedFile, observationsByItemKey }))
        .sort((a, b) => {
            const ca = a.confidence ?? -1;
            const cb = b.confidence ?? -1;
            return cb - ca || String(a.stableItemKey).localeCompare(String(b.stableItemKey));
        });

    // If we had no report, we could not enforce the exclusions. Say so loudly
    // rather than letting the caller believe they were applied.
    const exclusionsEnforced = !!report;

    if (!exclusionsEnforced) {
        for (const decision of itemDecisions) {
            if (decision.outcome === OUTCOME.DISPUTE_CANDIDATE) {
                decision.outcome = OUTCOME.HUMAN_REVIEW;
                decision.humanReview = true;
                decision.humanReviewReasons.push(
                    "The BT Credit Report Model was not supplied, so the Constitutional exclusions " +
                    "(authorized user, positive account) COULD NOT BE CHECKED. No dispute proceeds " +
                    "automatically without them."
                );
            }
        }
    }

    // ---- Library gaps -------------------------------------------------------
    const libraryGaps = [];

    for (const decision of itemDecisions) {
        for (const u of decision.unmappedFindings ?? []) {
            if (!u.libraryGap) continue;
            if (libraryGaps.some((g) => g.code === u.code)) continue;

            libraryGaps.push({ code: u.code, reason: u.reason });
        }
    }

    const counts = {};
    for (const outcome of Object.values(OUTCOME)) {
        counts[outcome] = itemDecisions.filter((d) => d.outcome === outcome).length;
    }

    return {
        schemaVersion: DECISION_SCHEMA_VERSION,
        decisionOk: true,
        errors: [],

        reportLevel: {
            blockers,
            decisions: reportDecisions,
            mixedFile,
        },

        itemDecisions,

        libraryGaps,

        summary: {
            itemsEvaluated: itemDecisions.length,
            outcomes: counts,
            disputeCandidates: counts[OUTCOME.DISPUTE_CANDIDATE],
            requiringHumanReview: counts[OUTCOME.HUMAN_REVIEW],
            excludedByConstitution: counts[OUTCOME.EXCLUDED],
            constitutionalExclusionsEnforced: exclusionsEnforced,
            libraryGapsFound: libraryGaps.length,
            blockedByMixedFile: mixedFile,
        },
    };
}
