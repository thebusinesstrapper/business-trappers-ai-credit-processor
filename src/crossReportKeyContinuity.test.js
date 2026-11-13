import assert from "node:assert/strict";
import { verifyCrossReportKeyContinuity } from "./crossReportKeyContinuity.js";
const resolved = { extraction_ok: true, key_resolution: {accounts:{minted:0,ambiguous:[]},tradelines:{minted:0,ambiguous:[]}} };
assert.equal(verifyCrossReportKeyContinuity(resolved).ok,true);
assert.equal(verifyCrossReportKeyContinuity({...resolved,extraction_ok:false}).ok,false);
assert.equal(verifyCrossReportKeyContinuity({...resolved,key_resolution:{...resolved.key_resolution,tradelines:{minted:1,ambiguous:[]}}}).reason,"unresolved_cross_report_identity");
console.log("Cross-report key continuity checks passed");
