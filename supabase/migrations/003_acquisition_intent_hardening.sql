-- ============================================================================
-- Business Trappers AI Credit Processor
-- Migration: 003_acquisition_intent_hardening
--
-- Two defence-in-depth hardenings on the table created by
-- 002_report_acquisition_intents.sql. Neither changes the shape of that table,
-- neither drops or renames anything, and neither alters the behaviour of the
-- existing partial unique index (one_unresolved_intent_per_client), which
-- remains the authoritative concurrency guard.
--
-- Applied while the table holds ZERO rows, which is the cheapest possible
-- moment to add a CHECK constraint: no backfill, no validation scan, no risk
-- of an existing row failing the new predicate.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. A SUBMIT INTENT MAY ONLY EXIST FOR A POSITIVELY ZERO-COST OPTION.
--
-- WHY THIS IS CONDITIONAL AND NOT A BLANKET CHECK.
--
-- report_acquisition_intents records EVERY acquisition decision, not only the
-- ones that submit. A 'free_report_not_yet_available' row legitimately carries
-- the PAID option's price in observed_cost, and a 'manual_review' row may carry
-- NULL because the cost could not be determined at all. A blanket
-- `observed_cost = 0` would reject both of those valid, safety-relevant rows.
--
-- So the constraint fires only on the one decision that spends an entitlement:
-- 'submit_free_report'. For that decision, and only that decision, the cost we
-- AFFIRMATIVELY READ must be exactly zero.
--
-- ###########################################################################
-- # WHY THE `observed_cost IS NOT NULL` TERM IS LOAD-BEARING.               #
-- #                                                                         #
-- # A CHECK constraint in PostgreSQL is SATISFIED when its expression       #
-- # evaluates to TRUE **or to NULL**. Only an explicit FALSE rejects a row. #
-- #                                                                         #
-- # The obvious form of this rule is therefore silently broken:             #
-- #                                                                         #
-- #     check (decision <> 'submit_free_report' or observed_cost = 0)       #
-- #                                                                         #
-- # For (decision = 'submit_free_report', observed_cost = NULL):            #
-- #                                                                         #
-- #     decision <> 'submit_free_report'  ->  FALSE                         #
-- #     observed_cost = 0                 ->  NULL  (NULL never equals 0)   #
-- #     FALSE OR NULL                     ->  NULL                          #
-- #     CHECK sees NULL                   ->  ROW IS ACCEPTED               #
-- #                                                                         #
-- # That is the exact row the constraint exists to block: a submission      #
-- # intent whose cost was never established. The constraint would have      #
-- # looked correct in review and done nothing in the one case that matters. #
-- #                                                                         #
-- # `observed_cost IS NOT NULL` cannot itself return NULL -- IS NOT NULL    #
-- # always yields TRUE or FALSE -- so it forces the branch to a definite    #
-- # FALSE:                                                                  #
-- #                                                                         #
-- #     FALSE AND NULL   ->  FALSE                                          #
-- #     FALSE OR  FALSE  ->  FALSE   ->  ROW IS REJECTED                    #
-- #                                                                         #
-- # This is the same principle the application already applies to this      #
-- # column: absence of evidence of cost is never evidence of no cost. Per   #
-- # the 002 column comment -- "NULL means the cost could not be determined  #
-- # -- which is never the same as free."                                    #
-- ###########################################################################
--
-- This duplicates a rule already enforced in application code
-- (acquisitionDecision.js requires freeOption.cost === 0, and orderFreeReport.js
-- re-verifies against the live DOM immediately before the click). That
-- duplication is the point: the database cannot be refactored around.
-- ---------------------------------------------------------------------------
alter table report_acquisition_intents
    add constraint report_acquisition_intents_submit_is_free
    check (
        decision <> 'submit_free_report'
        or (
            observed_cost is not null
            and observed_cost = 0
        )
    );

comment on constraint report_acquisition_intents_submit_is_free
    on report_acquisition_intents is
    'A submit_free_report intent must carry an affirmatively read cost of 0. '
    'The explicit IS NOT NULL term is load-bearing: a CHECK constraint is '
    'satisfied by TRUE or NULL, so the shorter form '
    '(decision <> ... or observed_cost = 0) evaluates to NULL for an '
    'undetermined cost and would ACCEPT the row. An undetermined cost is never '
    'the same as free.';


-- ---------------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY — DEFENCE IN DEPTH.
--
-- THIS DOES NOT AFFECT THE APPLICATION.
--
-- src/supabase.js connects with SUPABASE_SERVICE_ROLE_KEY, so PostgREST
-- executes as the service_role, which is BYPASSRLS. Every read and write this
-- server performs is unaffected by the policies below -- there are none, and it
-- would not matter if there were.
--
-- WHAT IT DOES PROTECT AGAINST.
--
-- A table sitting in the public schema is reachable through the SAME PostgREST
-- endpoint by the anon key, subject only to GRANTs. With RLS enabled and no
-- permissive policy, anon and authenticated read zero rows and write nothing.
-- If the anon key is ever exposed, embedded in a client, or handed to an edge
-- function, this is the only thing standing between the internet and a table
-- keyed by crc_client_id.
--
-- Enabling RLS with no policies is deliberate. A policy would be a permission;
-- the correct posture for a table only the server touches is no permission at
-- all, plus the service_role bypass the server already relies on.
-- ---------------------------------------------------------------------------
alter table report_acquisition_intents enable row level security;

comment on table report_acquisition_intents is
    'Idempotency guard and audit trail for Credit Hero report acquisition. '
    'An unresolved intent is a HARD STOP: the previous run may or may not have '
    'ordered, and we do not find out by trying again. '
    'RLS is enabled with no policies: server-side access is via service_role '
    '(which bypasses RLS); anon and authenticated have no access by design.';


-- ============================================================================
-- KNOWN TECHNICAL DEBT, DELIBERATELY NOT ADDRESSED HERE.
--
-- The client_state table's schema and RLS posture are NOT version-controlled in
-- this repository. client_state holds every client's processing state and is
-- read by the /dashboard-data endpoint, so its RLS posture is currently
-- unknown and unreviewable. Capturing it as a migration is worth doing and is
-- explicitly OUT OF SCOPE for this build.
-- ============================================================================
