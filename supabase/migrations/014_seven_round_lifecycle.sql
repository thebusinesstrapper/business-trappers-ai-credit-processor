-- Prepare the seven-round lifecycle as one atomic migration.
-- Apply only during coordinated deployment after validation.
BEGIN;
ALTER TABLE public.client_state DROP CONSTRAINT IF EXISTS client_state_current_round_range;
ALTER TABLE public.client_state ADD CONSTRAINT client_state_current_round_range CHECK (current_round BETWEEN 1 AND 7);
ALTER TABLE public.item_dispute_history DROP CONSTRAINT IF EXISTS item_history_first_round_range;
ALTER TABLE public.item_dispute_history ADD CONSTRAINT item_history_first_round_range CHECK (first_round_disputed IS NULL OR first_round_disputed BETWEEN 1 AND 7);
ALTER TABLE public.item_dispute_history DROP CONSTRAINT IF EXISTS item_history_most_recent_round_range;
ALTER TABLE public.item_dispute_history ADD CONSTRAINT item_history_most_recent_round_range CHECK (most_recent_round_disputed IS NULL OR most_recent_round_disputed BETWEEN 1 AND 7);
ALTER TABLE public.item_round_outcomes DROP CONSTRAINT IF EXISTS item_round_outcomes_observed_round_check;
ALTER TABLE public.item_round_outcomes ADD CONSTRAINT item_round_outcomes_observed_round_check CHECK (observed_round BETWEEN 1 AND 7);
ALTER TABLE public.item_round_outcomes DROP CONSTRAINT IF EXISTS item_round_outcomes_prior_round_disputed_check;
ALTER TABLE public.item_round_outcomes ADD CONSTRAINT item_round_outcomes_prior_round_disputed_check CHECK (prior_round_disputed BETWEEN 1 AND 7);
ALTER TABLE public.round_item_progress DROP CONSTRAINT IF EXISTS round_item_progress_round_completed_check;
ALTER TABLE public.round_item_progress ADD CONSTRAINT round_item_progress_round_completed_check CHECK (round_completed BETWEEN 1 AND 7);
-- Keep processing history aligned with the seven-round lifecycle.
ALTER TABLE public.processing_run_history DROP CONSTRAINT IF EXISTS run_history_round_attempted_range;
ALTER TABLE public.processing_run_history ADD CONSTRAINT run_history_round_attempted_range CHECK (round_attempted BETWEEN 1 AND 7);
ALTER TABLE public.processing_run_history DROP CONSTRAINT IF EXISTS run_history_round_completed_range;
ALTER TABLE public.processing_run_history ADD CONSTRAINT run_history_round_completed_range CHECK (round_completed IS NULL OR round_completed BETWEEN 1 AND 7);
-- Never infer a final-round delivery solely from process_complete.
CREATE OR REPLACE FUNCTION public.ensure_round_progress_from_client_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE completed_count integer := 0; r integer; inferred_date date;
BEGIN
    IF new.current_round >= 2 THEN
        completed_count := new.current_round - 1;
    ELSIF new.current_round = 1 AND new.last_dispute_date IS NOT NULL THEN
        completed_count := 1;
    END IF;
    IF completed_count <= 0 THEN RETURN new; END IF;
    FOR r IN 1..completed_count LOOP
        inferred_date := CASE WHEN r = completed_count THEN new.last_dispute_date::date ELSE NULL END;
        INSERT INTO public.round_item_progress
            (crc_client_id,round_completed,round_completed_date,report_date_used,prior_disputed_items,
             deleted_items,still_reporting_items,unknown_items,newly_disputed_items,disputed_this_round,
             comparison_complete,data_source,delivery_recorded_at,updated_at)
        VALUES (new.crc_client_id,r,inferred_date,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
                false,'historical_round_only',NULL,now())
        ON CONFLICT (crc_client_id,round_completed)
        DO UPDATE SET round_completed_date=coalesce(public.round_item_progress.round_completed_date,excluded.round_completed_date),
                      updated_at=now()
        WHERE public.round_item_progress.data_source <> 'live_verified';
    END LOOP;
    RETURN new;
END;
$$;
COMMIT;
