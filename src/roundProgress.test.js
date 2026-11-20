import assert from "node:assert/strict";
import { calculateLiveRoundProgress } from "./roundProgress.js";

const prior = [
    { stable_item_key: "a", first_round_disputed: 1, most_recent_round_disputed: 1, strategies_used: ["s1"] },
    { stable_item_key: "b", first_round_disputed: 1, most_recent_round_disputed: 1, strategies_used: ["s1"] },
];

const firstRound = calculateLiveRoundProgress({
    roundCompleted: 1,
    priorHistoryRows: [],
    hasCompleteReportInventory: true,
    currentItemKeys: ["a", "b", "c"],
    chainItems: [
        { stableItemKey: "a", round: 1, chainComplete: true, strategy: { strategy: "s1" }, reason: { reason: "r1" } },
        { stableItemKey: "b", round: 1, chainComplete: true, strategy: { strategy: "s1" }, reason: { reason: "r1" } },
    ],
});
assert.equal(firstRound.ok, true);
assert.equal(firstRound.disputedThisRound, 2);
assert.equal(firstRound.comparisonComplete, false);
assert.equal(firstRound.deletedItems, null);

const live = calculateLiveRoundProgress({
    roundCompleted: 2,
    priorHistoryRows: prior,
    hasCompleteReportInventory: true,
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
assert.equal(live.comparisonComplete, true);

const legacyNoBaseline = calculateLiveRoundProgress({
    roundCompleted: 3,
    priorHistoryRows: [],
    hasCompleteReportInventory: true,
    currentItemKeys: ["x", "y"],
    chainItems: [
        { stableItemKey: "x", round: 3, chainComplete: true, strategy: { strategy: "s3" }, reason: { reason: "r3" } },
    ],
});

assert.equal(legacyNoBaseline.ok, true);
assert.equal(legacyNoBaseline.disputedThisRound, 1);
assert.equal(legacyNoBaseline.priorDisputedItems, null);
assert.equal(legacyNoBaseline.deletedItems, null);
assert.equal(legacyNoBaseline.stillReportingItems, null);
assert.equal(legacyNoBaseline.newlyDisputedItems, null);
assert.equal(legacyNoBaseline.comparisonComplete, false);

console.log("roundProgress tests passed");

const missingInventory = calculateLiveRoundProgress({
    roundCompleted: 2,
    priorHistoryRows: prior,
    currentItemKeys: [],
    chainItems: [],
});
assert.equal(missingInventory.comparisonComplete, false);
assert.equal(missingInventory.deletedItems, null);
