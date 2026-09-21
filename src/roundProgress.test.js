import assert from "node:assert/strict";
import {
    calculateLiveRoundProgress,
    calculateHistoricalRoundProgress,
} from "./roundProgress.js";

const prior = [
    { stable_item_key: "a", first_round_disputed: 1, most_recent_round_disputed: 1, strategies_used: ["s1"] },
    { stable_item_key: "b", first_round_disputed: 1, most_recent_round_disputed: 1, strategies_used: ["s1"] },
];

const live = calculateLiveRoundProgress({
    roundCompleted: 2,
    priorHistoryRows: prior,
    currentItemKeys: ["a", "c"],
    chainItems: [
        { stableItemKey: "a", round: 2, chainComplete: true, strategy: { strategy: "s2" }, reason: { reason: "r2" } },
        { stableItemKey: "c", round: 2, chainComplete: true, strategy: { strategy: "s2" }, reason: { reason: "r2" } },
    ],
});

assert.equal(live.ok, true);
assert.equal(live.priorDisputedItems, 2);
assert.equal(live.deletedItems, 1);
assert.equal(live.stillReportingItems, 1);
assert.equal(live.newlyDisputedItems, 1);
assert.equal(live.disputedThisRound, 2);
assert.equal(live.unknownItems, 0);

const historical = calculateHistoricalRoundProgress([
    { stable_item_key: "a", first_round_disputed: 1, most_recent_round_disputed: 2, strategies_used: ["s1", "s2"] },
    { stable_item_key: "b", first_round_disputed: 1, most_recent_round_disputed: 1, strategies_used: ["s1"] },
    { stable_item_key: "c", first_round_disputed: 2, most_recent_round_disputed: 2, strategies_used: ["s2"] },
], 2);

assert.equal(historical.ok, true);
assert.equal(historical.priorDisputedItems, 2);
assert.equal(historical.stillReportingItems, 1);
assert.equal(historical.deletedItems, 0);
assert.equal(historical.unknownItems, 1);
assert.equal(historical.newlyDisputedItems, 1);
assert.equal(historical.disputedThisRound, 2);
assert.equal(historical.comparisonComplete, false);

console.log("roundProgress tests passed");
