-- Operational configuration for the MAX test project only.
-- Keep the scheduled check, but do not invoke an Edge worker with no eligible work.
select cron.alter_job(job_id:=jobid,command:=$job$
select net.http_post(
 url := 'https://dczropngwfoxybdmybgw.supabase.co/functions/v1/pncp-backfill-step',
 headers := jsonb_build_object('Content-Type','application/json','X-MAX-SYNC-TOKEN',(select token from public.system_internal_tokens where key='pncp_sync')),
 body := '{}'::jsonb,timeout_milliseconds := 30000
) as request_id
where exists(select 1 from public.source_backfill_queue where source_key='pncp'
 and ((status in ('PENDING','FAILED') and attempts<4)
 or (status='RUNNING' and started_at<now()-interval '10 minutes')));
$job$) from cron.job where jobname='max-pncp-backfill-worker';
