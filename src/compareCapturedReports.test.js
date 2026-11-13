import assert from "node:assert/strict";
import { compareCapturedReports } from "./compareCapturedReports.js";

assert.equal(compareCapturedReports(null, null, "169").reason, "verified_capture_required");
assert.equal(compareCapturedReports({ verifiedActive: true, reportedAddresses: [] }, null, "169").reason, "verified_capture_required");
assert.equal(compareCapturedReports(
    { verifiedActive: true, reportedAddresses: [], payload: {} },
    { verifiedActive: true, reportedAddresses: [], payload: {} },
    "169"
).reason, "prior_extraction_failed");
console.log("Captured report comparison guard tests passed");
