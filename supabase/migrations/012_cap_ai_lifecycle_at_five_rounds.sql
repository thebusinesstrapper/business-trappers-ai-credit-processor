-- Business Trappers: five-round AI lifecycle cap.
-- This narrows only the live client_state lifecycle. Historical result/audit
-- tables retain their existing wider round ranges so old evidence is never lost.

alter table public.client_state
    drop constraint if exists client_state_current_round_range;

alter table public.client_state
    add constraint client_state_current_round_range
    check (current_round >= 1 and current_round <= 5);

create or replace function public.ensure_round_progress_from_client_state()
returns trigger
language plpgsql
as $$
declare
    completed_count integer := 0;
    r integer;
    inferred_date date;
begin
    if new.process_complete = true and new.current_round = 5 then
        completed_count := 5;
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
