-- ============================================================================
-- Business Trappers AI Credit Processor
-- Migration: report_acquisition_intents
--
-- The idempotency guard for report acquisition.
--
-- Report acquisition is the FIRST IRREVERSIBLE ACTION this system performs.
-- Every guardrail written before it assumed re-runs were free. They are not.
--
-- A run that submits an order and then crashes before writing memory leaves no
-- record. The next run sees nothing, re-evaluates, finds the free option
-- available, and ORDERS AGAIN. Two entitlements consumed for one cycle.
--
-- This table exists to make that impossible.
--
-- Governed by: Business Trappers Report Acquisition Authority v1.0, §5 and §6.
-- ============================================================================

create table if not exists report_acquisition_intents (
    id                      uuid primary key default gen_random_uuid(),

    -- Authoritative client key. Never a display name.
    crc_client_id           text        not null,
    processing_run_id       text        not null,

    -- What we intended to obtain.
    requested_report_type   text        not null,
    credit_hero_option_id   text,           -- e.g. productBuyNew_01
    observed_cost           numeric(10,2),  -- the cost we AFFIRMATIVELY READ. NULL = unknown, never assumed free.

    -- The decision engine's recommendation, recorded verbatim.
    decision                text        not null,

    status                  text        not null,

    created_at              timestamptz not null default now(),
    submitted_at            timestamptz,    -- NULL = submission outcome UNKNOWN. See below.
    resolved_at             timestamptz,

    -- Proof of effect. A report we did not obtain must not look like one we did.
    report_date_before      date,
    report_date_after       date,

    failure_reason          text,
    browserbase_session_id  text,           -- replay URL is derivable; keeps the audit trail navigable
    metadata                jsonb,

    constraint report_acquisition_intents_status_check check (
        status in (
            'intent_created',      -- written BEFORE submission. Unresolved.
            'submission_started',  -- we began interacting.       Unresolved.
            'submitted',           -- click landed, effect NOT yet confirmed. Unresolved.
            'report_available',    -- POSITIVELY CONFIRMED new report. Resolved.
            'failed',              -- confirmed failure.               Resolved.
            'manual_review',       -- handed to a human.               Resolved.
            'cancelled'            -- abandoned before submission.     Resolved.
        )
    ),

    constraint report_acquisition_intents_decision_check check (
        decision in (
            'submit_free_report',
            'no_action_required',
            'free_report_not_yet_available',
            'manual_review'
        )
    )
);

-- ============================================================================
-- THE IDEMPOTENCY GUARD
--
-- Only ONE unresolved acquisition intent may exist per client. Full stop.
--
-- NOTE THE SUBTLETY, because it is the whole point:
--
--   The unique index is on crc_client_id ALONE -- deliberately NOT on
--   (crc_client_id, processing_run_id).
--
--   A retry gets a NEW processing_run_id. If the index included the run id, a
--   crashed run's orphaned intent would NOT block the retry -- the retry would
--   insert happily under its new run id and order a second report. The guard
--   would look correct and do nothing.
--
--   Keying on the client alone means a crashed run's intent BLOCKS the next
--   run, which is exactly what we want: a hard stop into manual_review.
--
-- 'submitted' is UNRESOLVED on purpose. A click having landed is not proof that
-- a report was obtained. Per the Acquisition Authority: "Do not mark the intent
-- resolved merely because a click occurred. Resolution requires positive
-- confirmation that the new report became available."
--
-- We would rather stall a client than order twice. A stalled cycle costs one
-- processing round. A duplicate order spends an entitlement that cannot be
-- returned.
-- ============================================================================

create unique index if not exists one_unresolved_intent_per_client
    on report_acquisition_intents (crc_client_id)
    where status in ('intent_created', 'submission_started', 'submitted');

-- Audit / lookup support.
create index if not exists idx_acquisition_intents_client_created
    on report_acquisition_intents (crc_client_id, created_at desc);

create index if not exists idx_acquisition_intents_run
    on report_acquisition_intents (processing_run_id);

comment on table report_acquisition_intents is
    'Idempotency guard and audit trail for Credit Hero report acquisition. '
    'An unresolved intent is a HARD STOP: the previous run may or may not have '
    'ordered, and we do not find out by trying again.';

comment on column report_acquisition_intents.submitted_at is
    'NULL after an intent is created means the submission outcome is UNKNOWN. '
    'It does NOT mean "did not submit". A crashed run leaves exactly this state, '
    'and it must route to manual_review -- never to a retry.';

comment on column report_acquisition_intents.observed_cost is
    'The cost AFFIRMATIVELY READ from the selected option. NULL means the cost '
    'could not be determined -- which is never the same as free.';
