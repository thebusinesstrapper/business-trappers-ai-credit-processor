import assert from "node:assert/strict";
import { evaluateInactiveMessageGate } from "./inactiveMessageGate.js";

const oldNotice = "2026-08-25T08:00:00Z";

// Stale inactive observation must lose to a newer reactivation.
let g = evaluateInactiveMessageGate({
  credit_hero_access_state: "active",
  last_credit_hero_check_at: "2026-09-01T08:15:10Z",
  monitoring_reactivated_date: "2026-09-01T08:15:10Z",
  inactive_notice_sent_at: oldNotice,
}, "2026-09-01T07:20:00Z");
assert.equal(g.allow, false);
assert.equal(g.reason, "newer_reactivation_supersedes_inactive_confirmation");

// A newer active check also suppresses even if reactivation timestamp is old.
g = evaluateInactiveMessageGate({
  credit_hero_access_state: "active",
  last_credit_hero_check_at: "2026-09-01T08:15:10Z",
  monitoring_reactivated_date: "2026-08-20T08:00:00Z",
  inactive_notice_sent_at: oldNotice,
}, "2026-09-01T07:20:00Z");
assert.equal(g.allow, false);
assert.equal(g.reason, "newer_active_check_supersedes_inactive_confirmation");

// Genuine new lapse after a prior reactivation is allowed, but begins a new notice episode.
g = evaluateInactiveMessageGate({
  credit_hero_access_state: "active",
  last_credit_hero_check_at: "2026-08-20T08:00:00Z",
  monitoring_reactivated_date: "2026-08-20T08:00:00Z",
  inactive_notice_sent_at: "2026-08-10T08:00:00Z",
  inactive_reminder_sent_at: null,
}, "2026-09-01T09:00:00Z");
assert.equal(g.allow, true);
assert.equal(g.newInactiveEpisode, true);

// Continuous inactive episode with no newer active observation remains allowed.
g = evaluateInactiveMessageGate({
  credit_hero_access_state: "inactive",
  last_credit_hero_check_at: "2026-09-01T07:00:00Z",
  inactive_notice_sent_at: oldNotice,
}, "2026-09-01T07:20:00Z");
assert.equal(g.allow, true);
assert.equal(g.newInactiveEpisode, false);

// No proof timestamp: fail closed, no client message.
g = evaluateInactiveMessageGate({}, null);
assert.equal(g.allow, false);

console.log("inactiveMessageGate race tests passed");
