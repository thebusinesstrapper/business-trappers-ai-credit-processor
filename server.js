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
import { extractSkeletonNode } from "./src/debugSkeleton.js"; // TEMPORARY — remove with M7

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

    // State it at boot. A 404 from a debug route is ambiguous by design; this line
    // removes the ambiguity from the one place we can read without leaking it.
    console.log(
        process.env.DEBUG_TOKEN
            ? "Debug routes: REGISTERED and DEBUG_TOKEN is set (/debug/routes, /debug/skeleton-node)."
            : "Debug routes: REGISTERED but DEBUG_TOKEN is NOT SET — they will return 404 to every caller."
    );

});
