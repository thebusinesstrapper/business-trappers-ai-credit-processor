import test from "node:test";
import assert from "node:assert/strict";
import { loadProductionRoundContext } from "./productionRoundContext.js";

for (const round of [3, 4, 5]) {
    test(`name-targeted delivery loads verified CRC context for round ${round}`, async () => {
        const itemHistory = { existing: { rounds: [1, 2] } };
        const result = await loadProductionRoundContext("188", async id => {
            assert.equal(id, "188");
            return { current_round: String(round) };
        }, async id => {
            assert.equal(id, "188");
            return { ok: true, itemHistory };
        });
        assert.deepEqual(result, { currentRoundFloor: round, itemHistory });
    });
}

test("missing state or unreadable history cannot default to round one", async () => {
    assert.equal(await loadProductionRoundContext("188", async () => null, async () => ({ ok: true })), null);
    assert.equal(await loadProductionRoundContext("188", async () => ({ current_round: 3 }), async () => ({ ok: false })), null);
});
