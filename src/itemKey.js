/**
 * itemKey.js
 *
 * Assigns and resolves the TWO persistent identities defined by the Business
 * Trappers Credit Report Extraction System™ v1.1 §7.
 *
 *   stable_account_key  — the underlying real-world financial account.
 *                         Cross-bureau correlation, intelligence, account history.
 *
 *   stable_item_key     — ONE bureau's tradeline. THE LEGAL UNIT OF WORK.
 *                         Disputes, strategies, outcomes, and LETTERS attach here.
 *
 * ===========================================================================
 * THIS IS THE HIGHEST-RISK MODULE IN THE EXTRACTION SYSTEM.
 *
 * A key that drifts between runs silently detaches dispute history. The
 * processor then forgets what it has already disputed, re-opens settled items,
 * and loses the escalation history that Round 3+ strategy depends on.
 *
 * That failure is UNRECOVERABLE and INVISIBLE. Nothing throws. The letters still
 * generate. They are simply wrong, and nobody finds out.
 *
 * PURE. No Playwright. No network. No memory access. Fully unit-testable.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * WHAT RUN #83 CONFIRMED
 *
 * The Credit Hero / Array.io payload is MISMO 2.4, XML-converted to JSON, so
 * attribute keys are @-PREFIXED.
 *
 * §10.1 IS ANSWERED: **MERGED.** CREDIT_REPOSITORY is nested beneath each
 * CREDIT_LIABILITY. Array groups the bureaus for us WITHIN a run.
 *
 * THIS DOES NOT MAKE THE CASCADE DEAD CODE, AND THAT DISTINCTION MATTERS:
 *
 *   WITHIN a run  — Array gives us the grouping. We do not resolve it.
 *   ACROSS runs   — Array gives us NOTHING. Last month's report and this month's
 *                   report are two separate documents. Matching this month's
 *                   liability to the one we disputed last month is entirely OUR
 *                   problem, and it is the whole reason these keys exist.
 *
 * The cascade is therefore load-bearing in full — just for cross-run identity
 * rather than cross-bureau grouping.
 * ---------------------------------------------------------------------------
 */

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// MINTING
// ---------------------------------------------------------------------------

/**
 * A UUID, NOT a content hash. Deliberately.
 *
 * A key must have NO SEMANTIC RELATIONSHIP TO ITS CONTENT, so that no future
 * change to furnisher naming, account masking, date reporting, or a vendor's
 * identifier scheme can ever cause it to drift.
 *
 * Identity is CONFERRED, then PERSISTED. It is not DERIVED. (§7.7)
 */
export const KEY_PREFIX = Object.freeze({
    ACCOUNT: "bt_ac_",
    COLLECTION: "bt_co_",
    PUBLIC_RECORD: "bt_pr_",
    TRADELINE: "bt_tl_",
    INQUIRY: "bt_iq_",
});

export function mintKey(prefix) {
    if (!Object.values(KEY_PREFIX).includes(prefix)) {
        throw new Error(`Unknown key prefix: ${prefix}`);
    }

    return `${prefix}${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// VENDOR IDENTIFIERS — EVIDENCE, NEVER IDENTITY (§7.4)
// ---------------------------------------------------------------------------

/**
 * TradelineHashComplex is PERMANENTLY BARRED from identity use, regardless of
 * what any evidence ever shows.
 *
 * A "complex" hash almost certainly incorporates balance, status, and dates —
 * fields that change every month BY DESIGN. Its entire purpose is to DIFFER when
 * the data differs. That makes it an excellent change-detection signal and a
 * catastrophic identity key.
 *
 * If it ever appears stable across two reports, that is because NOTHING CHANGED
 * THAT MONTH — stability by coincidence, not by design. Promoting it on that
 * evidence would be reasoning from an accident.
 *
 * The bar is structural: this function is the only way to read a vendor id, and
 * it refuses.
 */
export const BARRED_FROM_IDENTITY = Object.freeze(["TradelineHashComplex"]);

export function readVendorIdentifiers(node) {
    if (!node || typeof node !== "object") return {};

    return {
        array_account_identifier: node["@ArrayAccountIdentifier"] ?? null,
        tradeline_hash_simple: node["@TradelineHashSimple"] ?? null,

        // Captured for CHANGE DETECTION and audit. Never passed to a cascade.
        tradeline_hash_complex: node["@TradelineHashComplex"] ?? null,
    };
}

/**
 * Structural refusal. If a future developer reaches for the complex hash as an
 * identity signal, they hit a named error rather than a silent success.
 */
export function assertNotBarred(signalName) {
    if (BARRED_FROM_IDENTITY.includes(signalName)) {
        throw new Error(
            `${signalName} is PERMANENTLY BARRED from identity use (Extraction §7.4). ` +
            `It incorporates balance, status, and dates — fields that change every month by ` +
            `design. It is a change-detection signal, not an identity key. Apparent stability ` +
            `means nothing changed that month, not that the hash is stable.`
        );
    }
}

// ---------------------------------------------------------------------------
// COMPONENT NORMALIZATION — deterministic, pure
// ---------------------------------------------------------------------------

const LEGAL_SUFFIXES = [
    "NA", "N A", "INC", "LLC", "CORP", "CO", "BANK USA", "CARD SERVICES", "CARD SVCS",
];

/**
 * Furnisher name, normalized for MATCHING only. Never for display, never for a
 * letter — a letter prints what the bureau actually reported.
 *
 * The alias table starts EMPTY and grows ONLY from observed evidence. It is never
 * seeded with guesses.
 *
 * WHY EMPTY: in THIS module a wrong alias MERGES two different accounts and
 * corrupts dispute memory irreversibly. (Note this is the exact opposite of the
 * permissible-purpose alias table, where an alias can only ever BLOCK a dispute
 * and a wrong entry costs one dispute rather than corrupting history. Same
 * mechanism, opposite risk, opposite rule.)
 */
export const FURNISHER_ALIASES = Object.freeze({});

export function furnisherNorm(name) {
    if (!name || typeof name !== "string") return null;

    let n = name
        .toUpperCase()
        .replace(/[.,'&/\\-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    for (const suffix of LEGAL_SUFFIXES) {
        n = n.replace(new RegExp(`\\s+${suffix}$`), "").trim();
    }

    return FURNISHER_ALIASES[n] ?? n ?? null;
}

/**
 * Trailing 4 digits of the masked account number.
 *
 * Bureaus mask differently — 411111******1234 / ****1234 / 4111******** — but
 * usually preserve the trailing digits. Where they do not, this returns null and
 * the cascade falls to a weaker tier rather than inventing a match.
 */
export function acctLast4(masked) {
    if (!masked || typeof masked !== "string") return null;

    const digits = masked.replace(/\D/g, "");

    if (digits.length < 4) return null;

    return digits.slice(-4);
}

/**
 * THE FULL DISPLAYED ACCOUNT NUMBER, normalized for FORMATTING ONLY.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE TRADELINE'S IDENTITY. THE LAST FOUR DIGITS ARE NOT.
 *
 * A consumer can hold several tradelines with the same furnisher at the same
 * bureau. When the bureau masks the account so that fewer than four digits are
 * readable, acctLast4() correctly returns null for all of them — and any
 * identity built on last-4 then collapses genuinely separate accounts into one
 * bucket. The complete displayed string is what distinguishes them, and it is
 * what the bureau actually printed.
 *
 * WHAT IS REMOVED: whitespace and hyphens, and case is folded. These carry no
 * account information; "4111 1111" and "4111-1111" are one account rendered two
 * ways.
 *
 * WHAT IS KEPT: EVERYTHING ELSE, including every masking character. Asterisks,
 * X's, bullets and hashes are part of what the bureau displayed and are
 * frequently the only thing distinguishing two masked accounts.
 *
 * The previous implementation stripped [^A-Z0-9], which deleted asterisks
 * outright: "****1234" and "**** **** **** 1234" both became "1234", while
 * "XXXX1234" kept its mask purely because X is a letter. Whether a mask
 * survived depended on which character the bureau happened to use.
 *
 * NOTHING IS RECONSTRUCTED. Hidden digits stay hidden; this only strips
 * separators.
 * ---------------------------------------------------------------------------
 */
export function canonicalAccountNumber(value) {
    if (value === null || value === undefined) return null;

    const normalized = String(value)
        .toUpperCase()
        .replace(/\s/g, "")   // spaces, tabs, non-breaking spaces
        .replace(/-/g, "");    // hyphens

    return normalized || null;
}

/**
 * Date opened, to YYYY-MM.
 *
 * Day-level precision is DISCARDED because bureaus disagree by days on the same
 * account. Keeping the day would split one account into three.
 */
export function openedYm(date) {
    if (!date || typeof date !== "string") return null;

    const m = date.match(/^(\d{4})-(\d{2})/);

    return m ? `${m[1]}-${m[2]}` : null;
}

export function accountTypeNorm(type) {
    if (!type || typeof type !== "string") return null;

    return type.toUpperCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// MATCHING CASCADES (§7.5)
// ---------------------------------------------------------------------------

/**
 * A. ACCOUNT correlation -> stable_account_key
 *
 * Strongest tier first. A0 is pending proof of stability and collision-freedom
 * against real data — until then it is used, but its performance is recorded.
 */
export function accountSignatures(account) {
    const vendor = readVendorIdentifiers(account);

    const last4 = acctLast4(account.masked_account);
    const ym = openedYm(account.date_opened);
    const type = accountTypeNorm(account.account_type);
    const furnisher = furnisherNorm(account.furnisher);

    const sigs = [];

    if (vendor.array_account_identifier) {
        sigs.push({ tier: "A0", value: `A0|${vendor.array_account_identifier}` });
    }

    if (last4 && ym) sigs.push({ tier: "A1", value: `A1|${last4}|${ym}` });
    if (last4 && type) sigs.push({ tier: "A2", value: `A2|${last4}|${type}` });

    // A3 is WEAK and deliberately last. THE FURNISHER NAME IS NOT IDENTITY
    // EVIDENCE ACROSS BUREAUS — bureaus are EXPECTED to name the same lender
    // differently (NAVY FEDERAL CR UNION / NAVY FCU / NAVY FEDERAL CREDIT UNION).
    // It may never be permitted to SPLIT an account that account-number evidence
    // joins, so it only appears when account-number evidence is absent.
    if (!last4 && furnisher && ym && type) {
        sigs.push({ tier: "A3", value: `A3|${furnisher}|${ym}|${type}` });
    }

    return sigs;
}

/**
 * B. BUREAU TRADELINE identity -> stable_item_key
 *
 * THIS is the legal unit of work. Disputes are filed with a BUREAU, about THAT
 * BUREAU'S reporting. Dispute memory attaches here — never to the account.
 *
 * Attaching dispute history to the account instead would merge three separate
 * legal proceedings into one, and we would lose track of which bureau we had
 * already written to, about what.
 */
export function tradelineSignatures(tradeline, stableAccountKey) {
    const vendor = readVendorIdentifiers(tradeline);

    const account = canonicalAccountNumber(tradeline.masked_account);
    const furnisher = furnisherNorm(tradeline.furnisher);
    const bureau = tradeline.bureau;

    const sigs = [];

    if (vendor.tradeline_hash_simple) {
        sigs.push({ tier: "T0", value: `T0|${vendor.tradeline_hash_simple}` });
    }

    // ---- T1: account + bureau + THE FULL DISPLAYED ACCOUNT NUMBER --------
    //
    // T1 was previously `account|bureau` alone, on the stated assumption that
    // "an account reports AT MOST ONCE per bureau."
    //
    // THE FULL-ACCOUNT-NUMBER IDENTITY RULE INVALIDATES THAT ASSUMPTION. One
    // Array account id can legitimately carry two tradelines at the same bureau
    // when their displayed account numbers differ, and they are two separate
    // legal units of work.
    //
    // Left as account+bureau, T1 would emit ONE signature for BOTH of them. On
    // the next run buildRegistry() would map that single signature to two keys,
    // and resolveKey() would fail closed as AMBIGUOUS — on exactly the pair we
    // had deliberately kept separate. Including the account number keeps each
    // tradeline's strongest signature unique to it.
    if (stableAccountKey && bureau && account) {
        sigs.push({ tier: "T1", value: `T1|${stableAccountKey}|${bureau}|${account}` });
    }

    // T1B: no account number is displayed at all. The at-most-once assumption
    // is then the only evidence available, so it is used — but ONLY here, where
    // there is nothing stronger, never in preference to a displayed number.
    if (stableAccountKey && bureau && !account) {
        sigs.push({ tier: "T1B", value: `T1B|${stableAccountKey}|${bureau}` });
    }

    // T2: furnisher + FULL account number + bureau. Was keyed on last-4, which
    // is absent precisely when the mask hides it — so it could not distinguish
    // two masked accounts from the same furnisher.
    if (furnisher && account && bureau) {
        sigs.push({ tier: "T2", value: `T2|${furnisher}|${account}|${bureau}` });
    }

    return sigs;
}

/** Inquiries exist at ONE bureau. No account to correlate across bureaus. (§7.7) */
export function inquirySignatures(inquiry) {
    const furnisher = furnisherNorm(inquiry.furnisher);

    if (!furnisher || !inquiry.bureau || !inquiry.inquiry_date) return [];

    return [{ tier: "I0", value: `I0|${furnisher}|${inquiry.bureau}|${inquiry.inquiry_date}` }];
}

// ---------------------------------------------------------------------------
// RESOLUTION
// ---------------------------------------------------------------------------

export const RESOLUTION = Object.freeze({
    MATCHED: "matched",
    MINTED: "minted",
    AMBIGUOUS: "ambiguous",
});

/**
 * Resolve one item's key against the alias registry persisted with the PREVIOUS
 * report (Extraction Decision 2: the previous report IS the key registry — no
 * separate table is required).
 *
 * A KEY IS ASSIGNED ONCE AND PERSISTED. IT IS NEVER RECOMPUTED. (§7.2)
 * On later runs we MATCH current signatures against previously persisted keys.
 *
 * @param {Array<{tier:string,value:string}>} signatures  current item, strongest first
 * @param {Map<string,string>} registry  signature value -> existing key
 * @param {string} prefix  KEY_PREFIX.* used if we must mint
 */
export function resolveKey(signatures, registry, prefix) {
    // Strongest tier first.
    for (const sig of signatures) {
        const hits = registry.get(sig.value) ?? new Set();

        if (hits.size === 1) {
            return {
                resolution: RESOLUTION.MATCHED,
                key: [...hits][0],
                matchedTier: sig.tier,
                signatures: signatures.map((s) => s.value),
            };
        }

        // ---- AMBIGUITY FAILS CLOSED (§7.6) ---------------------------------
        //
        // We do NOT pick one. We do NOT mint a new key. A WRONG KEY IS WORSE THAN
        // NO KEY: it attaches this run's findings to ANOTHER account's dispute
        // history, corrupting the authoritative memory store in a way that cannot
        // be detected or undone.
        //
        // A failed extraction routes to manual review and costs us one cycle.
        // That trade is not close.
        if (hits.size > 1) {
            return {
                resolution: RESOLUTION.AMBIGUOUS,
                key: null,
                matchedTier: sig.tier,
                candidates: [...hits],
                signatures: signatures.map((s) => s.value),
            };
        }
    }

    // No match at any tier. First sighting.
    return {
        resolution: RESOLUTION.MINTED,
        key: mintKey(prefix),
        matchedTier: null,
        signatures: signatures.map((s) => s.value),
    };
}

/**
 * Build the signature -> key registry from the PREVIOUS BT Credit Report Model.
 *
 * Aliases only ever ACCUMULATE. They are never removed — a signature we saw once
 * remains valid evidence for that key forever, which is what lets a furnisher
 * rebrand or a bureau change its masking format without detaching history.
 */
export function buildRegistry(previousItems = []) {
    // ---- Map<signature, SET of keys>. The Set is load-bearing. --------------
    //
    // A Map<signature, key> is STRUCTURALLY INCAPABLE of representing "this
    // signature maps to two different keys" — the second write silently
    // overwrites the first. Ambiguity would then be undetectable, and resolveKey
    // would confidently return whichever item happened to be persisted last,
    // attaching this run's findings to ANOTHER account's dispute history.
    //
    // That is exactly the unrecoverable, invisible corruption §7.6 exists to
    // prevent — so the data structure must be able to SEE the collision before
    // the fail-closed check can fire on it.
    const registry = new Map();

    for (const item of previousItems) {
        if (!item?.key || !Array.isArray(item.signatures)) continue;

        for (const value of item.signatures) {
            if (!registry.has(value)) registry.set(value, new Set());

            registry.get(value).add(item.key);
        }
    }

    return registry;
}
