// reportSchemaProbe.js
//
// TEMPORARY — SCHEMA DISCOVERY ONLY. DELETE WITH THE OTHER /debug SCHEMA ROUTES.
//
// Purpose: from a captured report SKELETON (the structure-only representation
// buildSkeleton() already produces in spikeReportJson.js), return ONLY the
// schema paths whose key relates to public records / bankruptcy, so we can learn
// the exact raw MISMO key structure WITHOUT guessing — and without any value
// ever leaving the app.
//
// SAFETY — WHY THIS IS VALUE-FREE
//   The skeleton is walked, never the raw payload. For every matching node we
//   emit ONLY: path, key, type, (arrays) length + firstElementKeys. We NEVER
//   read, copy, or emit the skeleton's `sample` field. `sample` is the one place
//   a skeleton can still carry a real value (buildSkeleton's redact() truncates
//   strings and passes numbers/booleans through), so it is deliberately ignored
//   here. Nothing else in a skeleton node is a consumer value.

// Case-insensitive key terms we care about. A node matches if its KEY contains
// any of these as a substring.
const MATCH_TERMS = ["public", "record", "bankrupt", "court", "chapter", "case", "filed", "discharge"];

function keyMatches(key) {
    const k = String(key ?? "").toLowerCase();
    return MATCH_TERMS.some((term) => k.includes(term));
}

// The last path segment ("A.B.C" -> "C", "A.B[0]" -> "B"), used as the display
// key and as the term to test. Robust to the "[0]" array marker buildSkeleton
// appends.
function lastSegment(path) {
    const s = String(path ?? "");
    const noIndex = s.replace(/\[\d+\]$/, "");
    const parts = noIndex.split(".");
    return parts[parts.length - 1] || noIndex;
}

// The key names present in the FIRST element of an array node, if the skeleton
// captured a representative element. buildSkeleton stores it as `element`, an
// object node whose `keys` are the first element's keys. Returns [] if unknown.
function firstElementKeysOf(arrayNode) {
    const el = arrayNode?.element;
    if (el && Array.isArray(el.keys)) return el.keys.slice();
    // An array of scalars (or an empty array) has no object keys.
    return [];
}

/**
 * Recursively collect matching schema entries from a skeleton node.
 *
 * @param {object} node   a buildSkeleton() node ({ path, type, keys?, children?, length?, element? })
 * @param {Map<string,object>} out  dedupe map keyed by path
 */
function walk(node, out) {
    if (!node || typeof node !== "object") return;

    const path = node.path ?? null;
    const key = path ? lastSegment(path) : null;

    // Record THIS node if its key matches. The root ("$") has no meaningful key.
    if (key && key !== "$" && keyMatches(key)) {
        if (!out.has(path)) {
            const entry = { path, key, type: node.type ?? null };
            if (node.type === "array") {
                entry.length = typeof node.length === "number" ? node.length : 0;
                entry.firstElementKeys = firstElementKeysOf(node);
            }
            out.set(path, entry);
        }
    }

    // Recurse into children (object) and the representative element (array).
    // We walk STRUCTURE ONLY — never a `sample`.
    if (node.type === "array") {
        if (node.element) walk(node.element, out);
    } else if (node.children && typeof node.children === "object") {
        for (const child of Object.values(node.children)) walk(child, out);
    }
}

/**
 * Probe a skeleton for public-record / bankruptcy schema paths.
 *
 * @param {object} skeleton  the buildSkeleton() output from a captured report
 * @returns {Array<{path:string, key:string, type:string, length?:number, firstElementKeys?:string[]}>}
 *          deduplicated by path, value-free.
 */
export function probePublicRecordSchema(skeleton) {
    const out = new Map(); // path -> entry (dedupes identical paths)
    walk(skeleton, out);
    // Stable, readable ordering.
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export { MATCH_TERMS };
