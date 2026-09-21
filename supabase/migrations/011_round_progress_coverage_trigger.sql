-- Database-level coverage guard for round results.
-- Whenever client_state proves a round has been completed, ensure a placeholder
-- round_item_progress row exists. The application can later upgrade the same
-- client+round row to live_verified detail.

create or replace function public.ensure_round_progress_from_client_state()
returns trigger
language plpgsql
as $$
declare
    completed_count integer := 0;
    r integer;
    inferred_date date;
begin
    if new.process_complete = true and new.current_round = 6 then
        completed_count := 6;
    elsif new.current_round >= 2 then
        completed_count := new.current_round - 1;
    elsif new.current_round = 1 and new.last_dispute_date is not null then
        completed_count := 1;
    end if;

    if completed_count <= 0 then
        return new;
    end if;

    for r in 1..completed_count loop
        inferred_date := case
            when r = completed_count then new.last_dispute_date::date
            else null
        end;

        insert into public.round_item_progress (
            crc_client_id,
            round_completed,
            round_completed_date,
            report_date_used,
            prior_disputed_items,
            deleted_items,
            still_reporting_items,
            unknown_items,
            newly_disputed_items,
            disputed_this_round,
            comparison_complete,
            data_source,
            delivery_recorded_at,
            updated_at
        )
        values (
            new.crc_client_id,
            r,
            inferred_date,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            false,
            'historical_round_only',
            null,
            now()
        )
        on conflict (crc_client_id, round_completed)
        do update set
            round_completed_date = coalesce(
                public.round_item_progress.round_completed_date,
                excluded.round_completed_date
            ),
            updated_at = now()
        where public.round_item_progress.data_source <> 'live_verified';
    end loop;

    return new;
end;
$$;

drop trigger if exists trg_ensure_round_progress_from_client_state on public.client_state;

create trigger trg_ensure_round_progress_from_client_state
after insert or update of current_round, last_dispute_date, process_complete
on public.client_state
for each row
execute function public.ensure_round_progress_from_client_state();
