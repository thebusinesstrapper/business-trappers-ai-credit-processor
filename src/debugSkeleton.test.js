/**
 * debugSkeleton.test.js
 * Run: node src/debugSkeleton.test.js
 *
 * TEMPORARY — delete with the endpoint when M7 is complete.
 */

import { readFileSync } from "fs";
import { walkSkeleton, extractSkeletonNode } from "./debugSkeleton.js";

let passed = 0, failed = 0;
const check = (n, a, e) => {
    const ok = a === e;
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(58)} -> ${a}${ok ? "" : `\n      expected: ${e}`}`);
};

// Shaped exactly like the run #83 skeleton: real keys live under `children`, and
// arrays expose one `element`.
const skeleton = {
    path: "$",
    type: "object",
    keys: ["CREDIT_RESPONSE"],
    children: {
        CREDIT_RESPONSE: {
            path: "$.CREDIT_RESPONSE",
            type: "object",
            keys: ["BORROWER", "CREDIT_LIABILITY"],
            children: {
                BORROWER: { path: "$.CREDIT_RESPONSE.BORROWER", type: "object" },
                CREDIT_LIABILITY: {
                    path: "$.CREDIT_RESPONSE.CREDIT_LIABILITY",
                    type: "array",
                    length: 14,
                    element: {
                        type: "object",
                        keys: ["@_AccountIdentifier", "CREDIT_REPOSITORY"],
                        children: {
                            "@_AccountIdentifier": { type: "string", sample: "****6095" },
                            CREDIT_REPOSITORY: {
                                path: "$.CREDIT_RESPONSE.CREDIT_LIABILITY[].CREDIT_REPOSITORY",
                                type: "array",
                                length: 3,
                                element: {
                                    type: "object",
                                    keys: ["@_SourceType", "@_AccountStatusType"],
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};

console.log("\n=== THE NODE WE ACTUALLY NEED ===\n");

const literal = walkSkeleton(skeleton, "CREDIT_RESPONSE.CREDIT_LIABILITY.element.children.CREDIT_REPOSITORY");

check("literal path resolves", literal.ok, true);
check("...lands on CREDIT_REPOSITORY", literal.node.type, "array");
check("...with its per-bureau element", literal.node.element.keys.includes("@_SourceType"), true);

console.log("\n--- Shorthand resolves too ---");

// Requiring the caller to type `children` and `element` at every level is a
// transcription error waiting to happen — and a mistyped path that silently
// returns the WRONG node is worse than one that fails.
const shorthand = walkSkeleton(skeleton, "CREDIT_RESPONSE.CREDIT_LIABILITY.CREDIT_REPOSITORY");

check("shorthand resolves", shorthand.ok, true);
check("...to the SAME node", shorthand.node.path, literal.node.path);

console.log("\n=== A BAD PATH NAVIGATES, IT DOES NOT JUST FAIL ===\n");

// A discovery tool that says only "not found" makes the operator search by trial
// and error — which is exactly the loop this endpoint exists to end.
const miss = walkSkeleton(skeleton, "CREDIT_RESPONSE.CREDIT_TYPO");

check("bad path fails", miss.ok, false);
check("...reports how far it got", miss.reached, "CREDIT_RESPONSE");
check("...and what was available there", miss.availableKeys.includes("CREDIT_LIABILITY"), true);

console.log("\n=== EMPTY PATH LISTS THE ROOT ===\n");

const root = walkSkeleton(skeleton, "");
check("empty path is valid", root.ok, true);
check("...lists the root keys", root.availableKeys.includes("CREDIT_RESPONSE"), true);

console.log("\n=== THE STRING IS THE WHOLE POINT ===\n");

// n8n's JSON viewer collapses nested objects to {...}. It cannot collapse a string.
const extracted = extractSkeletonNode(skeleton, "CREDIT_RESPONSE.CREDIT_LIABILITY.CREDIT_REPOSITORY");

check("node_json is a STRING", typeof extracted.node_json, "string");
check("...containing the nested detail", extracted.node_json.includes("@_SourceType"), true);
check("...that JSON.parse round-trips", JSON.parse(extracted.node_json).type, "array");
check("keys are a flat array (Table view)", Array.isArray(extracted.keys), true);
check("byte size reported", extracted.node_bytes > 0, true);

console.log("\n=== READ-ONLY. IT SPENDS NOTHING. ===\n");

const src = readFileSync(new URL("./debugSkeleton.js", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

check("no browser", /playwright|page\.|\.click\(|\.goto\(/.test(src), false);
check("no network", /fetch\(|axios|http/.test(src), false);
check("no memory writes", /supabase|writeMemory|clientMemory/.test(src), false);
check("no order/purchase path", /order|purchase|submit|buy/i.test(src), false);

console.log("\n=== THE ROUTE FAILS CLOSED ===\n");

const server = readFileSync(new URL("../server.js", import.meta.url), "utf-8");

// With no DEBUG_TOKEN configured the route does not exist. 404, not 403 — a 403
// would confirm to an unauthenticated caller that the endpoint is there.
check("route is token-gated", /skeleton-node[\s\S]{0,400}x-debug-token/.test(server), true);
check("...404 on a bad token, not 403", /skeleton-node[\s\S]{0,500}status\(404\)/.test(server), true);
check("...reuses M6, does not reimplement it", /skeleton-node[\s\S]{0,1800}await runMilestone6\(req\.body\)/.test(server), true);
check("...marked TEMPORARY for removal", /TEMPORARY — SCHEMA DISCOVERY ONLY/.test(server), true);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
