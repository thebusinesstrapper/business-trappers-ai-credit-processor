import assert from "node:assert/strict";
import { calculateLiveRoundProgress } from "./roundProgress.js";

const prior = [
    { stable_item_key: "a", first_round_disputed: 1, most_recent_round_disputed: 1, strategies_used: ["s1"] },
    { stable_item_key: "b", first_round_disputed: 1, most_recent_round_disputed: 1, strategies_used: ["s1"] },
];

const firstRound = calculateLiveRoundProgress({
    roundCompleted: 1,
    priorHistoryRows: [],
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
    currentInventoryVerified: true,
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
assert.equal(live.comparisonComplete, true);

const unverifiedPartial = calculateLiveRoundProgress({
    roundCompleted: 2,
    priorHistoryRows: prior,
    currentItemKeys: ["a"],
    chainItems: [],
});
assert.equal(unverifiedPartial.ok, true);
assert.equal(unverifiedPartial.comparisonComplete, false);
assert.equal(unverifiedPartial.deletedItems, null);
assert.equal(unverifiedPartial.unknownItems, 2);

const legacyNoBaseline = calculateLiveRoundProgress({
    roundCompleted: 3,
    priorHistoryRows: [],
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


// Missing or malformed inventory cannot establish deletion outcomes.
const missingInventory = calculateLiveRoundProgress({
    roundCompleted: 2,
    priorHistoryRows: prior,
    chainItems: [],
});
assert.equal(missingInventory.ok, false);
assert.equal(missingInventory.reason, "current_inventory_unverified");

const malformedInventory = calculateLiveRoundProgress({
    roundCompleted: 2,
    priorHistoryRows: prior,
    currentItemKeys: ["a", null],
    chainItems: [],
});
assert.equal(malformedInventory.ok, false);
assert.equal(malformedInventory.reason, "current_inventory_unverified");

console.log("roundProgress tests passed");
