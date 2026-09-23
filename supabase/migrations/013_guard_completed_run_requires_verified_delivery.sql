alter table public.processing_run_history
  drop constraint if exists run_history_completed_requires_verified_delivery;

alter table public.processing_run_history
  add constraint run_history_completed_requires_verified_delivery
  check (
    run_result is distinct from 'completed'
    or (
      client_notification_verified is true
      and crc_save_verified is true
    )
  );
