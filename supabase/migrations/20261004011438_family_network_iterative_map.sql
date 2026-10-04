-- Test project only. No identity, family relationship or core fact promotion.
create or replace function private.family_network_private_fields(value jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select exists(select 1 from jsonb_path_query(coalesce(value,'{}'::jsonb),'$.** ? (@.type() == "object").keyvalue()') v
 where lower(v->>'key') ~ '(cpf|age_group|faixa_etaria|birth|residen|personal_address|logradouro|bairro|telefone|email|representante)'
 or lower(v->>'key') in ('age','idade','address','cep','partner_identifier'))
 or coalesce(value::text,'') ~ '\*\*\*[0-9]{6}\*\*';
$$;
revoke all on function private.family_network_private_fields(jsonb) from public,anon,authenticated;
grant execute on function private.family_network_private_fields(jsonb) to service_role;

create or replace function public.commit_family_network(
 p_org uuid,p_user uuid,p_lead uuid,p_pivot uuid,p_revision integer,p_state jsonb,p_graph jsonb,p_candidates jsonb,p_run uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare pivot public.candidate_entities%rowtype; item jsonb; doc public.evidence%rowtype; existing public.candidate_entities%rowtype;
 valid_nodes jsonb; valid_edges jsonb; clean_graph jsonb; node jsonb; doc_id text;
 uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
 if p_org is null or p_user is null or p_lead is null or p_pivot is null then raise exception 'Valid network context required'; end if;
 perform user_id from public.organization_members where organization_id=p_org and user_id=p_user and status='ACTIVE' and role in('OWNER','ADMIN','ANALYST','MEMBER') for share;
 if not found then raise exception 'Write access required'; end if;
 perform id from public.leads where id=p_lead and organization_id=p_org and kind='PERSON' for key share;
 if not found then raise exception 'Origin lead not found'; end if;
 if p_run is not null and not exists(select 1 from public.research_runs where id=p_run and lead_id=p_lead and organization_id=p_org) then raise exception 'Invalid research run'; end if;
 if p_revision is null or p_revision<0 or jsonb_typeof(p_state) is distinct from 'object' or jsonb_typeof(p_graph) is distinct from 'object'
 or jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_typeof(p_graph->'nodes') is distinct from 'array' or jsonb_typeof(p_graph->'edges') is distinct from 'array'
 then raise exception 'Invalid network shape'; end if;
 if octet_length(p_state::text)>2000000 or octet_length(p_graph::text)>500000 or jsonb_array_length(p_candidates)>280
 or jsonb_array_length(p_graph->'nodes')>281 or jsonb_array_length(p_graph->'edges')>400
 or private.family_network_private_fields(p_state) or private.family_network_private_fields(p_graph) or private.family_network_private_fields(p_candidates)
 or p_graph->'identity_confirmed' is distinct from 'false'::jsonb or p_graph->'kinship_confirmed' is distinct from 'false'::jsonb
 then raise exception 'Invalid network payload'; end if;
 -- Validate every identifier before using it in lock queries or UUID casts.
 for item in select value from jsonb_array_elements(p_candidates) loop
  if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'metadata') is distinct from 'object'
  or coalesce(item->>'id','') !~* uuid_pattern
  or coalesce(item->>'candidate_type','') not in ('FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON')
  or coalesce(item->>'entity_type','') not in('COMPANY','PERSON')
  or jsonb_typeof(item->'label') is distinct from 'string' or length(trim(coalesce(item->>'label',''))) not between 2 and 300
  or jsonb_typeof(item->'candidate_reason') is distinct from 'string' or length(trim(coalesce(item->>'candidate_reason',''))) not between 5 and 2000
  or item->'metadata'->'identity_confirmed' is distinct from 'false'::jsonb or item->'metadata'->'kinship_confirmed' is distinct from 'false'::jsonb
  or coalesce(item->'metadata'->>'evidence_id','') !~* uuid_pattern
  or length(trim(coalesce(item->'metadata'->>'network_node_key',''))) not between 1 and 300
  or coalesce(item->'metadata'->>'full_cnpj','') !~ '^[A-Z0-9]{12}[0-9]{2}$'
  or not private.is_valid_cnpj(item->'metadata'->>'full_cnpj')
  then raise exception 'Unsafe network candidate'; end if;
  if item->>'entity_type'='PERSON' and (item->>'candidate_type' is distinct from 'FAMILY_NETWORK_PERSON'
   or jsonb_typeof(item->'metadata'->'person_name') is distinct from 'string'
   or item->'metadata'->>'match_basis' is distinct from 'QSA_PERSON'
   or trim(item->>'label') is distinct from trim(item->'metadata'->>'person_name')
   or left(item->'metadata'->>'network_node_key',22) is distinct from 'person:'||(item->'metadata'->>'full_cnpj')||':'
  ) then raise exception 'Physical QSA citation required'; end if;
  if item->>'entity_type'='COMPANY' and (item->>'candidate_type' is distinct from 'FAMILY_NETWORK_COMPANY'
   or jsonb_typeof(item->'metadata'->'company_name') is distinct from 'string'
   or trim(item->>'label') is distinct from trim(item->'metadata'->>'company_name')
   or item->'metadata'->>'network_node_key' is distinct from 'company:'||(item->'metadata'->>'full_cnpj')
  ) then raise exception 'Company registry identity required'; end if;
 end loop;
 for node in select value from jsonb_array_elements(p_graph->'nodes') loop
  if jsonb_typeof(node) is distinct from 'object' or coalesce(node->>'type','') not in ('ROOT','COMPANY','PERSON_CITATION')
  or jsonb_typeof(node->'key') is distinct from 'string' or length(trim(coalesce(node->>'key',''))) not between 1 and 300
  or jsonb_typeof(node->'label') is distinct from 'string' or length(trim(coalesce(node->>'label',''))) not between 2 and 300
  or node->'identity_confirmed' is distinct from 'false'::jsonb or node->'kinship_confirmed' is distinct from 'false'::jsonb
  then raise exception 'Unsafe graph node'; end if;
  if node->>'type'='ROOT' then
   if node->>'key' is distinct from 'root' or node->>'candidate_id' is not null then raise exception 'Unique unbound root required'; end if;
  elsif coalesce(node->>'candidate_id','') !~* uuid_pattern or coalesce(node->>'evidence_id','') !~* uuid_pattern
   or coalesce(node->>'full_cnpj','') !~ '^[A-Z0-9]{12}[0-9]{2}$' or not private.is_valid_cnpj(node->>'full_cnpj')
  then raise exception 'Bound node identity and evidence required'; end if;
 end loop;
 for item in select value from jsonb_array_elements(p_graph->'edges') loop
  if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'id','') !~* uuid_pattern
  or jsonb_typeof(item->'from') is distinct from 'string' or length(trim(coalesce(item->>'from',''))) not between 1 and 300
  or jsonb_typeof(item->'to') is distinct from 'string' or length(trim(coalesce(item->>'to',''))) not between 1 and 300
  or item->>'from' is not distinct from item->>'to'
  or coalesce(item->>'kind','') not in('QSA_PARTICIPATION','SAME_NAME_CANDIDATE','SURNAME_CONTEXT_CANDIDATE','ROOT_CONTEXT_CANDIDATE')
  or item->>'validation_status' is distinct from 'UNVALIDATED' or item->>'confidence' is distinct from 'LOW'
  or item->'identity_confirmed' is distinct from 'false'::jsonb or item->'kinship_confirmed' is distinct from 'false'::jsonb
  or jsonb_typeof(item->'evidence_ids') is distinct from 'array'
  then raise exception 'Unsafe network edge'; end if;
  if jsonb_array_length(item->'evidence_ids')=0 or jsonb_array_length(item->'evidence_ids')>3 then raise exception 'Bound edge documents required'; end if;
  for doc_id in select jsonb_array_elements_text(item->'evidence_ids') loop
   if coalesce(doc_id,'') !~* uuid_pattern then raise exception 'Valid edge document identifier required'; end if;
  end loop;
  if item->>'evidence_id' is not null and (item->>'evidence_id' !~* uuid_pattern
   or not exists(select 1 from jsonb_array_elements_text(item->'evidence_ids') e(value) where e.value=item->>'evidence_id')
  ) then raise exception 'Primary edge document must match bound documents'; end if;
 end loop;
 insert into public.candidate_entities(id,organization_id,lead_id,entity_type,label,candidate_type,confidence,validation_status,metadata,created_by)
 values(p_pivot,p_org,p_lead,'GROUP','Mapa de conexões do pivô','FAMILY_NETWORK_PIVOT','LOW','UNVALIDATED',jsonb_build_object('revision',0,'identity_confirmed',false,'kinship_confirmed',false),p_user)
 on conflict(id) do nothing;
 select * into pivot from public.candidate_entities where id=p_pivot and organization_id=p_org and lead_id=p_lead and candidate_type='FAMILY_NETWORK_PIVOT' for update;
 if pivot.id is null or pivot.validation_status is distinct from 'UNVALIDATED' or pivot.entity_type is distinct from 'GROUP'
 or pivot.confidence is distinct from 'LOW' or pivot.metadata->'identity_confirmed' is distinct from 'false'::jsonb or pivot.metadata->'kinship_confirmed' is distinct from 'false'::jsonb
 then raise exception 'Pivot review blocks expansion'; end if;
 if coalesce((pivot.metadata->>'revision')::integer,0)<>p_revision then return jsonb_build_object('conflict',true,'revision',pivot.metadata->'revision'); end if;
 -- Includes persisted nodes absent from this batch. Review/opening use the same
 -- candidate-before-evidence lock order; ordering UUIDs avoids batch inversions.
 perform c.id from public.candidate_entities c
 where c.organization_id=p_org and c.lead_id=p_lead and c.id in (
  select (value->>'id')::uuid from jsonb_array_elements(p_candidates)
  union select (value->>'candidate_id')::uuid from jsonb_array_elements(p_graph->'nodes') where value->>'type'<>'ROOT'
 ) order by c.id for update;
 for item in select value from jsonb_array_elements(p_candidates) order by value->>'id' loop
  insert into public.candidate_entities(id,organization_id,lead_id,research_run_id,entity_type,label,candidate_type,confidence,validation_status,candidate_reason,metadata,created_by)
  values((item->>'id')::uuid,p_org,p_lead,p_run,item->>'entity_type',item->>'label',item->>'candidate_type','LOW','UNVALIDATED',item->>'candidate_reason',item->'metadata',p_user)
  on conflict(id) do nothing;
  select * into existing from public.candidate_entities where id=(item->>'id')::uuid and organization_id=p_org and lead_id=p_lead for update;
  if existing.id is null or existing.candidate_type is distinct from item->>'candidate_type' or existing.entity_type is distinct from item->>'entity_type' then raise exception 'Candidate scope conflict'; end if;
  if existing.validation_status is distinct from 'REJECTED' and (existing.validation_status is distinct from 'UNVALIDATED' or existing.confidence is distinct from 'LOW'
   or existing.metadata->'identity_confirmed' is distinct from 'false'::jsonb or existing.metadata->'kinship_confirmed' is distinct from 'false'::jsonb
  ) then raise exception 'Persisted candidate review blocks expansion'; end if;
 end loop;
 perform e.id from public.evidence e where e.organization_id=p_org and e.lead_id=p_lead and e.id in (
  select (value->'metadata'->>'evidence_id')::uuid from jsonb_array_elements(p_candidates)
  union select (value->>'evidence_id')::uuid from jsonb_array_elements(p_graph->'nodes') where value->>'type'<>'ROOT'
  union select d.value::uuid from jsonb_array_elements(p_graph->'edges') edge cross join lateral jsonb_array_elements_text(edge->'evidence_ids') d(value)
  union select case when c.metadata->>'evidence_id' ~* uuid_pattern then (c.metadata->>'evidence_id')::uuid else null end
   from public.candidate_entities c where c.organization_id=p_org and c.lead_id=p_lead and c.id in (
    select (value->>'candidate_id')::uuid from jsonb_array_elements(p_graph->'nodes') where value->>'type'<>'ROOT'
   )
 ) order by e.id for share;
 for item in select value from jsonb_array_elements(p_candidates) loop
  select * into doc from public.evidence where id=(item->'metadata'->>'evidence_id')::uuid and organization_id=p_org and lead_id=p_lead;
  if doc.id is null or doc.verification_status is distinct from 'VERIFIED' or doc.source_registry_id is null then raise exception 'Verified scoped evidence required'; end if;
 end loop;
 -- Re-read revisions under the same locks. Rejected candidates never reappear.
 valid_nodes:='[]'::jsonb;
 for node in select value from jsonb_array_elements(p_graph->'nodes') loop
  if node->>'type'='ROOT' then valid_nodes:=valid_nodes||jsonb_build_array(node); continue; end if;
  select * into existing from public.candidate_entities where id=(node->>'candidate_id')::uuid and organization_id=p_org and lead_id=p_lead;
  if existing.id is null then raise exception 'Node candidate scope required'; end if;
  if existing.validation_status='REJECTED' then continue; end if;
  if existing.validation_status is distinct from 'UNVALIDATED' or existing.confidence is distinct from 'LOW'
  or existing.candidate_type not in ('FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON')
  or existing.metadata->'identity_confirmed' is distinct from 'false'::jsonb or existing.metadata->'kinship_confirmed' is distinct from 'false'::jsonb
  or existing.metadata->>'network_node_key' is distinct from node->>'key'
  or existing.metadata->>'full_cnpj' is distinct from node->>'full_cnpj'
  or existing.metadata->>'evidence_id' is distinct from node->>'evidence_id'
  or existing.label is distinct from node->>'label'
  then raise exception 'Node must match its persisted unresolved candidate'; end if;
  if node->>'type'='COMPANY' and (existing.candidate_type is distinct from 'FAMILY_NETWORK_COMPANY' or existing.entity_type is distinct from 'COMPANY'
   or node->>'key' is distinct from 'company:'||(node->>'full_cnpj') or existing.metadata->>'company_name' is distinct from node->>'label'
  ) then raise exception 'Company node identity mismatch'; end if;
  if node->>'type'='PERSON_CITATION' and (existing.candidate_type is distinct from 'FAMILY_NETWORK_PERSON' or existing.entity_type is distinct from 'PERSON'
   or existing.metadata->>'match_basis' is distinct from 'QSA_PERSON' or existing.metadata->>'person_name' is distinct from node->>'person_name'
   or node->>'person_name' is distinct from node->>'label'
   or left(node->>'key',22) is distinct from 'person:'||(node->>'full_cnpj')||':'
  ) then raise exception 'Person citation identity mismatch'; end if;
  select * into doc from public.evidence where id=(node->>'evidence_id')::uuid and organization_id=p_org and lead_id=p_lead;
  if doc.id is null or doc.verification_status is distinct from 'VERIFIED' or doc.source_registry_id is null then raise exception 'Node evidence required'; end if;
  valid_nodes:=valid_nodes||jsonb_build_array(node);
 end loop;
 select coalesce(jsonb_agg(e),'[]'::jsonb) into valid_edges from jsonb_array_elements(p_graph->'edges') e
 where exists(select 1 from jsonb_array_elements(valid_nodes) n where n->>'key'=e->>'from')
 and exists(select 1 from jsonb_array_elements(valid_nodes) n where n->>'key'=e->>'to');
 if (select count(*) from jsonb_array_elements(valid_nodes) n where n->>'type'='ROOT' and n->>'key'='root')<>1
 or (select count(*) from jsonb_array_elements(valid_nodes))<>(select count(distinct n->>'key') from jsonb_array_elements(valid_nodes) n)
 then raise exception 'Unique network root and node keys required'; end if;
 with recursive reachable(key) as (
  select 'root'::text union
  select case when e->>'from'=r.key then e->>'to' else e->>'from' end
  from reachable r join jsonb_array_elements(valid_edges) e on e->>'from'=r.key or e->>'to'=r.key
 ) select coalesce(jsonb_agg(n),'[]'::jsonb) into valid_nodes from jsonb_array_elements(valid_nodes) n where n->>'key' in(select key from reachable);
 select coalesce(jsonb_agg(e),'[]'::jsonb) into valid_edges from jsonb_array_elements(valid_edges) e
 where exists(select 1 from jsonb_array_elements(valid_nodes) n where n->>'key'=e->>'from')
 and exists(select 1 from jsonb_array_elements(valid_nodes) n where n->>'key'=e->>'to');
 for item in select value from jsonb_array_elements(valid_edges) loop
  for doc_id in select jsonb_array_elements_text(item->'evidence_ids') loop
   select * into doc from public.evidence where id=doc_id::uuid and organization_id=p_org and lead_id=p_lead;
   if doc.id is null or doc.verification_status is distinct from 'VERIFIED' or doc.source_registry_id is null then raise exception 'Edge evidence required'; end if;
  end loop;
 end loop;
 clean_graph:=p_graph||jsonb_build_object('nodes',valid_nodes,'edges',valid_edges,'revision',p_revision+1,'identity_confirmed',false,'kinship_confirmed',false,'counts',jsonb_build_object('companies',(select count(*) from jsonb_array_elements(valid_nodes) n where n->>'type'='COMPANY'),'people',(select count(*) from jsonb_array_elements(valid_nodes) n where n->>'type'='PERSON_CITATION'),'edges',jsonb_array_length(valid_edges)));
 update public.candidate_entities set research_run_id=coalesce(p_run,research_run_id),metadata=jsonb_build_object('revision',p_revision+1,'state',p_state,'public_graph',clean_graph,'identity_confirmed',false,'kinship_confirmed',false,'last_queried_at',now()) where id=p_pivot returning * into pivot;
 return jsonb_build_object('conflict',false,'pivot',jsonb_build_object('id',pivot.id,'candidate_type',pivot.candidate_type,'validation_status',pivot.validation_status,'metadata',pivot.metadata-'state'),'network',clean_graph);
end $$;
revoke all on function public.commit_family_network(uuid,uuid,uuid,uuid,integer,jsonb,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.commit_family_network(uuid,uuid,uuid,uuid,integer,jsonb,jsonb,jsonb,uuid) to service_role;

-- MAX test-only family candidate review and independent opening.
-- No RLS/table policies or family relationships are created by this migration.
create or replace function public.review_graph_candidate(p_org uuid,p_user uuid,p_candidate uuid,p_action text,p_reason text,p_company uuid default null,p_parent_evidence uuid default null,p_target_evidence uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.candidate_entities%rowtype; parent public.companies%rowtype; target public.companies%rowtype; rel public.relationships%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_org and user_id=p_user and status='ACTIVE' and role in ('OWNER','ADMIN','ANALYST','MEMBER')) then raise exception 'Write access required'; end if;
 if p_action is null or p_reason is null or p_action not in ('RESOLVE','REJECT') or length(trim(p_reason)) not between 5 and 2000 then raise exception 'Invalid review'; end if;
 select * into c from public.candidate_entities where id=p_candidate and organization_id=p_org for update;
 if not found or c.candidate_type not in ('QSA_LEGAL_ENTITY','QSA_UNRESOLVED_ENTITY','FAMILY_CONTEXT_MATCH','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON') then raise exception 'Candidate not found'; end if;
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
  if c.candidate_type not in ('FAMILY_CONTEXT_MATCH','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON') and c.metadata->>'relationship_id' is not null then
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
 if not found or c.candidate_type not in ('FAMILY_CONTEXT_MATCH','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON') then raise exception 'Candidate not found'; end if;
 if c.validation_status is distinct from 'UNVALIDATED' or c.confidence is distinct from 'LOW' or (c.metadata->'kinship_confirmed') is distinct from 'false'::jsonb then raise exception 'Unvalidated family context required'; end if;
 if c.candidate_type in ('FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON') and c.metadata->'identity_confirmed' is distinct from 'false'::jsonb then raise exception 'Network identity is unresolved'; end if;
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

-- Draft for MAX TEST only. Derived from the live 18-metric function.
-- Retains SECURITY DEFINER and service-only EXECUTE; uses qualified relations.
-- Reviewed/rejected evidence remains a valid scoped historical reference.
-- Known personal identifier, age, and address keys are prohibited only for family clues.
CREATE OR REPLACE FUNCTION public.max_invariant_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
with metrics as (
  select

    (select count(*) from public.candidate_entities c where c.candidate_type in ('FAMILY_NETWORK_PIVOT','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON')
      and (c.confidence is distinct from 'LOW' or coalesce(c.validation_status not in ('UNVALIDATED','REJECTED'),true)
        or c.metadata->'kinship_confirmed' is distinct from 'false'::jsonb or c.metadata->'identity_confirmed' is distinct from 'false'::jsonb))::int as unsafe_family_network_candidates,
    (select count(*) from public.candidate_entities c where c.candidate_type in ('FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON')
      and not exists(select 1 from public.evidence e where e.id=case when c.metadata->>'evidence_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (c.metadata->>'evidence_id')::uuid else null end and e.organization_id=c.organization_id and e.lead_id=c.lead_id))::int as family_network_candidates_without_scoped_evidence,
    (select count(*) from public.candidate_entities c where c.candidate_type in ('FAMILY_NETWORK_PIVOT','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON') and private.family_network_private_fields(c.metadata))::int as family_network_with_personal_data,
    (select count(*) from public.candidate_entities c, lateral jsonb_array_elements(case when jsonb_typeof(c.metadata->'public_graph'->'edges')='array' then c.metadata->'public_graph'->'edges' else '[]'::jsonb end) e
      where c.candidate_type='FAMILY_NETWORK_PIVOT' and (
       coalesce(e->>'kind','') not in('QSA_PARTICIPATION','SAME_NAME_CANDIDATE','SURNAME_CONTEXT_CANDIDATE','ROOT_CONTEXT_CANDIDATE')
       or e->>'validation_status' is distinct from 'UNVALIDATED' or e->>'confidence' is distinct from 'LOW'
       or e->'identity_confirmed' is distinct from 'false'::jsonb or e->'kinship_confirmed' is distinct from 'false'::jsonb
       or jsonb_typeof(e->'evidence_ids') is distinct from 'array'
       or case when jsonb_typeof(e->'evidence_ids')='array' then jsonb_array_length(e->'evidence_ids') else 0 end=0
       or not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(c.metadata->'public_graph'->'nodes')='array' then c.metadata->'public_graph'->'nodes' else '[]'::jsonb end) n where n->>'key'=e->>'from')
       or not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(c.metadata->'public_graph'->'nodes')='array' then c.metadata->'public_graph'->'nodes' else '[]'::jsonb end) n where n->>'key'=e->>'to')
       or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(e->'evidence_ids')='array' then e->'evidence_ids' else '[]'::jsonb end) refs(ref_id) where not exists(select 1 from public.evidence d where d.id=case when refs.ref_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then refs.ref_id::uuid else null end and d.organization_id=c.organization_id and d.lead_id=c.lead_id))
      ))::int as unsafe_family_network_edges,
    (select count(*) from public.claims c
      where c.classification='FACT' and c.status='VERIFIED'
      and not exists (
        select 1 from public.claim_evidence ce join public.evidence e on e.id=ce.evidence_id
        where ce.claim_id=c.id and e.organization_id=c.organization_id and ce.organization_id=c.organization_id and ce.support_type='SUPPORTS' and e.verification_status='VERIFIED'
      ))::int as verified_facts_without_verified_evidence,

    (select count(*) from public.events ev
      where ev.status='VERIFIED'
      and not exists (
        select 1 from public.event_evidence ee join public.evidence e on e.id=ee.evidence_id
        where ee.event_id=ev.id and e.organization_id=ev.organization_id and ee.organization_id=ev.organization_id and ee.support_type='SUPPORTS' and e.verification_status='VERIFIED'
      ))::int as verified_events_without_verified_evidence,

    (select count(*) from public.relationships r
      where r.status='VERIFIED'
      and not exists (
        select 1 from public.relationship_evidence re join public.evidence e on e.id=re.evidence_id
        where re.relationship_id=r.id and e.organization_id=r.organization_id and re.organization_id=r.organization_id and re.support_type='SUPPORTS' and e.verification_status='VERIFIED'
      ))::int as verified_relationships_without_verified_evidence,

    (select count(*) from public.relationships r
      where r.relationship_type='FAMILY' and r.status='VERIFIED'
      and (r.classification<>'FACT' or not exists (
        select 1 from public.relationship_evidence re join public.evidence e on e.id=re.evidence_id
        where re.relationship_id=r.id and e.organization_id=r.organization_id and re.organization_id=r.organization_id and re.support_type='SUPPORTS' and e.verification_status='VERIFIED'
      )))::int as unsafe_verified_family_relationships,

    (select count(*) from public.leads l
      where l.identity_confirmed_by_user=true and l.identity_status<>'VERIFIED')::int as confirmed_leads_not_verified,

    (select count(*) from public.leads l
      where l.kind='PERSON' and l.identity_status='VERIFIED' and l.identity_confirmed_by_user=false)::int as person_verified_without_user_confirmation,

    (select count(*) from public.candidate_entities c
      where c.entity_type='COMPANY' and c.validation_status='CONFIRMED'
      and not private.is_valid_cnpj(c.metadata->>'full_cnpj'))::int as confirmed_company_candidates_without_cnpj,

    (select count(*) from public.identity_assessments ia
      where ia.decision='CONFIRMED'
      and not exists (select 1 from public.identity_assessments newer where newer.candidate_entity_id=ia.candidate_entity_id and (newer.created_at,newer.id)>(ia.created_at,ia.id))
      and not exists (
        select 1 from public.candidate_entities c
        where c.id=ia.candidate_entity_id and c.validation_status='CONFIRMED'
      ))::int as confirmed_identity_assessments_without_confirmed_candidate,

    (select count(*) from public.research_runs rr
      where rr.status='RUNNING' and coalesce(rr.started_at,rr.created_at)<now()-interval '30 minutes')::int as stuck_research_runs,

    (select count(*) from public.research_job_queue q
      where q.status='RUNNING' and coalesce(q.started_at,q.created_at)<now()-interval '20 minutes')::int as stuck_research_jobs,

    (select count(*) from public.relationships r
      join public.leads l on l.id=r.lead_id
      where r.organization_id<>l.organization_id)::int as cross_org_relationship_lead_mismatch,

    (select count(*) from public.evidence e
      join public.leads l on l.id=e.lead_id
      where e.lead_id is not null and e.organization_id<>l.organization_id)::int as cross_org_evidence_lead_mismatch,

    (select count(*) from pg_catalog.pg_policies p
      where p.schemaname='public'
      and p.tablename in (
        'candidate_entities','claim_evidence','claims','commercial_signals','companies',
        'divergences','event_evidence','events','evidence','investigation_questions',
        'lead_company_links','people','relationship_evidence','relationships','research_runs',
        'research_steps','source_fetch_logs','research_job_queue','identity_assessments',
        'identity_status_audit','identity_source_attempts'
      )
      and p.cmd<>'SELECT')::int as core_browser_mutation_policies,

    (select count(*) from public.leads l
      where l.initial_cnpj is not null and not private.is_valid_cnpj(l.initial_cnpj))::int as invalid_lead_cnpjs,

    (select count(*) from public.companies c
      where c.cnpj is not null and not private.is_valid_cnpj(c.cnpj))::int as invalid_company_cnpjs,

    (select count(*) from public.research_job_queue q
      where q.result::text ~ '\*\*\*[0-9]{4,}\*\*')::int as masked_partner_identifiers_in_queue,

    (select count(*) from public.candidate_entities c
      where c.metadata::text ~ '\*\*\*[0-9]{4,}\*\*')::int as masked_partner_identifiers_in_candidates,

    (select count(*) from public.evidence e
      where coalesce(e.excerpt,'') ~ '\*\*\*[0-9]{4,}\*\*'
         or coalesce(e.raw_reference,'') ~ '\*\*\*[0-9]{4,}\*\*')::int as masked_partner_identifiers_in_evidence,
    
    (select count(*) from public.candidate_entities c
      where c.candidate_type='FAMILY_CONTEXT_MATCH'
      and (
        c.confidence is distinct from 'LOW'
        or coalesce(c.validation_status not in ('UNVALIDATED','REJECTED'),true)
        or c.metadata->'kinship_confirmed' is distinct from 'false'::jsonb
      ))::int as unsafe_family_context_candidates,

    (select count(*) from public.candidate_entities c
      where c.candidate_type='FAMILY_CONTEXT_MATCH'
      and not exists (
        select 1 from public.evidence e
        where e.id=case
          when c.metadata->>'evidence_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (c.metadata->>'evidence_id')::uuid
          else null
        end
        and e.organization_id=c.organization_id
        and e.lead_id=c.lead_id
      ))::int as family_context_candidates_without_scoped_evidence,

    (select count(*) from public.candidate_entities c
      where c.candidate_type='FAMILY_CONTEXT_MATCH'
      and jsonb_path_exists(
        c.metadata,
        '$.** ? (@.type() == "object").keyvalue() ? (
          @.key == "cpf"
          || @.key == "cnpj_cpf"
          || @.key == "cnpj_cpf_partner"
          || @.key == "cnpj_cpf_representative"
          || @.key == "cpf_partner"
          || @.key == "cpf_representative"
          || @.key == "partner_identifier"
          || @.key == "age"
          || @.key == "age_group"
          || @.key == "faixa_etaria"
          || @.key == "address"
          || @.key == "personal_address"
          || @.key == "residential_address"
        )'
      ))::int as family_context_candidates_with_personal_data
)
select jsonb_build_object(
  'checked_at',now(),
  'metrics',to_jsonb(metrics),
  'critical_count',
    (verified_facts_without_verified_evidence
    +verified_events_without_verified_evidence
    +verified_relationships_without_verified_evidence
    +unsafe_verified_family_relationships
    +confirmed_leads_not_verified
    +person_verified_without_user_confirmation
    +confirmed_company_candidates_without_cnpj
    +confirmed_identity_assessments_without_confirmed_candidate
    +cross_org_relationship_lead_mismatch
    +cross_org_evidence_lead_mismatch
    +core_browser_mutation_policies
    +invalid_lead_cnpjs
    +invalid_company_cnpjs
    +masked_partner_identifiers_in_queue
    +masked_partner_identifiers_in_candidates
    +masked_partner_identifiers_in_evidence
    +unsafe_family_context_candidates
    +family_context_candidates_without_scoped_evidence
    +family_context_candidates_with_personal_data+unsafe_family_network_candidates+family_network_candidates_without_scoped_evidence+family_network_with_personal_data+unsafe_family_network_edges),
  'warning_count',(stuck_research_runs+stuck_research_jobs)
)
from metrics;
$function$;

REVOKE ALL ON FUNCTION public.max_invariant_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.max_invariant_snapshot() TO service_role;
