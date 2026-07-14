/**
 * imports.test.js
 * Run: node src/imports.test.js
 *
 * ===========================================================================
 * IMPORT RESOLUTION SMOKE TEST.
 *
 * Railway crashed at boot with:
 *
 *     Cannot find module '/app/src/intelligence/clientIdentity.js'
 *     imported from /app/src/milestoneProfile.js
 *
 * A broken import is a compile-time fact. There is no reason for a deploy to be
 * the thing that discovers it.
 *
 * WORSE: the crash was only a SYMPTOM. server.js imports milestoneProfile.js, so
 * that break fired at boot. It does NOT import generateLetter.js — which had the
 * SAME broken dependency, sitting silent. Booting the server would not have
 * revealed it. The first thing to find out would have been the production
 * validation run.
 *
 * So this test does not check server.js's imports. It loads EVERY module,
 * including the ones no route reaches yet.
 * ===========================================================================
 */

import { readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

let passed = 0, failed = 0;
const check = (n, ok, detail = "") => {
    ok ? passed++ : failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : `\n      ${detail}`}`);
};

const ROOT = new URL("..", import.meta.url).pathname;

/** Every .js module in the project, excluding tests and node_modules. */
function allModules(dir, found = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;

        const full = join(dir, entry);

        if (statSync(full).isDirectory()) {
            allModules(full, found);
        } else if (entry.endsWith(".js") && !entry.endsWith(".test.js")) {
            found.push(full);
        }
    }

    return found;
}

const modules = [
    join(ROOT, "server.js"),
    ...allModules(join(ROOT, "src")),
].filter((m, i, a) => a.indexOf(m) === i);

console.log(`\n=== RESOLVING ${modules.length} MODULES ===\n`);

const broken = [];

for (const path of modules) {
    const rel = path.replace(ROOT, "");

    try {
        await import(pathToFileURL(path).href);
    } catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND") {
            // Threw for some other reason (a missing env var, say). Not what this
            // test is for.
            continue;
        }

        // DISTINGUISH TWO VERY DIFFERENT FAILURES:
        //
        //   A missing npm PACKAGE ("@supabase/postgrest-js") means node_modules
        //   is not installed. On Railway, `npm install` fixes that. It is not a
        //   code defect, and flagging it would make this test cry wolf in any
        //   environment without a full install — and a test that cries wolf is a
        //   test people learn to ignore.
        //
        //   A missing LOCAL FILE ("./intelligence/clientIdentity.js") is a real,
        //   permanent defect that no install will fix. THAT is what crashed
        //   Railway, and that is all we are looking for.
        const isLocalFile = /Cannot find module '[./]/.test(error.message);

        if (isLocalFile) {
            broken.push({ rel, message: error.message.split("\n")[0] });
        }
    }
}

for (const b of broken) {
    console.log(`  BROKEN: ${b.rel}\n          ${b.message}`);
}

check(`every module resolves its imports (${modules.length} checked)`, broken.length === 0,
    `${broken.length} module(s) have unresolvable imports — Railway will crash at boot.`);

console.log("\n=== EVERY NAMED IMPORT ACTUALLY EXISTS ===\n");

// THIS IS THE CHECK THAT WOULD HAVE CAUGHT `normalizeIdentity is not defined`.
//
// crcClientProfile.js CALLED normalizeIdentity() but never IMPORTED it. That is
// a ReferenceError at RUNTIME — `node --check` passes, module resolution passes,
// and the failure appears only when the code path is actually executed. On a
// browser-automation route, that meant a live Railway run, a Browserbase session,
// and a CRC login before anything went wrong.
//
// A module resolving is not the same as its imports being satisfiable.

const namedImportMisses = [];

for (const path of modules) {
    const rel = path.replace(ROOT, "");
    const source = readFileSync(path, "utf-8");

    // import { a, b as c } from "./x.js"
    const importRe = /import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g;

    let match;
    while ((match = importRe.exec(source)) !== null) {
        const names = match[1]
            .split(",")
            .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
            .filter(Boolean);

        const targetPath = new URL(match[2], pathToFileURL(path)).pathname;

        let target;
        try {
            target = await import(pathToFileURL(targetPath).href);
        } catch {
            continue; // resolution failure is reported by the check above
        }

        for (const name of names) {
            if (!(name in target)) {
                namedImportMisses.push({ rel, name, from: match[2] });
            }
        }
    }
}

for (const miss of namedImportMisses) {
    console.log(`  MISSING EXPORT: ${miss.rel} imports { ${miss.name} } from ${miss.from} — not exported.`);
}

check(`every named import exists in its target module`, namedImportMisses.length === 0,
    `${namedImportMisses.length} import(s) name something the target does not export.`);

console.log("\n=== EVERY IDENTIFIER USED IS DEFINED OR IMPORTED ===\n");

// The inverse, and the one that actually bit us: a function CALLED but never
// imported. It is not a missing export — the export exists. It is a missing
// IMPORT, and nothing in the module system complains until the line runs.
//
// Narrow, deliberate scope: the identity-normalization path, which is frozen and
// on the letter path. A general-purpose undefined-identifier checker is a linter,
// and writing one here would be building the wrong thing.
const IDENTITY_EXPORTS = ["normalizeIdentity", "canonicalState", "verifyIdentity", "fromCrcProfile", "formatAddress", "IDENTITY_SOURCE"];

const undefinedUses = [];

for (const path of modules) {
    const rel = path.replace(ROOT, "");
    const source = readFileSync(path, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

    if (rel.includes("clientIdentity.js")) continue; // it defines them

    for (const name of IDENTITY_EXPORTS) {
        const used = new RegExp(`\\b${name}\\s*\\(`).test(source) || new RegExp(`\\b${name}\\.`).test(source);
        if (!used) continue;

        const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source);

        if (!imported) {
            undefinedUses.push({ rel, name });
        }
    }
}

for (const u of undefinedUses) {
    console.log(`  USED BUT NOT IMPORTED: ${u.rel} calls ${u.name}() — ReferenceError at runtime.`);
}

check("no identity function is used without being imported", undefinedUses.length === 0,
    `${undefinedUses.length} runtime ReferenceError(s) waiting to happen.`);

console.log("\n=== THE IDENTITY GATE HAS EXACTLY ONE HOME ===\n");

// Two copies of clientIdentity.js would be two divergent versions of the gate
// that decides whether a consumer's address may go on a legal document. The
// Constitution forbids duplicate intelligence, and this is the module where a
// duplicate would do the most damage.
const identityCopies = allModules(join(ROOT, "src")).filter((p) => p.endsWith("clientIdentity.js"));

check("exactly one clientIdentity.js exists", identityCopies.length === 1,
    `found ${identityCopies.length}: ${identityCopies.map((p) => p.replace(ROOT, "")).join(", ")}`);

check("...and it lives in src/intelligence/", identityCopies[0]?.includes("/intelligence/") === true,
    `found at ${identityCopies[0]?.replace(ROOT, "")} — seven modules import it expecting src/intelligence/`);

console.log(`\n${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
