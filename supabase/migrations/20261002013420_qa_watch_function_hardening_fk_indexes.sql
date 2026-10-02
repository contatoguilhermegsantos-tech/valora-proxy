-- Reviewed for MAX test project dczropngwfoxybdmybgw only.
-- Applied and verified in the test project; version returned by migration history.
-- The normalizer is a trigger function, not an application RPC.
-- Existing postgres/service_role privileges and trigger bindings are preserved.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke execute on function public.normalize_cnpj_columns() from public, anon, authenticated;
alter function public.normalize_cnpj_columns() set search_path = '';
alter function private.normalize_cnpj(text) set search_path = '';
alter function private.is_valid_cnpj(text) set search_path = '';

-- Dossier queries already use (organization_id, lead_id, timestamp) indexes.
-- Single-column FK indexes serve parent-key checks/deletes without organization predicates.
-- No existing index begins with these FK columns at the pre-change audit.
create index if not exists graph_candidate_review_log_candidate_fk_idx on public.graph_candidate_review_log (candidate_id);
create index if not exists graph_candidate_review_log_lead_fk_idx on public.graph_candidate_review_log (lead_id);
create index if not exists identity_assessments_lead_fk_idx on public.identity_assessments (lead_id);
create index if not exists identity_assessments_research_run_fk_idx on public.identity_assessments (research_run_id);
create index if not exists identity_source_attempts_lead_fk_idx on public.identity_source_attempts (lead_id);
create index if not exists identity_source_attempts_research_run_fk_idx on public.identity_source_attempts (research_run_id);
create index if not exists identity_status_audit_lead_fk_idx on public.identity_status_audit (lead_id);
create index if not exists intelligence_snapshots_lead_fk_idx on public.intelligence_snapshots (lead_id);
create index if not exists intelligence_snapshots_research_run_fk_idx on public.intelligence_snapshots (research_run_id);
create index if not exists relationship_review_log_lead_fk_idx on public.relationship_review_log (lead_id);
create index if not exists relationship_review_log_relationship_fk_idx on public.relationship_review_log (relationship_id);
create index if not exists web_context_hits_lead_fk_idx on public.web_context_hits (lead_id);
create index if not exists web_context_hits_research_run_fk_idx on public.web_context_hits (research_run_id);
