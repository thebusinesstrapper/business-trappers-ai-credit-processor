import test from "node:test";
import assert from "node:assert/strict";
import { captureReportedAddresses } from "./captureReportedAddresses.js";

test("rendered report DOM supplies bureau addresses without Copy As HTML", async () => {
    const addresses = [{ value: "EXAMPLE ADDRESS", bureaus: ["experian"], raw: "EXAMPLE ADDRESS" }];
    let clipboardLocatorUsed = false;
    const page = {
        evaluate: async (_fn, coreSource) => {
            assert.match(coreSource, /Personal Information table not found/);
            return { ok: true, addresses };
        },
        getByRole: () => { clipboardLocatorUsed = true; throw Error("Legacy control should not be used"); },
    };
    assert.deepEqual(await captureReportedAddresses(page), { ok: true, addresses });
    assert.equal(clipboardLocatorUsed, false);
});

test("unmatched DOM cannot be accepted as a successful empty address result", async () => {
    const page = {
        evaluate: async () => ({ ok: false, stage: "locate_table", reason: "Personal Information table not found." }),
        getByRole: () => ({
            or() { return this; },
            first() { return this; },
            async count() { return 0; },
        }),
        getByText: () => ({
            or() { return this; },
            first() { return this; },
        }),
    };
    const result = await captureReportedAddresses(page);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "locate");
    assert.match(result.reason, /Copy As HTML/);
});
