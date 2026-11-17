import assert from "node:assert/strict";
import { assessHistoricalEvidence } from "./historicalEvidenceGate.js";
const snap = (date, keys) => ({ verified: true, extractionComplete: true, reportDate: date, items: keys.map(stableItemKey => ({stableItemKey})) });
const snapshots = [snap("2026-09-15", ["a"]), snap("2026-10-16", ["a"])];
assert.equal(assessHistoricalEvidence({snapshots}).reason, "delivery_records_required");
assert.equal(assessHistoricalEvidence({snapshots, deliveryRecords:[{round:1,stableItemKey:"a",strategy:"S"}]}).reason, "unverified_delivery_records");
assert.equal(assessHistoricalEvidence({snapshots, deliveryRecords:[]}).ok, true);
assert.equal(assessHistoricalEvidence({snapshots:[snap("2026-09-15",["a"]),snap("2026-09-15",["a"])],deliveryRecords:[]}).ok,false);
console.log("Historical evidence gate tests passed");
