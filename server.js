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
app.get("/debug/routes", (req, res) => {

    const token = process.env.DEBUG_TOKEN;

    // Fail closed. With no token configured, this route does not exist.
    if (!token || req.get("x-debug-token") !== token) {
        return res.status(404).json({ error: "Not found" });
    }

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

});
