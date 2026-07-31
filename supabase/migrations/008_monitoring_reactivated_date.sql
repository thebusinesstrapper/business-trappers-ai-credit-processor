-- ============================================================================
-- Business Trappers AI Credit Processor
-- Migration: 008_monitoring_reactivated_date
--
-- ONE column on public.client_state to record WHEN a client's CreditHero
-- monitoring was positively confirmed active again after a period of being
-- Credit Monitoring Inactive.
--
-- WHY THIS COLUMN
--
-- The daily inactive-client recheck sweep performs a read-only CreditHero check
-- of every client stored inactive. When the live landing is a positively
-- confirmed healthy member dashboard, the sweep reconciles the client back to
-- active. monitoring_reactivated_date is the durable record of that transition:
--   - set ONCE, on the inactive -> active transition,
--   - preserved on every later run (never overwritten),
-- so "reactivated three days ago" stays visible as three days, not today's date
-- rewritten three times.
--
-- WHY NOT REUSE AN EXISTING COLUMN
--
-- last_credit_hero_check_at answers "when did we last look" and is stamped on
-- every recheck (active or not). last_report_date_used answers "which report did
-- we last process". Neither means "when did monitoring come back". Overloading
-- either would erase a distinction the recovery path depends on.
--
-- last_dispute_date / next_eligible_date are round-timing fields and must not be
-- repurposed to carry a reactivation timestamp.
--
-- CONFIRMED ABSENT before finalizing, so no `IF NOT EXISTS` is silently skipping
-- a same-named column of a different type.
--
-- NOTHING ELSE CHANGES. No existing column is altered, renamed, retyped or
-- dropped; no existing constraint is touched. The primary key, the current_round
-- 1..6 range, the processing_state and credit_hero_access_state allowed-value
-- checks, and the negative_items_remaining non-negative check are left exactly
-- as they are.
-- ============================================================================


alter table public.client_state
    -- WHEN monitoring was confirmed active again (inactive -> active). Nullable:
    -- a client that has never been reactivated has no such date, which is a
    -- meaningfully different state from "reactivated on some date". Set once by
    -- clientMemory.recordMonitoringReactivated() on the transition, and preserved
    -- thereafter (that writer never overwrites a non-null value).
    add column monitoring_reactivated_date timestamptz;


-- Verification (run manually; not part of the migration):
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'client_state'
--     and column_name = 'monitoring_reactivated_date';
