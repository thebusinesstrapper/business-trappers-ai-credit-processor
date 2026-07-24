-- ============================================================================
-- Business Trappers AI Credit Processor
-- Migration: 004_manual_review_columns
--
-- Four columns on public.client_state so a GENUINE Manual Review outcome
-- survives the run that produced it and can be read by the Google Sheets
-- dashboard.
--
-- Written against the verified live schema. All four names were confirmed
-- ABSENT before this was finalized, so no `IF NOT EXISTS` is silently skipping
-- a same-named column of a different type — the failure mode that makes a
-- speculative migration dangerous.
--
-- WHY NOT REUSE block_reason.
--
-- block_reason is already occupied by NON-manual-review markers. The processor
-- writes WAITING_FOR_FREE_REPORT and CREDENTIALS_OR_AUTH_FAILED into it to mark
-- clients who are waiting or blocked but perfectly healthy. Overloading it here
-- would make "waiting on a bureau" and "broken, a human must act" the same
-- value in the same column — which is exactly the distinction the Manual Review
-- Queue exists to draw.
--
-- NOTHING ELSE CHANGES. No existing column is altered, renamed, retyped or
-- dropped. No existing constraint is touched. The primary key, the
-- current_round 1..6 range, the processing_state and credit_hero_access_state
-- allowed-value checks, and the negative_items_remaining non-negative check are
-- all left exactly as they are.
-- ============================================================================


alter table public.client_state
    -- Is this client CURRENTLY awaiting human action?
    --
    -- NOT NULL DEFAULT false is deliberate and load-bearing. Every existing row
    -- becomes an explicit `false` the moment this runs, which is what lets the
    -- application's compare-and-swap work immediately:
    --
    --     update ... set manual_review_active = true, manual_review_flagged_at = now()
    --     where crc_client_id = $1 and manual_review_active = false
    --
    -- A nullable column would leave existing rows at NULL, `= false` would match
    -- nothing, and no client could ever be flagged. Nullable also invites a
    -- third state — "we do not know whether a human is needed" — which is not a
    -- thing this system should be able to represent.
    add column manual_review_active boolean not null default false,

    -- WHERE it stopped: the processor's own stage string (eligibility_blocked,
    -- identity, credentials_or_auth_failed, ...) or the classification when no
    -- stage was reported. Nullable: a cleared client has no stage.
    add column manual_review_stage text,

    -- WHY it stopped, SANITIZED BEFORE IT ARRIVES. The application redacts long
    -- digit runs and the consumer's own name, and caps the length, before this
    -- is written. No report contents, no full account numbers, no letter text.
    add column manual_review_reason text,

    -- WHEN it first entered manual review. Set once, on the false -> true
    -- transition, and preserved on subsequent failing runs. A client failing the
    -- same way for five days must show that it has been stuck for five days, not
    -- today's date five times over.
    add column manual_review_flagged_at timestamptz;


comment on column public.client_state.manual_review_active is
    'True while this client requires human action. Set by the queue only on an '
    'approved, non-diagnostic run; cleared automatically by any later run that '
    'completes without needing a human. Diagnostic runs, submitApproved=false '
    'runs, and runs without operational routing approval never write it.';

comment on column public.client_state.manual_review_flagged_at is
    'When manual review was ENTERED, not when it was last observed. Preserved '
    'across repeated failures so queue age is meaningful.';

comment on column public.client_state.manual_review_reason is
    'Sanitized at the application before storage: long digit runs and the '
    'client name are redacted and the text is capped. Never report contents.';


-- ============================================================================
-- DELIBERATELY NOT INCLUDED.
--
-- No index. The dashboard endpoint pages the whole table by updated_at and
-- filters in the Apps Script, so an index on manual_review_active would not be
-- consulted. It can be added later if a filtered query ever appears.
--
-- No resolution columns. Assigned To, Resolution Status, Resolution Notes and
-- Date Resolved live in the Google Sheet as human-owned columns. Mirroring them
-- into Supabase would create two sources of truth for the same decision and
-- give the sync something it could overwrite.
-- ============================================================================
