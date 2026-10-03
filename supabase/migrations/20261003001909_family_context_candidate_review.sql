-- MAX test-only family candidate review and independent opening.
-- No RLS/table policies or family relationships are created by this migration.
create or replace function public.review_graph_candidate(p_org uuid,p_user uuid,p_candidate uuid,p_action text,p_reason text,p_company uuid default null,p_parent_evidence uuid default null,p_target_evidence uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.candidate_entities%rowtype; parent public.companies%rowtype; target public.companies%rowtype; rel public.relationships%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_org and user_id=p_user and status='ACTIVE' and role in ('OWNER','ADMIN','ANALYST','MEMBER')) then raise exception 'Write access required'; end if;
 if p_action is null or p_reason is null or p_action not in ('RESOLVE','REJECT') or length(trim(p_reason)) not between 5 and 2000 then raise exception 'Invalid review'; end if;
 select * into c from public.candidate_entities where id=p_candidate and organization_id=p_org for update;
 if not found or c.candidate_type not in ('QSA_LEGAL_ENTITY','QSA_UNRESOLVED_ENTITY','FAMILY_CONTEXT_MATCH') then raise exception 'Candidate not found'; end if;
 if not exists(select 1 from public.leads where id=c.lead_id and organization_id=p_org) then raise exception 'Origin lead not found'; end if;
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
  if c.candidate_type<>'FAMILY_CONTEXT_MATCH' and c.metadata->>'relationship_id' is not null then
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


create or replace function public.open_family_candidate(p_org uuid,p_user uuid,p_candidate uuid,p_entity_type text,p_lead_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 c public.candidate_entities%rowtype; ev public.evidence%rowtype; child public.leads%rowtype;
 target_name text; target_cnpj text; target_city text; target_state text; target_segment text;
 created_id uuid; reason text := 'Pista da busca por sobrenome e contexto empresarial; parentesco não confirmado.';
begin
 perform om.user_id from public.organization_members om where om.organization_id=p_org and om.user_id=p_user and om.status='ACTIVE' and om.role in ('OWNER','ADMIN','ANALYST','MEMBER') for share;
 if not found then raise exception 'Write access required'; end if;
 if p_lead_id is null or p_entity_type is null or p_entity_type not in ('COMPANY','PERSON') then raise exception 'Invalid independent lead'; end if;
 select * into c from public.candidate_entities where id=p_candidate and organization_id=p_org for update;
 if not found or c.candidate_type is distinct from 'FAMILY_CONTEXT_MATCH' then raise exception 'Candidate not found'; end if;
 if c.validation_status is distinct from 'UNVALIDATED' or c.confidence is distinct from 'LOW' or (c.metadata->'kinship_confirmed') is distinct from 'false'::jsonb then raise exception 'Unvalidated family context required'; end if;
 if c.entity_type not in ('COMPANY','PERSON') or (p_entity_type='PERSON' and c.entity_type is distinct from 'PERSON') then raise exception 'Candidate entity mismatch'; end if;
 perform l.id from public.leads l where l.id=c.lead_id and l.organization_id=p_org and l.kind='PERSON' for key share;
 if not found then raise exception 'Origin lead not found'; end if;
 if c.research_run_id is not null and not exists(select 1 from public.research_runs rr where rr.id=c.research_run_id and rr.organization_id=p_org and rr.lead_id=c.lead_id) then raise exception 'Invalid research context'; end if;
 if coalesce(c.metadata->>'evidence_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Documentary support required'; end if;
 select doc.* into ev from public.evidence doc where doc.id=(c.metadata->>'evidence_id')::uuid and doc.organization_id=p_org and doc.lead_id=c.lead_id for share;
 if ev.id is null or ev.verification_status is distinct from 'VERIFIED' or ev.source_registry_id is null or not exists(select 1 from public.source_registry sr where sr.id=ev.source_registry_id) then raise exception 'Verified source document required'; end if;
 if p_entity_type='COMPANY' then
  target_cnpj := private.normalize_cnpj(c.metadata->>'full_cnpj');
  target_name := trim(coalesce(c.metadata->>'company_name',''));
  if not private.is_valid_cnpj(target_cnpj) or target_cnpj !~ '^[A-Z0-9]{12}[0-9]{2}$' or length(target_name) not between 2 and 300 then raise exception 'Full company identity required'; end if;
  target_city := nullif(left(trim(coalesce(c.metadata->>'city','')),200),'');
  target_state := upper(trim(coalesce(c.metadata->>'state','')));
  if target_state !~ '^[A-Z]{2}$' then target_state := null; end if;
  target_segment := nullif(left(trim(coalesce(c.metadata->>'segment','')),300),'');
 else
  target_name := trim(coalesce(c.metadata->>'person_name',''));
  if c.metadata->>'match_basis' is distinct from 'QSA_PERSON' or length(target_name) not between 2 and 300 then raise exception 'Independent QSA person name required'; end if;
  -- A company's location/sector does not establish a person's home or profession.
  target_cnpj := null; target_city := null; target_state := null; target_segment := null;
 end if;
 insert into public.leads(id,organization_id,created_by,kind,name,city,state,segment,initial_cnpj,reference_company,identity_status,identity_confirmed_by_user,origin_lead_id,origin_relationship_id,origin_reason)
 values(p_lead_id,p_org,p_user,p_entity_type,target_name,target_city,target_state,target_segment,target_cnpj,case when p_entity_type='COMPANY' then target_name else null end,'PENDING',false,c.lead_id,null,reason)
 on conflict(id) do nothing returning id into created_id;
 select * into child from public.leads where id=p_lead_id and organization_id=p_org for update;
 if child.id is null or child.id=c.lead_id or child.kind<>p_entity_type or child.name<>target_name or child.initial_cnpj is distinct from target_cnpj or child.origin_relationship_id is not null or child.origin_reason is distinct from reason then raise exception 'Independent lead identity conflict'; end if;
 update public.candidate_entities set metadata=metadata||jsonb_build_object(
  case when p_entity_type='COMPANY' then 'opened_company_lead_id' else 'opened_person_lead_id' end,child.id,
  'independent_opened_by',p_user,'independent_opened_at',now(),'kinship_confirmed',false
 ) where id=c.id and organization_id=p_org;
 return jsonb_build_object('lead',to_jsonb(child),'reused',created_id is null,'kinship_confirmed',false);
end $$;
revoke all on function public.open_family_candidate(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.open_family_candidate(uuid,uuid,uuid,text,uuid) to service_role;
