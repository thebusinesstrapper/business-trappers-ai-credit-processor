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

import { readdirSync, statSync } from "fs";
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
