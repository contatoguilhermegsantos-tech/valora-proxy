-- Additive migration for the test project only. No historical backfill is invented.
create table public.intelligence_snapshots (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 lead_id uuid not null references public.leads(id),
 research_run_id uuid references public.research_runs(id),
 payload jsonb not null check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=524288),
 fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
 captured_at timestamptz not null default now(),created_by uuid not null references auth.users(id)
);
create unique index intelligence_snapshot_run on public.intelligence_snapshots(organization_id,lead_id,research_run_id) where research_run_id is not null;
create index intelligence_snapshot_lead on public.intelligence_snapshots(organization_id,lead_id,captured_at desc);
alter table public.intelligence_snapshots enable row level security;
create policy snapshots_member_read on public.intelligence_snapshots for select to authenticated using (private.is_org_member(organization_id));
grant select on public.intelligence_snapshots to authenticated;
revoke insert,update,delete on public.intelligence_snapshots from anon,authenticated;
create table public.relationship_review_log (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 lead_id uuid not null references public.leads(id),relationship_id uuid not null references public.relationships(id),
 previous_status text not null,new_status text not null,reason text not null,
 reviewed_by uuid not null references auth.users(id),created_at timestamptz not null default now()
);
create index relationship_review_lead on public.relationship_review_log(organization_id,lead_id,created_at desc);
alter table public.relationship_review_log enable row level security;
create policy relationship_review_member_read on public.relationship_review_log for select to authenticated using (private.is_org_member(organization_id));
grant select on public.relationship_review_log to authenticated;
revoke insert,update,delete on public.relationship_review_log from anon,authenticated;
create or replace function public.review_documented_relationship(p_org uuid,p_user uuid,p_relationship uuid,p_action text,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r public.relationships%rowtype; target_status text;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_org and user_id=p_user and status='ACTIVE' and role<>'VIEWER') then raise exception 'Write access required'; end if;
 if p_action not in ('CONFIRM','REJECT') or length(trim(p_reason)) not between 5 and 2000 then raise exception 'Invalid review'; end if;
 select * into r from public.relationships where id=p_relationship and organization_id=p_org for update;
 if not found then raise exception 'Relationship not found'; end if;
 if p_action='CONFIRM' then
  if r.status in ('REJECTED','CONTRADICTED') or r.classification<>'FACT' or r.relationship_type not in ('SOCIO','ADMINISTRADOR') then raise exception 'Requires a dedicated identity or manual-document review'; end if;
  if r.from_entity_type<>'COMPANY' or not exists(select 1 from public.companies where id=r.from_entity_id and organization_id=p_org) then raise exception 'Unresolved origin'; end if;
  if not ((r.to_entity_type='PERSON' and exists(select 1 from public.people where id=r.to_entity_id and organization_id=p_org)) or (r.to_entity_type='COMPANY' and exists(select 1 from public.companies where id=r.to_entity_id and organization_id=p_org))) then raise exception 'Unresolved target'; end if;
  -- Lock supporting/contradicting documents during review; concurrent invalidation waits.
  perform e.id from public.evidence e join public.relationship_evidence re on re.evidence_id=e.id where re.relationship_id=r.id and re.organization_id=p_org and e.organization_id=p_org for share of e;
  if not exists(select 1 from public.relationship_evidence re join public.evidence e on e.id=re.evidence_id and e.organization_id=p_org where re.relationship_id=r.id and re.organization_id=p_org and re.support_type='SUPPORTS' and e.verification_status='VERIFIED' and e.source_kind in ('PRIMARY_OFFICIAL','PRIMARY_CORPORATE','AGGREGATOR')) then raise exception 'No verified supporting document'; end if;
  if exists(select 1 from public.relationship_evidence re join public.evidence e on e.id=re.evidence_id and e.organization_id=p_org where re.relationship_id=r.id and re.organization_id=p_org and re.support_type='CONTRADICTS' and e.verification_status='VERIFIED') then raise exception 'Contradicting document'; end if;
  target_status:='VERIFIED';
 else target_status:='REJECTED'; end if;
 if r.status=target_status then return to_jsonb(r); end if;
 insert into public.relationship_review_log(organization_id,lead_id,relationship_id,previous_status,new_status,reason,reviewed_by) values(p_org,r.lead_id,r.id,r.status,target_status,trim(p_reason),p_user);
 update public.relationships set status=target_status,reason=trim(p_reason),updated_at=now() where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.review_documented_relationship(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.review_documented_relationship(uuid,uuid,uuid,text,text) to service_role;
