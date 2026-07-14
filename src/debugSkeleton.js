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
