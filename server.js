import express from "express";
import dotenv from "dotenv";
import { runMilestone1 } from "./src/milestone1.js";

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

app.listen(PORT, () => {

    console.log(`Business Trappers AI Credit Processor listening on port ${PORT}`);

});
