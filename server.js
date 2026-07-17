import express from "express";
import dotenv from "dotenv";
import { runMilestone1 } from "./src/milestone1.js";
import { runMilestone2 } from "./src/milestone2.js";
import { runMilestone3 } from "./src/milestone3.js";
import { runMilestone4 } from "./src/milestone4.js";
import { runMilestone5 } from "./src/milestone5.js";
import { runCreditHeroSpike } from "./src/spikeCreditHeroRun.js";
import { runOrderPageSpike } from "./src/spikeOrderPageRun.js";
import { runReportJsonSpike } from "./src/spikeReportJsonRun.js";
import { runIdentifierSpike } from "./src/spikeIdentifiersRun.js";
import { runClientProfileSpike } from "./src/spikeClientProfileRun.js";
import { runProfileRead } from "./src/milestoneProfile.js";
import { runMilestone6 } from "./src/milestone6.js";
import { runMilestone7 } from "./src/milestone7.js";
import { discoverM8Crc } from "./src/discoverM8Crc.js"; // TEMPORARY — M8 discovery only
import { discoverM8CrcV2 } from "./src/discoverM8CrcV2.js"; // TEMPORARY — M8 discovery V2
import { discoverM8Messages } from "./src/discoverM8Messages.js"; // TEMPORARY — M8 Messages discovery
import { extractSkeletonNode, buildLiabilityMap, buildFieldMap, buildCollisionMap } from "./src/debugSkeleton.js"; // TEMPORARY — remove with M7

dotenv.config();

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.json({
        service: "Business Trappers AI Credit Processor",
        version: "1.0.0",
        status: "Running",
        milestone: "Milestone 1"
    });
});

app.post("/milestone-1", async (req, res) => {

    try {

        const result = await runMilestone1(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

app.post("/milestone-2", async (req, res) => {

    try {

        const result = await runMilestone2(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

app.post("/milestone-3", async (req, res) => {

    try {

        const result = await runMilestone3(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

app.post("/milestone-4", async (req, res) => {

    try {

        const result = await runMilestone4(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

app.post("/milestone-5", async (req, res) => {

    try {

        const result = await runMilestone5(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

app.post("/spike-credit-hero", async (req, res) => {

    try {

        const result = await runCreditHeroSpike(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

app.post("/spike-order-page", async (req, res) => {

    try {

        const result = await runOrderPageSpike(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

app.post("/spike-report-json", async (req, res) => {

    try {

        const result = await runReportJsonSpike(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

app.post("/spike-identifiers", async (req, res) => {

    try {

        const result = await runIdentifierSpike(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

/**
 * CRC client profile DOM discovery spike.
 *
 * READ-ONLY. Logs in, opens the client, navigates to the profile, and
 * inventories the DOM. It writes nothing and it guesses no selectors.
 *
 * Body: { "clientName": "Elizabeth Kelley" }
 */
app.post("/spike-client-profile", async (req, res) => {

    try {

        const result = await runClientProfileSpike(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

/**
 * Read the authoritative CRC client identity from the Edit Profile modal.
 *
 * READ ONLY. This route imports only the profile READER, which has no write
 * path. The status writer is a separate module and is not reachable from here.
 *
 * Body: { "clientName": "Elizabeth Kelley" }
 */
app.post("/read-client-profile", async (req, res) => {

    try {

        const result = await runProfileRead(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

/**
 * MILESTONE 6 — REAL REPORT CAPTURE.
 *
 * Selects the newest report, VERIFIES it is active, and passively captures the
 * Array.io payload. Does NOT normalize, reconcile, or generate letters — the
 * Normalization Engine is written against what this returns, never against a
 * guessed schema.
 *
 * Body: { "clientName": "Elizabeth Kelley" }
 */
app.post("/milestone-6", async (req, res) => {

    try {

        const result = await runMilestone6(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

/**
 * /milestone-7 — THE FULL END-TO-END PIPELINE.
 *
 * Capture + normalize (via M6) -> analysis -> decision -> strategy -> chain ->
 * letters -> reconcile. Returns the three-bureau dispute package, marked
 * FIRST_PRODUCTION_VALIDATION / NOT SENT. Adds no logic; orchestrates existing
 * tested stages.
 */
app.post("/milestone-7", async (req, res) => {

    try {

        const result = await runMilestone7(req.body);

        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

// TEMPORARY — M8 read-only discovery. Remove after discovery is complete.
app.post("/discover-m8-crc", async (req, res) => {
    try {
        const result = await discoverM8Crc(req.body);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// TEMPORARY — M8 discovery V2 (generation-capable, save-blocked). Remove after discovery.
app.post("/discover-m8-crc-v2", async (req, res) => {
    try {
        const result = await discoverM8CrcV2(req.body);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// TEMPORARY — M8 Messages compose discovery (read-only). Remove after discovery.
app.post("/discover-m8-messages", async (req, res) => {
    try {
        const result = await discoverM8Messages(req.body);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * Deployment verification only. Lists the routes the RUNNING build actually has.
 *
 * Deliberately NOT on the root endpoint: a public route table advertises every
 * spike and milestone endpoint on this service, which is a map of the attack
 * surface. Gated behind a token so it is useless to anyone without access.
 *
 * Returns 404 — not 403 — when the token is missing or wrong. A 403 would
 * CONFIRM the endpoint exists. A 404 tells a probe nothing.
 *
 * Registered LAST so that it sees every route registered above it.
 */

/**
 * Shared gate for the /debug routes.
 *
 * ---------------------------------------------------------------------------
 * IT RETURNS 404, NOT 403 — DELIBERATELY. A 403 confirms to an unauthenticated
 * caller that the endpoint exists.
 *
 * THE COST OF THAT CHOICE: from the outside, "route not deployed" and "wrong
 * token" look IDENTICAL. That is fine for an attacker and terrible for us — it
 * already sent us hunting a deploy problem that did not exist.
 *
 * So the REASON is logged SERVER-SIDE, where only Railway's log viewer can see
 * it. The caller still learns nothing. We learn everything.
 * ---------------------------------------------------------------------------
 */
function debugGateOpen(req, res, routeName) {
    // Trim both sides. A token pasted into a Railway env var very often carries a
    // trailing newline, and `"abc\n" !== "abc"` fails a comparison that is, to
    // every human looking at it, obviously equal.
    const expected = (process.env.DEBUG_TOKEN ?? "").trim();
    const supplied = (req.get("x-debug-token") ?? "").trim();

    if (!expected) {
        console.error(
            `[${routeName}] REFUSED: DEBUG_TOKEN is not set on this server. ` +
            `The route IS deployed — set DEBUG_TOKEN in Railway and redeploy.`
        );

        res.status(404).json({ error: "Not found" });
        return false;
    }

    if (!supplied) {
        console.error(`[${routeName}] REFUSED: no x-debug-token header was supplied.`);

        res.status(404).json({ error: "Not found" });
        return false;
    }

    if (supplied !== expected) {
        console.error(
            `[${routeName}] REFUSED: x-debug-token did not match. ` +
            `Supplied ${supplied.length} chars, expected ${expected.length}. ` +
            `(Lengths are logged, values are NOT.)`
        );

        res.status(404).json({ error: "Not found" });
        return false;
    }

    return true;
}

/**
 * =========================================================================
 * TEMPORARY — SCHEMA DISCOVERY ONLY. DELETE WHEN M7 IS COMPLETE.
 *
 * POST /debug/skeleton-node
 *   header: x-debug-token: <DEBUG_TOKEN>
 *   body:   { "path": "CREDIT_RESPONSE.CREDIT_LIABILITY.element.CREDIT_REPOSITORY",
 *             "clientName": "Elizabeth Kelley" }
 *
 * Runs the EXISTING M6 capture — it does not reimplement any browser step, does
 * not click anything M6 would not click, and spends nothing — then returns the
 * requested skeleton node as a STRING.
 *
 * The string is the whole point. n8n's JSON viewer collapses nested objects to
 * {...} and its Table view shows only top-level fields, so a deep skeleton node
 * cannot be read out of an M6 response by eye. n8n cannot collapse a string.
 *
 * FAILS CLOSED: with no DEBUG_TOKEN configured, this route returns 404 — it does
 * not exist. 404 rather than 403, so its existence is not disclosed to an
 * unauthenticated caller.
 * =========================================================================
 */
app.post("/debug/skeleton-node", async (req, res) => {

    if (!debugGateOpen(req, res, "/debug/skeleton-node")) return;

    const path = req.body?.path;

    if (!path) {
        return res.status(400).json({
            error: 'Supply a "path", e.g. "CREDIT_RESPONSE.CREDIT_LIABILITY.element.CREDIT_REPOSITORY". ' +
                   'Omit it entirely (empty string) to list the root keys.'
        });
    }

    try {

        // Reuse M6 as-is. No duplicated navigation, no duplicated capture.
        const result = await runMilestone6(req.body);

        if (!result.success) {
            return res.json({
                ok: false,
                reason: "The M6 capture did not succeed, so there is no skeleton to read.",
                milestone_error: result
            });
        }

        const skeleton = result.capturedPayload?.skeleton;

        if (!skeleton) {
            return res.json({
                ok: false,
                reason: "M6 succeeded but returned no capturedPayload.skeleton."
            });
        }

        return res.json(extractSkeletonNode(skeleton, path));

    } catch (error) {

        console.error(error);

        return res.status(500).json({ ok: false, error: error.message });

    }

});

/**
 * TEMPORARY — SCHEMA DISCOVERY ONLY. DELETE WHEN M7 IS COMPLETE.
 *
 * POST /debug/liability-map
 *   header: x-debug-token: <DEBUG_TOKEN>
 *   body:   { "clientName": "Elizabeth Kelley" }
 *
 * Projects EVERY CREDIT_LIABILITY into one flat row. The skeleton samples element
 * [0] only, and one row cannot answer whether a liability is one BUREAU'S
 * TRADELINE or one MERGED ACCOUNT — a question that governs the entire extraction
 * design. This counts the answer instead of inferring it.
 *
 * Reuses M6 as-is. Read-only. Spends nothing.
 */
app.post("/debug/liability-map", async (req, res) => {

    if (!debugGateOpen(req, res, "/debug/liability-map")) return;

    try {

        const result = await runMilestone6(req.body);

        if (!result.success) {
            return res.json({
                ok: false,
                reason: "The M6 capture did not succeed, so there is no payload to read.",
                milestone_error: result
            });
        }

        if (!result.payload) {
            return res.json({ ok: false, reason: "M6 succeeded but returned no payload." });
        }

        return res.json(buildLiabilityMap(result.payload));

    } catch (error) {

        console.error(error);

        return res.status(500).json({ ok: false, error: error.message });

    }

});

/**
 * TEMPORARY — SCHEMA DISCOVERY ONLY. DELETE WHEN M7 IS COMPLETE.
 *
 * POST /debug/field-map
 *   header: x-debug-token: <DEBUG_TOKEN>
 *   body:   { "clientName": "Elizabeth Kelley" }
 *
 * Resolves every candidate key name against the real payload AND enumerates the
 * DISTINCT VALUES of the fields whose vocabulary we must know before writing logic
 * that reads them — above all _AccountOwnershipType, because the Project
 * Constitution forbids disputing authorized-user accounts and a wrong guess at
 * that spelling fails SILENTLY.
 *
 * Reuses M6 as-is. Read-only. Spends nothing.
 */
app.post("/debug/field-map", async (req, res) => {

    if (!debugGateOpen(req, res, "/debug/field-map")) return;

    try {

        const result = await runMilestone6(req.body);

        if (!result.success) {
            return res.json({
                ok: false,
                reason: "The M6 capture did not succeed, so there is no payload to read.",
                milestone_error: result
            });
        }

        if (!result.payload) {
            return res.json({ ok: false, reason: "M6 succeeded but returned no payload." });
        }

        return res.json(buildFieldMap(result.payload));

    } catch (error) {

        console.error(error);

        return res.status(500).json({ ok: false, error: error.message });

    }

});

/**
 * TEMPORARY — SCHEMA DISCOVERY ONLY. DELETE WHEN M7 IS COMPLETE.
 *
 * POST /debug/collision-map — shows WHY (account, bureau) pairs collide, with the
 * evidence needed to decide whether they resolve deterministically or must stay
 * manual review. Reuses M6. Read-only.
 */
app.post("/debug/collision-map", async (req, res) => {

    if (!debugGateOpen(req, res, "/debug/collision-map")) return;

    try {
        const result = await runMilestone6(req.body);

        // On a collision, M6 returns success:false — but as of the EXTRACTION_FAILED
        // fix it now carries the RAW PAYLOAD on that failed path (a failure that
        // discards its evidence cannot be diagnosed). We read the payload REGARDLESS
        // of success: this endpoint exists to inspect exactly the failed case.
        const payload = result?.payload ?? null;

        if (!payload) {
            return res.json({ ok: false, reason: "No raw payload on the M6 result.", milestone_error: result });
        }

        return res.json(buildCollisionMap(payload));

    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: error.message });
    }

});

app.get("/debug/routes", (req, res) => {

    if (!debugGateOpen(req, res, "/debug/routes")) return;

    const routes = app._router.stack
        .filter((layer) => layer.route)
        .map((layer) => ({
            method: Object.keys(layer.route.methods)[0].toUpperCase(),
            path: layer.route.path
        }));

    res.json({ count: routes.length, routes });

});

app.listen(PORT, () => {

    console.log(`Business Trappers AI Credit Processor listening on port ${PORT}`);

    // ---- ENUMERATE THE ACTUAL ROUTER. DO NOT ASSERT. ----------------------
    //
    // The previous version of this log printed the word "REGISTERED" from a STRING
    // LITERAL, branching only on DEBUG_TOKEN. It would have printed "REGISTERED"
    // for a route that had never been written — and it did exactly that, while
    // Express was returning "Cannot POST /debug/skeleton-node".
    //
    // That is the same defect as `IDENTITY SOURCE: CRC client profile
    // (authoritative)` printed from a string literal, and it has the same cost:
    // A GUARANTEE THAT IS ASSERTED RATHER THAN ENFORCED IS WORSE THAN NONE,
    // BECAUSE IT STOPS PEOPLE LOOKING.
    //
    // So we read the router stack — the same source /debug/routes reads — and
    // print what is genuinely mounted in THIS process.
    const registered = app._router.stack
        .filter((layer) => layer.route)
        .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

    console.log(`Routes mounted (${registered.length}):`);

    for (const route of registered) {
        console.log(`  ${route}`);
    }

    const REQUIRED_DEBUG_ROUTES = [
        "POST /debug/skeleton-node",
        "POST /debug/liability-map",
        "POST /debug/field-map",
        "POST /debug/collision-map",
        "GET /debug/routes",
    ];

    const missing = REQUIRED_DEBUG_ROUTES.filter((r) => !registered.includes(r));

    if (missing.length > 0) {
        console.error(
            `DEBUG ROUTES MISSING FROM THIS BUILD: ${missing.join(", ")}. ` +
            `The deployed server.js is NOT the current one. Express will answer ` +
            `"Cannot POST" for these paths.`
        );
    } else {
        console.log("All debug routes are mounted.");
    }

    console.log(
        process.env.DEBUG_TOKEN
            ? "DEBUG_TOKEN: set."
            : "DEBUG_TOKEN: NOT SET — debug routes will return 404 to every caller."
    );
});
