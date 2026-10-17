create table public.graph_candidate_review_log (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 lead_id uuid not null references public.leads(id),candidate_id uuid not null references public.candidate_entities(id),
 action text not null check(action in ('RESOLVE','REJECT')),reason text not null,reviewed_by uuid not null references auth.users(id),created_at timestamptz not null default now()
);
create index graph_candidate_review_lead on public.graph_candidate_review_log(organization_id,lead_id,created_at desc);
alter table public.graph_candidate_review_log enable row level security;
create policy graph_candidate_member_read on public.graph_candidate_review_log for select to authenticated using(private.is_org_member(organization_id));
grant select on public.graph_candidate_review_log to authenticated;
revoke insert,update,delete on public.graph_candidate_review_log from anon,authenticated;
create function public.review_graph_candidate(p_org uuid,p_user uuid,p_candidate uuid,p_action text,p_reason text,p_company uuid default null,p_parent_evidence uuid default null,p_target_evidence uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.candidate_entities%rowtype; parent public.companies%rowtype; target public.companies%rowtype; rel public.relationships%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_org and user_id=p_user and status='ACTIVE' and role<>'VIEWER') then raise exception 'Write access required'; end if;
 if p_action not in ('RESOLVE','REJECT') or length(trim(p_reason)) not between 5 and 2000 then raise exception 'Invalid review'; end if;
 select * into c from public.candidate_entities where id=p_candidate and organization_id=p_org for update;
 if not found or c.candidate_type not in ('QSA_LEGAL_ENTITY','QSA_UNRESOLVED_ENTITY') then raise exception 'Candidate not found'; end if;
 if p_action='RESOLVE' then
  if c.candidate_type<>'QSA_LEGAL_ENTITY' or c.validation_status='REJECTED' then raise exception 'Rejected or unresolved candidate'; end if;
  select * into parent from public.companies where id=(c.metadata->>'parent_company_id')::uuid and organization_id=p_org;
  select * into target from public.companies where id=p_company and organization_id=p_org;
  if parent.id is null or target.id is null or parent.id=target.id or left(target.cnpj,8)<>c.metadata->>'basic_cnpj' then raise exception 'Invalid company mapping'; end if;
  perform e.id from public.evidence e where e.id in(p_parent_evidence,p_target_evidence) and e.organization_id=p_org for share;
  if (select count(*) from public.evidence where id in(p_parent_evidence,p_target_evidence) and organization_id=p_org and lead_id=c.lead_id and verification_status='VERIFIED')<>2 then raise exception 'Two verified source documents required'; end if;
  select * into rel from public.relationships where organization_id=p_org and lead_id=c.lead_id and from_entity_type='COMPANY' and from_entity_id=parent.id and to_entity_type='COMPANY' and to_entity_id=target.id and relationship_type='SOCIO' for update;
  if rel.status in ('REJECTED','CONTRADICTED') then raise exception 'Relationship review blocks resolution'; end if;
  if rel.id is null then
   insert into public.relationships(organization_id,lead_id,from_entity_type,from_entity_id,from_label,to_entity_type,to_entity_id,to_label,relationship_type,classification,confidence,status,reason,created_by) values(p_org,c.lead_id,'COMPANY',parent.id,parent.legal_name,'COMPANY',target.id,target.legal_name,'SOCIO','FACT','HIGH','PENDING',trim(p_reason),p_user) returning * into rel;
  end if;
  insert into public.relationship_evidence(organization_id,relationship_id,evidence_id,support_type,strength) values(p_org,rel.id,p_parent_evidence,'SUPPORTS',1),(p_org,rel.id,p_target_evidence,'SUPPORTS',1) on conflict(relationship_id,evidence_id) do nothing;
  if exists(select 1 from public.relationship_evidence re join public.evidence e on e.id=re.evidence_id where re.organization_id=p_org and re.relationship_id=rel.id and re.support_type='CONTRADICTS' and e.verification_status='VERIFIED') then raise exception 'Contradiction blocks resolution'; end if;
  update public.relationships set status='VERIFIED',reason=trim(p_reason),updated_at=now() where id=rel.id;
  update public.candidate_entities set validation_status='CONFIRMED',metadata=metadata||jsonb_build_object('resolved_company_id',target.id,'relationship_id',rel.id,'full_cnpj',target.cnpj,'confirmed_by_user',true,'confirmed_at',now()) where id=c.id returning * into c;
 else
  if c.validation_status='REJECTED' then return to_jsonb(c); end if;
  if c.metadata->>'relationship_id' is not null then
   select * into rel from public.relationships where id=(c.metadata->>'relationship_id')::uuid and organization_id=p_org and lead_id=c.lead_id for update;
   if rel.id is not null and rel.status<>'REJECTED' then
    insert into public.relationship_review_log(organization_id,lead_id,relationship_id,previous_status,new_status,reason,reviewed_by) values(p_org,c.lead_id,rel.id,rel.status,'REJECTED',trim(p_reason),p_user);
    update public.relationships set status='REJECTED',reason=trim(p_reason),updated_at=now() where id=rel.id;
   end if;
  end if;
  update public.candidate_entities set validation_status='REJECTED',metadata=metadata||jsonb_build_object('rejected_by_user',true,'rejection_reason',trim(p_reason)) where id=c.id returning * into c;
 end if;
 insert into public.graph_candidate_review_log(organization_id,lead_id,candidate_id,action,reason,reviewed_by) values(p_org,c.lead_id,c.id,p_action,trim(p_reason),p_user);
 return to_jsonb(c);
end $$;
revoke all on function public.review_graph_candidate(uuid,uuid,uuid,text,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.review_graph_candidate(uuid,uuid,uuid,text,text,uuid,uuid,uuid) to service_role;
