-- Preserve successful page boundaries across rate limits and worker restarts.
alter table public.source_backfill_queue
  add column if not exists next_page integer not null default 1 check (next_page >= 1);
comment on column public.source_backfill_queue.next_page is 'Next uncommitted PNCP page, fixed page size 100. Advanced only after successful index upsert.';

-- Recover missed daily dates since the last fully completed date (bounded to 31 days).
insert into public.source_backfill_queue(source_key,target_date,status)
select 'pncp',d::date,'PENDING'
from public.source_sync_state s,
  lateral generate_series(greatest(s.last_successful_date+1,current_date-31)::timestamp,
    (current_date-1)::timestamp,interval '1 day') d
where s.source_key='pncp'
on conflict(source_key,target_date) do nothing;
