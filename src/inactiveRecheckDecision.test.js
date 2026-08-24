import assert from "node:assert/strict";
import { decideInactiveRecheck, RECHECK_ACTION } from "./inactiveRecheckDecision.js";
import { CH_LANDING_STATE } from "./creditHeroLandingState.js";

const active = { state: CH_LANDING_STATE.HEALTHY_MEMBER_DASHBOARD };

assert.equal(decideInactiveRecheck({ storedState: { last_report_date_used: "2026-07-02" }, landing: active, liveReportDate: "2026-08-24" }).action, RECHECK_ACTION.REACTIVATED_ELIGIBLE);
assert.equal(decideInactiveRecheck({ storedState: { last_report_date_used: "2026-07-02" }, landing: active, liveReportDate: "2026-07-02" }).action, RECHECK_ACTION.REACTIVATED_WAITING);
assert.equal(decideInactiveRecheck({ storedState: { last_report_date_used: null }, landing: active, liveReportDate: "2026-08-24" }).action, RECHECK_ACTION.REACTIVATED_WAITING);
assert.equal(decideInactiveRecheck({ storedState: { last_report_date_used: "2026-07-02" }, landing: { state: CH_LANDING_STATE.PAYMENT_REQUIRED }, liveReportDate: "2026-08-24" }).action, RECHECK_ACTION.STILL_INACTIVE);
console.log("inactiveRecheckDecision tests passed");
