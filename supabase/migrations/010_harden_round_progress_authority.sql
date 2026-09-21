-- Harden round-result tracking so every client/round has exactly one summary
-- row and unknown legacy history is never represented as zero.

alter table public.round_item_progress
    alter column report_date_used drop not null,
    alter column prior_disputed_items drop not null,
    alter column deleted_items drop not null,
    alter column still_reporting_items drop not null,
    alter column unknown_items drop not null,
    alter column newly_disputed_items drop not null,
    alter column disputed_this_round drop not null;

alter table public.round_item_progress
    add column if not exists round_completed_date date null,
    add column if not exists delivery_recorded_at timestamptz null;

alter table public.round_item_progress
    drop constraint if exists round_item_progress_crc_client_id_round_completed_report_da_key,
    drop constraint if exists round_item_progress_data_source_check;

update public.round_item_progress
set data_source = 'historical_item_evidence'
where data_source = 'historical_inferred';

alter table public.round_item_progress
    add constraint round_item_progress_client_round_key
        unique (crc_client_id, round_completed),
    add constraint round_item_progress_data_source_check
        check (data_source = any (array[
            'live_verified'::text,
            'historical_item_evidence'::text,
            'historical_round_only'::text
        ]));

alter table public.item_round_outcomes
    drop constraint if exists item_round_outcomes_crc_client_id_observed_round_report_dat_key;

alter table public.item_round_outcomes
    add constraint item_round_outcomes_client_round_item_key
        unique (crc_client_id, observed_round, stable_item_key);

create index if not exists round_item_progress_round_date_idx
    on public.round_item_progress (round_completed_date);
