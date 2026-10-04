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
 insert into public.candidate_entities(id,organization_id,lead_id,entity_type,label,candidate_reason,candidate_type,confidence,validation_status,metadata,created_by)
 values(p_pivot,p_org,p_lead,'GROUP','Mapa de conexões do pivô','Progresso de CNPJ e citações QSA; identidade e parentesco pendentes de validação.','FAMILY_NETWORK_PIVOT','LOW','UNVALIDATED',jsonb_build_object('revision',0,'identity_confirmed',false,'kinship_confirmed',false),p_user)
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
