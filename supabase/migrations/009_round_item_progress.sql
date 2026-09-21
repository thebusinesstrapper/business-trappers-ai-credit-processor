-- Round-over-round dispute progress tracking.
-- Live rows are verified from a complete current report against durable prior
-- disputed-item history. Historical rows are conservative: disappearance from a
-- later dispute list is UNKNOWN unless a stored report snapshot proves deletion.

create table if not exists public.round_item_progress (
    round_item_progress_id uuid primary key default gen_random_uuid(),
    crc_client_id text not null references public.client_state(crc_client_id) on update cascade on delete restrict,
    round_completed smallint not null check (round_completed between 1 and 6),
    report_date_used date not null,
    prior_disputed_items integer not null default 0 check (prior_disputed_items >= 0),
    deleted_items integer not null default 0 check (deleted_items >= 0),
    still_reporting_items integer not null default 0 check (still_reporting_items >= 0),
    unknown_items integer not null default 0 check (unknown_items >= 0),
    newly_disputed_items integer not null default 0 check (newly_disputed_items >= 0),
    disputed_this_round integer not null default 0 check (disputed_this_round >= 0),
    comparison_complete boolean not null default true,
    data_source text not null default 'live_verified'
        check (data_source in ('live_verified','historical_inferred')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (crc_client_id, round_completed, report_date_used)
);

create table if not exists public.item_round_outcomes (
    item_round_outcome_id uuid primary key default gen_random_uuid(),
    crc_client_id text not null references public.client_state(crc_client_id) on update cascade on delete restrict,
    observed_round smallint not null check (observed_round between 1 and 6),
    report_date_used date not null,
    stable_item_key text not null,
    prior_round_disputed smallint null check (prior_round_disputed between 1 and 6),
    outcome text not null check (outcome in ('deleted','still_reporting')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (crc_client_id, observed_round, report_date_used, stable_item_key)
);

create index if not exists round_item_progress_client_round_idx
    on public.round_item_progress (crc_client_id, round_completed);
create index if not exists round_item_progress_source_idx
    on public.round_item_progress (data_source);
create index if not exists item_round_outcomes_client_round_idx
    on public.item_round_outcomes (crc_client_id, observed_round);

alter table public.round_item_progress enable row level security;
alter table public.item_round_outcomes enable row level security;
