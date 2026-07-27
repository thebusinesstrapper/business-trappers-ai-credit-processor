-- 007_complete_rashad_no_eligible_negatives.sql
--
-- ONE-TIME, MANUAL completion for a single client whose report is clean of
-- negative tradelines. Rashad Muhammad (CRC 28): M7 succeeded, lettersOk true,
-- letterCount 0, and manual review of his CreditHero report confirms the report
-- is clean except for USAA/Experian INQUIRIES — no negative tradelines requiring
-- dispute letters.
--
-- WHY MANUAL, NOT AUTOMATED: the four withheld items were surfaced with
-- itemType null and NO structural inquiry indicator (stable_item_key "bt_iq_" /
-- signature tier "I0") in the runtime job JSON, so the processor cannot yet
-- POSITIVELY classify them as inquiries. A code rule that completed on a
-- Bureau-Fidelity withhold alone would be a guess (it could hide a withheld
-- negative tradeline). This completion is therefore authorized by a HUMAN who
-- reviewed the actual report — not by the processor.
--
-- SAFETY:
--   * Keyed on crc_client_id = '28' (PK). Never name/loose matching.
--   * Sets exactly the completion end-state: process_complete, complete state,
--     Manual Review cleared, negative_items_remaining 0. No round change
--     (current_round is untouched — completion by this reason never advances a
--     round). No M8 / no letters / no delivery.
--   * UPDATE ... WHERE cannot insert, so no duplicate record is possible.
--   * Run the PREVIEW first; only run the UPDATE if the row is the expected one
--     and is not already complete.

-- ============================ PREVIEW (read-only) ============================
select
    crc_client_id,
    client_display_name,
    process_complete,
    processing_state,
    current_round,
    negative_items_remaining,
    manual_review_active,
    block_reason
from public.client_state
where crc_client_id = '28';

-- ============================ COMPLETION (writes) ===========================
-- Mirrors clientMemory.markProcessComplete(reason = 'no_eligible_negative_items'):
-- process_complete, processing_state 'complete', Manual Review cleared,
-- negative_items_remaining 0, last_successful_processing_at now. current_round is
-- deliberately NOT touched. Uncomment to execute.
--
-- begin;
--
-- update public.client_state set
--     process_complete = true,
--     processing_state = 'complete',
--     negative_items_remaining = 0,
--     manual_review_active = false,
--     manual_review_stage = null,
--     manual_review_reason = null,
--     manual_review_flagged_at = null,
--     block_reason = 'no_eligible_negative_items',
--     last_successful_processing_at = now()
--   where crc_client_id = '28'
--     and process_complete = false      -- idempotent: no-op if already complete
--   returning crc_client_id, process_complete, processing_state,
--             current_round, negative_items_remaining, manual_review_active;
--
-- -- Expect UPDATE 1, current_round unchanged. If UPDATE 0, the row is already
-- -- complete or the id is wrong — STOP and investigate; do not insert.
-- commit;
