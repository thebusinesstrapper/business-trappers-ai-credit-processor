import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/014_seven_round_lifecycle.sql", import.meta.url), "utf8");

const expected = [
  ["client_state", "client_state_current_round_range", "current_round BETWEEN 1 AND 7"],
  ["item_dispute_history", "item_history_first_round_range", "first_round_disputed BETWEEN 1 AND 7"],
  ["item_dispute_history", "item_history_most_recent_round_range", "most_recent_round_disputed BETWEEN 1 AND 7"],
  ["item_round_outcomes", "item_round_outcomes_observed_round_check", "observed_round BETWEEN 1 AND 7"],
  ["item_round_outcomes", "item_round_outcomes_prior_round_disputed_check", "prior_round_disputed BETWEEN 1 AND 7"],
  ["round_item_progress", "round_item_progress_round_completed_check", "round_completed BETWEEN 1 AND 7"],
  ["processing_run_history", "run_history_round_attempted_range", "round_attempted BETWEEN 1 AND 7"],
  ["processing_run_history", "run_history_round_completed_range", "round_completed BETWEEN 1 AND 7"],
];

test("seven-round migration covers all known round constraints including processing history", () => {
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/m);
  for (const [table, constraint, expression] of expected) {
    assert.ok(sql.includes(`ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${constraint};`), `missing drop: ${constraint}`);
    assert.ok(sql.includes(`ALTER TABLE public.${table} ADD CONSTRAINT ${constraint} CHECK (`), `missing replacement: ${constraint}`);
    assert.ok(sql.includes(expression), `missing seven-round bound: ${constraint}`);
  }
});
