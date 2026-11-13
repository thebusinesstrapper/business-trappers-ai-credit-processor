import assert from "node:assert/strict";
import { selectUnambiguousReportPayload } from "./reportPayloadSelection.js";

const candidate = (responseStartedAt, looksLikeCreditReport = true) => ({responseStartedAt, looksLikeCreditReport, payload: {id: responseStartedAt}});
assert.equal(selectUnambiguousReportPayload([candidate(10)], 20).reason, "no_fresh_report_payload");
assert.equal(selectUnambiguousReportPayload([candidate(10),candidate(21)], 20).report.payload.id, 21);
assert.equal(selectUnambiguousReportPayload([candidate(21),candidate(22)], 20).reason, "ambiguous_report_payloads");
assert.equal(selectUnambiguousReportPayload([candidate(21,false)], 20).reason, "no_fresh_report_payload");
assert.equal(selectUnambiguousReportPayload(null, 20).reason, "invalid_capture_context");
console.log("Report payload selection tests passed");
