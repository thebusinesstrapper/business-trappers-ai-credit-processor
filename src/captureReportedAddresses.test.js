import test from "node:test";
import assert from "node:assert/strict";
import { captureReportedAddresses, parsePiTableCore } from "./captureReportedAddresses.js";

test("captures addresses from the rendered report", async () => {
    const addresses = [{ value: "EXAMPLE ADDRESS", bureaus: ["experian"], raw: "EXAMPLE ADDRESS" }];
    const page = {
        evaluate: async (parser) => {
            assert.equal(parser, parsePiTableCore);
            return { ok: true, addresses };
        },
    };
    assert.deepEqual(await captureReportedAddresses(page), { ok: true, addresses });
});

test("preserves the rendered report parser failure", async () => {
    const failure = { ok: false, stage: "locate_table", reason: "Personal Information table not found." };
    assert.deepEqual(await captureReportedAddresses({ evaluate: async () => failure }), failure);
});

test("routes browser evaluation errors to address capture failure", async () => {
    const page = { evaluate: async () => { throw new Error("Report page closed"); } };
    assert.deepEqual(await captureReportedAddresses(page), {
        ok: false,
        stage: "evaluate",
        reason: "Reading the rendered Credit Hero report failed: Report page closed",
    });
});
