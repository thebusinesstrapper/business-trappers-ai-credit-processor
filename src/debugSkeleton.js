/**
 * debugSkeleton.js
 *
 * ===========================================================================
 * TEMPORARY. SCHEMA DISCOVERY ONLY. DELETE WHEN M7 IS COMPLETE.
 *
 * Exists for one reason: n8n's JSON viewer collapses nested objects to {...} and
 * its Table view only exposes top-level fields, so a nested skeleton node cannot
 * be read out of an M6 response by eye.
 *
 * THE FIX IS NOT DEEPER NESTING — IT IS A STRING.
 * n8n cannot collapse a string. This module walks to the requested node and
 * returns it JSON-stringified, so it renders as one flat, copyable text field
 * regardless of how deep the original was.
 *
 * READ-ONLY. Pure. No browser, no network, no memory, no writes. It reads a
 * skeleton object that M6 already produced and returns part of it.
 * ===========================================================================
 */

/**
 * ===========================================================================
 * ONE FIELD MAP. IMPORTED, NOT COPIED.
 *
 * This module previously kept its OWN copy of the candidate key names. When the
 * real DOFD key turned out to be @_FirstDelinquencyDate, I updated the
 * normalizer's map and not this one — so /debug/field-map went on reporting DOFD
 * as unresolved against keys nobody uses any more, while the normalizer had
 * already been fixed.
 *
 * TWO SOURCES OF TRUTH FOR THE SAME THING IS THE DEFECT. A discovery tool that
 * disagrees with the parser it exists to serve is worse than no discovery tool:
 * it reports confidently on a schema the code does not use.
 *
 * So the map is imported. There is now exactly one, and it cannot drift.
 * ===========================================================================
 */
import { FIELD as FIELD_CANDIDATES } from "./reportNormalize.js";


/**
 * Walk a dotted path into the skeleton.
 *
 * The skeleton nests real keys under `children`, so a caller may write either:
 *
 *   CREDIT_RESPONSE.CREDIT_LIABILITY.element.children.CREDIT_REPOSITORY   (literal)
 *   CREDIT_RESPONSE.CREDIT_LIABILITY.element.CREDIT_REPOSITORY            (shorthand)
 *
 * Both resolve. Requiring the caller to type `children` at every level is a
 * transcription error waiting to happen, and a mistyped path that silently
 * returns the WRONG node is worse than one that fails.
 *
 * ON FAILURE we return the keys available at the deepest level we DID reach, so
 * the caller can navigate rather than guess again. A discovery tool that says
 * only "not found" makes the operator do the search by trial and error.
 */
export function walkSkeleton(skeleton, path) {
    if (!skeleton || typeof skeleton !== "object") {
        return { ok: false, error: "No skeleton supplied.", reached: null, availableKeys: [] };
    }

    const segments = String(path || "")
        .split(".")
        .map((s) => s.trim())
        .filter(Boolean);

    if (segments.length === 0) {
        return {
            ok: true,
            reached: "",
            node: skeleton,
            availableKeys: describeKeys(skeleton),
        };
    }

    let node = skeleton;
    const reached = [];

    for (const segment of segments) {
        // Tolerate the caller writing (or omitting) the skeleton's own `children`
        // and `element` wrappers.
        const next =
            pick(node, segment) ??
            pick(node?.children, segment) ??
            pick(node?.element, segment) ??
            pick(node?.element?.children, segment);

        if (next === undefined) {
            return {
                ok: false,
                error:
                    `Path stopped at "${reached.join(".") || "(root)"}". ` +
                    `No key "${segment}" there. See availableKeys.`,
                reached: reached.join("."),
                availableKeys: describeKeys(node),
            };
        }

        node = next;
        reached.push(segment);
    }

    return {
        ok: true,
        reached: reached.join("."),
        node,
        availableKeys: describeKeys(node),
    };
}

function pick(obj, key) {
    if (!obj || typeof obj !== "object") return undefined;

    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** The keys a caller could go to next, from wherever they landed. */
function describeKeys(node) {
    if (!node || typeof node !== "object") return [];

    const out = new Set(Object.keys(node));

    for (const key of Object.keys(node.children ?? {})) out.add(key);
    for (const key of Object.keys(node.element ?? {})) out.add(key);
    for (const key of Object.keys(node.element?.children ?? {})) out.add(key);

    return [...out];
}

/**
 * Extract a node and render it so n8n cannot collapse it.
 *
 * `node_json` is the payload the operator actually needs: one flat string.
 */
export function extractSkeletonNode(skeleton, path) {
    const result = walkSkeleton(skeleton, path);

    if (!result.ok) {
        return {
            ok: false,
            requested_path: path,
            error: result.error,
            reached: result.reached,
            available_keys: result.availableKeys,
        };
    }

    return {
        ok: true,
        requested_path: path,
        reached: result.reached,

        // Keys at this node, as a flat array — readable in n8n's Table view.
        keys: result.availableKeys,

        // THE POINT OF THIS MODULE. A string. n8n renders it whole.
        node_json: JSON.stringify(result.node, null, 2),

        node_bytes: JSON.stringify(result.node).length,
    };
}


/**
 * =========================================================================
 * LIABILITY MAP — the decisive schema artifact. TEMPORARY, delete with M7.
 *
 * The skeleton samples CREDIT_LIABILITY[0] only. One row cannot answer the
 * question that governs the entire extraction design:
 *
 *   Is ONE CreditLiability = ONE BUREAU'S TRADELINE (and Array reports the same
 *   real account up to three times, once per bureau)?
 *
 *      -> Per-bureau values are PRESERVED. Extraction Decision 4 holds.
 *         CREDIT_LIABILITY is the stable_item_key unit.
 *         BT-DM-0031 cross-bureau variance is provable.
 *
 *   Or is ONE CreditLiability = ONE MERGED ACCOUNT carrying several bureaus?
 *
 *      -> Array FLATTENED the bureaus before we ever saw them. Decision 4 is
 *         unsatisfiable from this payload, and every cross-bureau finding in
 *         analyzeCreditReport.js is dead code.
 *
 * THE XML->JSON TRAP: converters collapse ONE repeated element into an OBJECT and
 * SEVERAL into an ARRAY. So CREDIT_REPOSITORY is an object when a single bureau
 * reports the account and an array when two or three do. Reading element [0] and
 * generalising is exactly how you conclude the wrong thing with total confidence.
 *
 * This projects EVERY liability into one flat row so the answer is counted, not
 * inferred. Read-only. Pure. Reads the payload M6 already captured.
 * =========================================================================
 */
export function buildLiabilityMap(payload) {
    const response = payload?.CREDIT_RESPONSE ?? payload;

    const liabilities = toArray(response?.CREDIT_LIABILITY);

    if (liabilities.length === 0) {
        return { ok: false, error: "No CREDIT_LIABILITY entries in the payload." };
    }

    const rows = liabilities.map((liability, index) => {
        // CREDIT_REPOSITORY: object when ONE bureau reports it, array when several.
        const repositories = toArray(liability?.CREDIT_REPOSITORY);

        const bureaus = repositories
            .map((r) => r?.["@_SourceType"] ?? null)
            .filter(Boolean);

        return {
            i: index,

            // The account-correlation key (tier A0). If THREE rows share one value,
            // Array is giving us three bureau views of ONE account.
            array_account_id: liability?.["@ArrayAccountIdentifier"] ?? null,

            // The tradeline-identity key (tier T0). Should be UNIQUE per row.
            tradeline_hash_simple: liability?.["@TradelineHashSimple"] ?? null,

            bureau_count: bureaus.length,
            bureaus: bureaus.join("|") || null,

            // If rows sharing an array_account_id have DIFFERENT values here, then
            // per-bureau reporting is preserved and Decision 4 holds.
            balance: liability?.["@_UnpaidBalanceAmount"] ?? null,
            past_due: liability?.["@_PastDueAmount"] ?? null,
            status: liability?.["@RawAccountStatus"] ?? null,
            account_type: liability?.["@RawAccountType"] ?? null,

            creditor: liability?._CREDITOR?.["@_Name"] ?? null,

            is_collection: liability?.["@IsCollectionIndicator"] ?? null,
            is_chargeoff: liability?.["@IsChargeoffIndicator"] ?? null,
        };
    });

    // ---- COUNT THE ANSWER. DO NOT INFER IT. --------------------------------
    const byAccountId = new Map();

    for (const row of rows) {
        if (!row.array_account_id) continue;

        if (!byAccountId.has(row.array_account_id)) byAccountId.set(row.array_account_id, []);

        byAccountId.get(row.array_account_id).push(row);
    }

    const shared = [...byAccountId.values()].filter((g) => g.length > 1);

    const multiBureauRows = rows.filter((r) => r.bureau_count > 1);

    let verdict;

    if (multiBureauRows.length > 0) {
        verdict =
            `MERGED — ${multiBureauRows.length}/${rows.length} liabilities carry MORE THAN ONE bureau. ` +
            `Array flattened per-bureau values before we saw them. Extraction Decision 4 is at risk; ` +
            `BT-DM-0031 cross-bureau variance may be unprovable. NEEDS A RULING.`;
    } else if (shared.length > 0) {
        verdict =
            `SEPARATE — every liability names ONE bureau, and ${shared.length} account(s) appear as ` +
            `multiple liabilities sharing an @ArrayAccountIdentifier. CREDIT_LIABILITY IS the ` +
            `stable_item_key unit. Per-bureau values are PRESERVED. Decision 4 holds.`;
    } else {
        verdict =
            `UNRESOLVED — every liability names one bureau, but NO @ArrayAccountIdentifier is shared ` +
            `across rows. Either this consumer genuinely has no account reported by two bureaus, or ` +
            `A0 does not correlate. Do not design the cascade on this alone.`;
    }

    return {
        ok: true,
        liability_count: rows.length,
        rows_with_multiple_bureaus: multiBureauRows.length,
        accounts_appearing_more_than_once: shared.length,
        verdict,

        // A string, so n8n cannot collapse it.
        rows_json: JSON.stringify(rows, null, 2),
    };
}

function toArray(v) {
    if (v == null) return [];

    return Array.isArray(v) ? v : [v];
}


/**
 * =========================================================================
 * FIELD MAP — resolve candidate keys AND enumerate their real values.
 * TEMPORARY. Delete with M7.
 *
 * A key NAME is not enough. Knowing `_AccountOwnershipType` exists does not tell
 * us whether an authorized user is spelled "AuthorizedUser", "Authorized User",
 * "A", or "3" — and the Project Constitution FORBIDS DISPUTING AUTHORIZED-USER
 * ACCOUNTS.
 *
 * A wrong guess there does not fail loudly. It silently disputes exactly the
 * accounts the Constitution protects, in the consumer's voice, over her
 * signature. So we enumerate the DISTINCT VALUES actually present across all 119
 * rows, and read the vocabulary off the real data instead of inventing it.
 *
 * Same for _AccountStatusType, _ConsumerDisputeIndicator, and
 * _DerogatoryDataIndicator: we must know the alphabet before we can read.
 *
 * READ-ONLY. Pure. Reads the payload M6 already captured.
 * =========================================================================
 */

/**
 * Fields whose VALUE VOCABULARY we must know before writing any logic that reads
 * them. Every distinct value is reported, with its count.
 */
const ENUM_FIELDS = ["responsibility", "account_status_type", "consumer_disputed", "derogatory"];

export function buildFieldMap(payload) {
    const response = payload?.CREDIT_RESPONSE ?? payload;

    const liabilities = toArray(response?.CREDIT_LIABILITY);

    if (liabilities.length === 0) {
        return { ok: false, error: "No CREDIT_LIABILITY entries in the payload." };
    }

    const resolved = {};
    const distinct = {};

    for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) {
        let winningKey = null;
        let found = 0;
        const values = new Map();

        for (const liability of liabilities) {
            for (const key of candidates) {
                if (!liability || !Object.prototype.hasOwnProperty.call(liability, key)) continue;

                const value = liability[key];

                if (value === null || value === undefined || value === "") continue;

                winningKey = winningKey ?? key;
                found++;

                if (ENUM_FIELDS.includes(field)) {
                    const v = String(value);
                    values.set(v, (values.get(v) ?? 0) + 1);
                }

                break; // first candidate that hits wins for this row
            }
        }

        resolved[field] = {
            key: winningKey,                 // null = NOT FOUND under any candidate
            rows_with_value: found,
            rows_total: liabilities.length,
            candidates_tried: candidates,
        };

        if (ENUM_FIELDS.includes(field)) {
            distinct[field] = [...values.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([value, count]) => ({ value, count }));
        }
    }

    // Any key on a liability we have NO candidate for. We cannot ask for a field
    // we do not know exists — so list everything, and let the gaps be visible.
    const allKeys = new Set();

    for (const liability of liabilities) {
        for (const key of Object.keys(liability ?? {})) allKeys.add(key);
    }

    const mapped = new Set(Object.values(resolved).map((r) => r.key).filter(Boolean));

    const unresolved = Object.entries(resolved)
        .filter(([, r]) => r.key === null)
        .map(([field]) => field);

    return {
        ok: true,
        liability_count: liabilities.length,

        // The fields we NEED and could not find. Each is a hard stop in the
        // normalizer — never a guess.
        unresolved_required_fields: unresolved,

        // A string, so n8n cannot collapse it.
        resolved_json: JSON.stringify(resolved, null, 2),

        // THE VOCABULARY. This is what makes the authorized-user rule safe to write.
        distinct_values_json: JSON.stringify(distinct, null, 2),

        // Everything on the liability, so nothing stays invisible.
        all_liability_keys: [...allKeys].sort(),
        keys_not_mapped: [...allKeys].filter((k) => !mapped.has(k)).sort(),
    };
}


/**
 * =========================================================================
 * COLLISION MAP — WHY does one (account, bureau) appear twice? TEMPORARY.
 *
 * The normalizer failed closed on (account, bureau) collisions. Before deciding
 * whether that is a rule we can implement or genuine Array ambiguity, we must see
 * WHAT collides. This projects every liability grouped by @ArrayAccountIdentifier
 * and, within each group, by bureau — surfacing exactly the rows that landed on
 * the same (account, bureau) slot, with the evidence that would (or would not)
 * let us order them deterministically.
 *
 * READ-ONLY. Pure.
 * =========================================================================
 */
export function buildCollisionMap(payload) {
    const response = payload?.CREDIT_RESPONSE ?? payload;
    const liabilities = toArray(response?.CREDIT_LIABILITY);

    if (liabilities.length === 0) return { ok: false, error: "No CREDIT_LIABILITY entries." };

    // group by array id -> bureau -> [rows]
    const groups = new Map();

    liabilities.forEach((l, index) => {
        const arrayId = l?.["@ArrayAccountIdentifier"] ?? `__none_${index}`;
        const bureaus = toArray(l?.CREDIT_REPOSITORY)
            .map((r) => r?.["@_SourceType"] ?? null)
            .filter(Boolean);

        if (!groups.has(arrayId)) groups.set(arrayId, new Map());

        for (const bureau of bureaus) {
            const byBureau = groups.get(arrayId);
            if (!byBureau.has(bureau)) byBureau.set(bureau, []);

            byBureau.get(bureau).push({
                row: index,
                bureau,
                furnisher: l?._CREDITOR?.["@_Name"] ?? null,
                masked_account: l?.["@_AccountIdentifier"] ?? null,
                account_status_type: l?.["@_AccountStatusType"] ?? null,
                is_collection: l?.["@IsCollectionIndicator"] ?? null,
                is_chargeoff: l?.["@IsChargeoffIndicator"] ?? null,
                date_reported: l?.["@_AccountReportedDate"] ?? l?.["@_AccountStatusDate"] ?? null,
                balance: l?.["@_UnpaidBalanceAmount"] ?? null,
                tradeline_hash_simple: l?.["@TradelineHashSimple"] ?? null,
                bureau_count_on_row: bureaus.length,
            });
        }
    });

    // keep only the (account, bureau) slots with MORE THAN ONE row
    const collisions = [];

    for (const [arrayId, byBureau] of groups.entries()) {
        for (const [bureau, rows] of byBureau.entries()) {
            if (rows.length > 1) {
                collisions.push({
                    array_account_id: arrayId,
                    bureau,
                    row_count: rows.length,

                    // The tell. If one row is a single-bureau tradeline and the
                    // other is a merged multi-bureau row, that is a DETERMINISTIC
                    // pattern, not ambiguity.
                    shapes: rows.map((r) => (r.bureau_count_on_row === 1 ? "single" : `merged(${r.bureau_count_on_row})`)),

                    // Do the colliding rows actually AGREE? If the account number
                    // and status match, they are duplicates. If they differ, they
                    // are genuinely different reportings and we cannot merge.
                    distinct_masked: [...new Set(rows.map((r) => r.masked_account))],
                    distinct_status: [...new Set(rows.map((r) => r.account_status_type))],
                    distinct_hash: [...new Set(rows.map((r) => r.tradeline_hash_simple))],

                    rows,
                });
            }
        }
    }

    return {
        ok: true,
        total_collisions: collisions.length,

        // How many collisions are "one single-bureau row + one merged row"? That
        // shape is deterministically resolvable. How many are two rows of the same
        // shape? Those are the hard ones.
        single_plus_merged: collisions.filter(
            (c) => c.shapes.includes("single") && c.shapes.some((sh) => sh.startsWith("merged"))
        ).length,

        collisions_json: JSON.stringify(collisions, null, 2),
    };
}
