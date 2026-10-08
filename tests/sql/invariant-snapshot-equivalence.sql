-- Independent equivalence QA: only literal CTE fixtures; no public tables, DDL or writes.
-- JSON values are synthetic. SQL NULL is compared with IS NOT DISTINCT FROM, not coalesced away.
with nodes_fixture(id,nodes) as (values
('nodes_0',NULL::jsonb),
('nodes_1','null'::jsonb),
('nodes_2','[]'::jsonb),
('nodes_3','{}'::jsonb),
('nodes_4','"nodes"'::jsonb),
('nodes_5','1'::jsonb),
('nodes_6','false'::jsonb),
('nodes_7','[{"key":"a"},{"key":"b"}]'::jsonb),
('nodes_8','[{"key":"a"},{"key":"a"},{"key":"b"}]'::jsonb),
('nodes_9','[{"key":null},{"key":"a"},{}]'::jsonb),
('nodes_10','[null,1,"a",false,[],{}]'::jsonb),
('nodes_11','[{"key":""}]'::jsonb),
('nodes_12','[{"key":"a b"}]'::jsonb),
('nodes_13','[{"key":1}]'::jsonb),
('nodes_14','[{"key":true}]'::jsonb),
('nodes_15','[{"key":{"x":1}}]'::jsonb),
('nodes_16','[{"key":["a"]}]'::jsonb),
('nodes_17','[{"key":"a\"b"}]'::jsonb),
('nodes_18','[{"key":"São"}]'::jsonb),
('nodes_19','[{"key":"null"}]'::jsonb)
), endpoint_fixture(id,value) as (values
('endpoint_0',NULL::jsonb),
('endpoint_1','null'::jsonb),
('endpoint_2','"a"'::jsonb),
('endpoint_3','"b"'::jsonb),
('endpoint_4','"missing"'::jsonb),
('endpoint_5','""'::jsonb),
('endpoint_6','1'::jsonb),
('endpoint_7','true'::jsonb),
('endpoint_8','false'::jsonb),
('endpoint_9','{"x":1}'::jsonb),
('endpoint_10','["a"]'::jsonb),
('endpoint_11','"a\"b"'::jsonb),
('endpoint_12','"a b"'::jsonb),
('endpoint_13','"São"'::jsonb),
('endpoint_14','"null"'::jsonb)
), normalized_nodes as materialized (
 select id,case when jsonb_typeof(nodes)='array' then nodes else '[]'::jsonb end as nodes,
 array(select n->>'key' from jsonb_array_elements(case when jsonb_typeof(nodes)='array' then nodes else '[]'::jsonb end) n) as node_keys
 from nodes_fixture
), membership as (
 select n.id||'/'||f.id||'/'||t.id as id,
 not exists(select 1 from jsonb_array_elements(n.nodes) x where x->>'key'=e.edge->>'from') as old_from,
 not coalesce(e.edge->>'from'=any(n.node_keys),false) as new_from,
 not exists(select 1 from jsonb_array_elements(n.nodes) x where x->>'key'=e.edge->>'to') as old_to,
 not coalesce(e.edge->>'to'=any(n.node_keys),false) as new_to
 from normalized_nodes n cross join endpoint_fixture f cross join endpoint_fixture t
 cross join lateral(select jsonb_build_object('from',f.value,'to',t.value) as edge) e
), edge_fixture(id,edges) as (values
('edges_0','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb),
('edges_1','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"HIGH","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb),
('edges_2','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":null,"to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb),
('edges_3','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"missing","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb),
('edges_4','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":[]}]'::jsonb),
('edges_5','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":null}]'::jsonb),
('edges_6','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":"bad"}]'::jsonb),
('edges_7','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111112"]}]'::jsonb),
('edges_8','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111113"]}]'::jsonb),
('edges_9','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":[null]}]'::jsonb),
('edges_10','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":[1]}]'::jsonb),
('edges_11','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":[{"id":"11111111-1111-4111-8111-111111111111"}]}]'::jsonb),
('edges_12','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111","11111111-1111-4111-8111-111111111111"]}]'::jsonb),
('edges_13','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb),
('edges_14','[null]'::jsonb),
('edges_15','["edge"]'::jsonb),
('edges_16','[1]'::jsonb),
('edges_17','[]'::jsonb),
('edges_18','null'::jsonb),
('edges_19','"edges"'::jsonb),
('edges_20','{}'::jsonb),
('edges_21','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]},{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"LOW","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb),
('edges_22','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"HIGH","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]},{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"HIGH","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb)
), scope_fixture(id,organization_id,lead_id) as (values
 ('own', '22222222-2222-4222-8222-222222222222'::uuid,'33333333-3333-4333-8333-333333333333'::uuid),
 ('foreign_org','22222222-2222-4222-8222-222222222223'::uuid,'33333333-3333-4333-8333-333333333333'::uuid),
 ('null_org',NULL::uuid,'33333333-3333-4333-8333-333333333333'::uuid),
 ('null_lead','22222222-2222-4222-8222-222222222222'::uuid,NULL::uuid)
), evidence_fixture(id,organization_id,lead_id) as (values
 ('11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,'33333333-3333-4333-8333-333333333333'::uuid),
 ('11111111-1111-4111-8111-111111111112'::uuid,'22222222-2222-4222-8222-222222222223'::uuid,'33333333-3333-4333-8333-333333333333'::uuid),
 ('11111111-1111-4111-8111-111111111113'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,'33333333-3333-4333-8333-333333333334'::uuid)
), graph_fixture(id,organization_id,lead_id,candidate_type,metadata) as materialized (
 select n.id||'/'||e.id||'/'||s.id,s.organization_id,s.lead_id,'FAMILY_NETWORK_PIVOT'::text,jsonb_build_object('public_graph',jsonb_build_object('nodes',n.nodes,'edges',e.edges))
 from nodes_fixture n cross join edge_fixture e cross join scope_fixture s
 union all select 'excluded_type',s.organization_id,s.lead_id,'OTHER',jsonb_build_object('public_graph',jsonb_build_object('nodes','[]'::jsonb,'edges','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"HIGH","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb)) from scope_fixture s where s.id='own'
 union all select 'metadata_sql_null',s.organization_id,s.lead_id,'FAMILY_NETWORK_PIVOT',NULL::jsonb from scope_fixture s where s.id='own'
 union all select 'graph_nonobject',s.organization_id,s.lead_id,'FAMILY_NETWORK_PIVOT','{"public_graph":false}'::jsonb from scope_fixture s where s.id='own'
 union all select 'duplicate_pivot_a',s.organization_id,s.lead_id,'FAMILY_NETWORK_PIVOT',jsonb_build_object('public_graph',jsonb_build_object('nodes','[{"key":"a"},{"key":"b"}]'::jsonb,'edges','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"HIGH","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb)) from scope_fixture s where s.id='own'
 union all select 'duplicate_pivot_b',s.organization_id,s.lead_id,'FAMILY_NETWORK_PIVOT',jsonb_build_object('public_graph',jsonb_build_object('nodes','[{"key":"a"},{"key":"b"}]'::jsonb,'edges','[{"kind":"QSA_PARTICIPATION","validation_status":"UNVALIDATED","confidence":"HIGH","identity_confirmed":false,"kinship_confirmed":false,"from":"a","to":"b","evidence_ids":["11111111-1111-4111-8111-111111111111"]}]'::jsonb)) from scope_fixture s where s.id='own'
), old_network as materialized (
 select c.id,count(*) filter(where (
 coalesce(e->>'kind','') not in('QSA_PARTICIPATION','SAME_NAME_CANDIDATE','SURNAME_CONTEXT_CANDIDATE','ROOT_CONTEXT_CANDIDATE')
 or e->>'validation_status' is distinct from 'UNVALIDATED' or e->>'confidence' is distinct from 'LOW'
 or e->'identity_confirmed' is distinct from 'false'::jsonb or e->'kinship_confirmed' is distinct from 'false'::jsonb
 or jsonb_typeof(e->'evidence_ids') is distinct from 'array'
 or case when jsonb_typeof(e->'evidence_ids')='array' then jsonb_array_length(e->'evidence_ids') else 0 end=0
 or not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(c.metadata->'public_graph'->'nodes')='array' then c.metadata->'public_graph'->'nodes' else '[]'::jsonb end) n where n->>'key'=e->>'from') or not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(c.metadata->'public_graph'->'nodes')='array' then c.metadata->'public_graph'->'nodes' else '[]'::jsonb end) n where n->>'key'=e->>'to')
 or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(e->'evidence_ids')='array' then e->'evidence_ids' else '[]'::jsonb end) refs(ref_id)
  where not exists(select 1 from evidence_fixture d where d.id=case when refs.ref_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then refs.ref_id::uuid else null end and d.organization_id=c.organization_id and d.lead_id=c.lead_id))
)) as unsafe_count
 from graph_fixture c, lateral jsonb_array_elements(case when jsonb_typeof(c.metadata->'public_graph'->'edges')='array' then c.metadata->'public_graph'->'edges' else '[]'::jsonb end) e
 where c.candidate_type='FAMILY_NETWORK_PIVOT' group by c.id
), network_graphs as materialized (
 select c.id,c.organization_id,c.lead_id,c.metadata->'public_graph' as graph from graph_fixture c where c.candidate_type='FAMILY_NETWORK_PIVOT'
), network_checks as materialized (
 select g.id,g.organization_id,g.lead_id,case when jsonb_typeof(g.graph->'edges')='array' then g.graph->'edges' else '[]'::jsonb end as edges,
 array(select n->>'key' from jsonb_array_elements(case when jsonb_typeof(g.graph->'nodes')='array' then g.graph->'nodes' else '[]'::jsonb end) n) as node_keys from network_graphs g
), new_network as materialized (
 select c.id,count(*) filter(where (
 coalesce(e->>'kind','') not in('QSA_PARTICIPATION','SAME_NAME_CANDIDATE','SURNAME_CONTEXT_CANDIDATE','ROOT_CONTEXT_CANDIDATE')
 or e->>'validation_status' is distinct from 'UNVALIDATED' or e->>'confidence' is distinct from 'LOW'
 or e->'identity_confirmed' is distinct from 'false'::jsonb or e->'kinship_confirmed' is distinct from 'false'::jsonb
 or jsonb_typeof(e->'evidence_ids') is distinct from 'array'
 or case when jsonb_typeof(e->'evidence_ids')='array' then jsonb_array_length(e->'evidence_ids') else 0 end=0
 or not coalesce(e->>'from'=any(c.node_keys),false) or not coalesce(e->>'to'=any(c.node_keys),false)
 or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(e->'evidence_ids')='array' then e->'evidence_ids' else '[]'::jsonb end) refs(ref_id)
  where not exists(select 1 from evidence_fixture d where d.id=case when refs.ref_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then refs.ref_id::uuid else null end and d.organization_id=c.organization_id and d.lead_id=c.lead_id))
)) as unsafe_count from network_checks c,lateral jsonb_array_elements(c.edges) e group by c.id
), network_compare as (
 select f.id,coalesce(o.unsafe_count,0) as old_count,coalesce(n.unsafe_count,0) as new_count from graph_fixture f left join old_network o using(id) left join new_network n using(id)
), privacy_fixture(id,metadata,expected) as (values
('cpf_root_null','{"cpf":null}'::jsonb,true),
('cpf_nested','{"outer":{"cpf":0}}'::jsonb,true),
('cpf_array','[{"outer":[{"cpf":null}]}]'::jsonb,true),
('cpf_upper','{"CPF":null}'::jsonb,false),
('cpf_suffix','{"cpf_suffix":null}'::jsonb,false),
('cpf_prefix','{"prefix_cpf":null}'::jsonb,false),
('cpf_quoted_prefix','{"prefix \"cpf":null}'::jsonb,false),
('cpf_brace_quote_prefix','{"{\"cpf":null}'::jsonb,false),
('cpf_comma_quote_prefix','{",\"cpf":null}'::jsonb,false),
('cpf_value_fake_json','{"note":"{\"cpf\": null}"}'::jsonb,false),
('cpf_scalar_fake_json','"{\"cpf\": null}"'::jsonb,false),
('cpf_value_name','{"note":"cpf"}'::jsonb,false),
('cnpj_cpf_root_null','{"cnpj_cpf":null}'::jsonb,true),
('cnpj_cpf_nested','{"outer":{"cnpj_cpf":0}}'::jsonb,true),
('cnpj_cpf_array','[{"outer":[{"cnpj_cpf":null}]}]'::jsonb,true),
('cnpj_cpf_upper','{"CNPJ_CPF":null}'::jsonb,false),
('cnpj_cpf_suffix','{"cnpj_cpf_suffix":null}'::jsonb,false),
('cnpj_cpf_prefix','{"prefix_cnpj_cpf":null}'::jsonb,false),
('cnpj_cpf_quoted_prefix','{"prefix \"cnpj_cpf":null}'::jsonb,false),
('cnpj_cpf_brace_quote_prefix','{"{\"cnpj_cpf":null}'::jsonb,false),
('cnpj_cpf_comma_quote_prefix','{",\"cnpj_cpf":null}'::jsonb,false),
('cnpj_cpf_value_fake_json','{"note":"{\"cnpj_cpf\": null}"}'::jsonb,false),
('cnpj_cpf_scalar_fake_json','"{\"cnpj_cpf\": null}"'::jsonb,false),
('cnpj_cpf_value_name','{"note":"cnpj_cpf"}'::jsonb,false),
('cnpj_cpf_partner_root_null','{"cnpj_cpf_partner":null}'::jsonb,true),
('cnpj_cpf_partner_nested','{"outer":{"cnpj_cpf_partner":0}}'::jsonb,true),
('cnpj_cpf_partner_array','[{"outer":[{"cnpj_cpf_partner":null}]}]'::jsonb,true),
('cnpj_cpf_partner_upper','{"CNPJ_CPF_PARTNER":null}'::jsonb,false),
('cnpj_cpf_partner_suffix','{"cnpj_cpf_partner_suffix":null}'::jsonb,false),
('cnpj_cpf_partner_prefix','{"prefix_cnpj_cpf_partner":null}'::jsonb,false),
('cnpj_cpf_partner_quoted_prefix','{"prefix \"cnpj_cpf_partner":null}'::jsonb,false),
('cnpj_cpf_partner_brace_quote_prefix','{"{\"cnpj_cpf_partner":null}'::jsonb,false),
('cnpj_cpf_partner_comma_quote_prefix','{",\"cnpj_cpf_partner":null}'::jsonb,false),
('cnpj_cpf_partner_value_fake_json','{"note":"{\"cnpj_cpf_partner\": null}"}'::jsonb,false),
('cnpj_cpf_partner_scalar_fake_json','"{\"cnpj_cpf_partner\": null}"'::jsonb,false),
('cnpj_cpf_partner_value_name','{"note":"cnpj_cpf_partner"}'::jsonb,false),
('cnpj_cpf_representative_root_null','{"cnpj_cpf_representative":null}'::jsonb,true),
('cnpj_cpf_representative_nested','{"outer":{"cnpj_cpf_representative":0}}'::jsonb,true),
('cnpj_cpf_representative_array','[{"outer":[{"cnpj_cpf_representative":null}]}]'::jsonb,true),
('cnpj_cpf_representative_upper','{"CNPJ_CPF_REPRESENTATIVE":null}'::jsonb,false),
('cnpj_cpf_representative_suffix','{"cnpj_cpf_representative_suffix":null}'::jsonb,false),
('cnpj_cpf_representative_prefix','{"prefix_cnpj_cpf_representative":null}'::jsonb,false),
('cnpj_cpf_representative_quoted_prefix','{"prefix \"cnpj_cpf_representative":null}'::jsonb,false),
('cnpj_cpf_representative_brace_quote_prefix','{"{\"cnpj_cpf_representative":null}'::jsonb,false),
('cnpj_cpf_representative_comma_quote_prefix','{",\"cnpj_cpf_representative":null}'::jsonb,false),
('cnpj_cpf_representative_value_fake_json','{"note":"{\"cnpj_cpf_representative\": null}"}'::jsonb,false),
('cnpj_cpf_representative_scalar_fake_json','"{\"cnpj_cpf_representative\": null}"'::jsonb,false),
('cnpj_cpf_representative_value_name','{"note":"cnpj_cpf_representative"}'::jsonb,false),
('cpf_partner_root_null','{"cpf_partner":null}'::jsonb,true),
('cpf_partner_nested','{"outer":{"cpf_partner":0}}'::jsonb,true),
('cpf_partner_array','[{"outer":[{"cpf_partner":null}]}]'::jsonb,true),
('cpf_partner_upper','{"CPF_PARTNER":null}'::jsonb,false),
('cpf_partner_suffix','{"cpf_partner_suffix":null}'::jsonb,false),
('cpf_partner_prefix','{"prefix_cpf_partner":null}'::jsonb,false),
('cpf_partner_quoted_prefix','{"prefix \"cpf_partner":null}'::jsonb,false),
('cpf_partner_brace_quote_prefix','{"{\"cpf_partner":null}'::jsonb,false),
('cpf_partner_comma_quote_prefix','{",\"cpf_partner":null}'::jsonb,false),
('cpf_partner_value_fake_json','{"note":"{\"cpf_partner\": null}"}'::jsonb,false),
('cpf_partner_scalar_fake_json','"{\"cpf_partner\": null}"'::jsonb,false),
('cpf_partner_value_name','{"note":"cpf_partner"}'::jsonb,false),
('cpf_representative_root_null','{"cpf_representative":null}'::jsonb,true),
('cpf_representative_nested','{"outer":{"cpf_representative":0}}'::jsonb,true),
('cpf_representative_array','[{"outer":[{"cpf_representative":null}]}]'::jsonb,true),
('cpf_representative_upper','{"CPF_REPRESENTATIVE":null}'::jsonb,false),
('cpf_representative_suffix','{"cpf_representative_suffix":null}'::jsonb,false),
('cpf_representative_prefix','{"prefix_cpf_representative":null}'::jsonb,false),
('cpf_representative_quoted_prefix','{"prefix \"cpf_representative":null}'::jsonb,false),
('cpf_representative_brace_quote_prefix','{"{\"cpf_representative":null}'::jsonb,false),
('cpf_representative_comma_quote_prefix','{",\"cpf_representative":null}'::jsonb,false),
('cpf_representative_value_fake_json','{"note":"{\"cpf_representative\": null}"}'::jsonb,false),
('cpf_representative_scalar_fake_json','"{\"cpf_representative\": null}"'::jsonb,false),
('cpf_representative_value_name','{"note":"cpf_representative"}'::jsonb,false),
('partner_identifier_root_null','{"partner_identifier":null}'::jsonb,true),
('partner_identifier_nested','{"outer":{"partner_identifier":0}}'::jsonb,true),
('partner_identifier_array','[{"outer":[{"partner_identifier":null}]}]'::jsonb,true),
('partner_identifier_upper','{"PARTNER_IDENTIFIER":null}'::jsonb,false),
('partner_identifier_suffix','{"partner_identifier_suffix":null}'::jsonb,false),
('partner_identifier_prefix','{"prefix_partner_identifier":null}'::jsonb,false),
('partner_identifier_quoted_prefix','{"prefix \"partner_identifier":null}'::jsonb,false),
('partner_identifier_brace_quote_prefix','{"{\"partner_identifier":null}'::jsonb,false),
('partner_identifier_comma_quote_prefix','{",\"partner_identifier":null}'::jsonb,false),
('partner_identifier_value_fake_json','{"note":"{\"partner_identifier\": null}"}'::jsonb,false),
('partner_identifier_scalar_fake_json','"{\"partner_identifier\": null}"'::jsonb,false),
('partner_identifier_value_name','{"note":"partner_identifier"}'::jsonb,false),
('age_root_null','{"age":null}'::jsonb,true),
('age_nested','{"outer":{"age":0}}'::jsonb,true),
('age_array','[{"outer":[{"age":null}]}]'::jsonb,true),
('age_upper','{"AGE":null}'::jsonb,false),
('age_suffix','{"age_suffix":null}'::jsonb,false),
('age_prefix','{"prefix_age":null}'::jsonb,false),
('age_quoted_prefix','{"prefix \"age":null}'::jsonb,false),
('age_brace_quote_prefix','{"{\"age":null}'::jsonb,false),
('age_comma_quote_prefix','{",\"age":null}'::jsonb,false),
('age_value_fake_json','{"note":"{\"age\": null}"}'::jsonb,false),
('age_scalar_fake_json','"{\"age\": null}"'::jsonb,false),
('age_value_name','{"note":"age"}'::jsonb,false),
('age_group_root_null','{"age_group":null}'::jsonb,true),
('age_group_nested','{"outer":{"age_group":0}}'::jsonb,true),
('age_group_array','[{"outer":[{"age_group":null}]}]'::jsonb,true),
('age_group_upper','{"AGE_GROUP":null}'::jsonb,false),
('age_group_suffix','{"age_group_suffix":null}'::jsonb,false),
('age_group_prefix','{"prefix_age_group":null}'::jsonb,false),
('age_group_quoted_prefix','{"prefix \"age_group":null}'::jsonb,false),
('age_group_brace_quote_prefix','{"{\"age_group":null}'::jsonb,false),
('age_group_comma_quote_prefix','{",\"age_group":null}'::jsonb,false),
('age_group_value_fake_json','{"note":"{\"age_group\": null}"}'::jsonb,false),
('age_group_scalar_fake_json','"{\"age_group\": null}"'::jsonb,false),
('age_group_value_name','{"note":"age_group"}'::jsonb,false),
('faixa_etaria_root_null','{"faixa_etaria":null}'::jsonb,true),
('faixa_etaria_nested','{"outer":{"faixa_etaria":0}}'::jsonb,true),
('faixa_etaria_array','[{"outer":[{"faixa_etaria":null}]}]'::jsonb,true),
('faixa_etaria_upper','{"FAIXA_ETARIA":null}'::jsonb,false),
('faixa_etaria_suffix','{"faixa_etaria_suffix":null}'::jsonb,false),
('faixa_etaria_prefix','{"prefix_faixa_etaria":null}'::jsonb,false),
('faixa_etaria_quoted_prefix','{"prefix \"faixa_etaria":null}'::jsonb,false),
('faixa_etaria_brace_quote_prefix','{"{\"faixa_etaria":null}'::jsonb,false),
('faixa_etaria_comma_quote_prefix','{",\"faixa_etaria":null}'::jsonb,false),
('faixa_etaria_value_fake_json','{"note":"{\"faixa_etaria\": null}"}'::jsonb,false),
('faixa_etaria_scalar_fake_json','"{\"faixa_etaria\": null}"'::jsonb,false),
('faixa_etaria_value_name','{"note":"faixa_etaria"}'::jsonb,false),
('address_root_null','{"address":null}'::jsonb,true),
('address_nested','{"outer":{"address":0}}'::jsonb,true),
('address_array','[{"outer":[{"address":null}]}]'::jsonb,true),
('address_upper','{"ADDRESS":null}'::jsonb,false),
('address_suffix','{"address_suffix":null}'::jsonb,false),
('address_prefix','{"prefix_address":null}'::jsonb,false),
('address_quoted_prefix','{"prefix \"address":null}'::jsonb,false),
('address_brace_quote_prefix','{"{\"address":null}'::jsonb,false),
('address_comma_quote_prefix','{",\"address":null}'::jsonb,false),
('address_value_fake_json','{"note":"{\"address\": null}"}'::jsonb,false),
('address_scalar_fake_json','"{\"address\": null}"'::jsonb,false),
('address_value_name','{"note":"address"}'::jsonb,false),
('personal_address_root_null','{"personal_address":null}'::jsonb,true),
('personal_address_nested','{"outer":{"personal_address":0}}'::jsonb,true),
('personal_address_array','[{"outer":[{"personal_address":null}]}]'::jsonb,true),
('personal_address_upper','{"PERSONAL_ADDRESS":null}'::jsonb,false),
('personal_address_suffix','{"personal_address_suffix":null}'::jsonb,false),
('personal_address_prefix','{"prefix_personal_address":null}'::jsonb,false),
('personal_address_quoted_prefix','{"prefix \"personal_address":null}'::jsonb,false),
('personal_address_brace_quote_prefix','{"{\"personal_address":null}'::jsonb,false),
('personal_address_comma_quote_prefix','{",\"personal_address":null}'::jsonb,false),
('personal_address_value_fake_json','{"note":"{\"personal_address\": null}"}'::jsonb,false),
('personal_address_scalar_fake_json','"{\"personal_address\": null}"'::jsonb,false),
('personal_address_value_name','{"note":"personal_address"}'::jsonb,false),
('residential_address_root_null','{"residential_address":null}'::jsonb,true),
('residential_address_nested','{"outer":{"residential_address":0}}'::jsonb,true),
('residential_address_array','[{"outer":[{"residential_address":null}]}]'::jsonb,true),
('residential_address_upper','{"RESIDENTIAL_ADDRESS":null}'::jsonb,false),
('residential_address_suffix','{"residential_address_suffix":null}'::jsonb,false),
('residential_address_prefix','{"prefix_residential_address":null}'::jsonb,false),
('residential_address_quoted_prefix','{"prefix \"residential_address":null}'::jsonb,false),
('residential_address_brace_quote_prefix','{"{\"residential_address":null}'::jsonb,false),
('residential_address_comma_quote_prefix','{",\"residential_address":null}'::jsonb,false),
('residential_address_value_fake_json','{"note":"{\"residential_address\": null}"}'::jsonb,false),
('residential_address_scalar_fake_json','"{\"residential_address\": null}"'::jsonb,false),
('residential_address_value_name','{"note":"residential_address"}'::jsonb,false),
('sql_null',NULL::jsonb,NULL::boolean),
('json_null','null'::jsonb,false),
('empty_object','{}'::jsonb,false),
('empty_array','[]'::jsonb,false),
('number','1'::jsonb,false),
('boolean','false'::jsonb,false),
('unicode_escaped_real_key','{"\u0063pf":null}'::jsonb,true),
('literal_unicode_name','{"\\u0063pf":null}'::jsonb,false),
('both_fake_and_real','{"note":"{ \"cpf\": 0 }","outer":{"age_group":null}}'::jsonb,true)
), privacy_compare as (
 select id,expected,jsonb_path_exists(metadata,'$.** ? (@.type() == "object").keyvalue() ? (
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
        )') as old_value,metadata::text ~ '(^|[,{])[[:space:]]*"(cpf|cnpj_cpf|cnpj_cpf_partner|cnpj_cpf_representative|cpf_partner|cpf_representative|partner_identifier|age|age_group|faixa_etaria|address|personal_address|residential_address)"[[:space:]]*:' as new_value from privacy_fixture
)
select jsonb_build_object(
 'membership_cases',(select count(*) from membership),
 'membership_mismatches',(select count(*) from membership where old_from is distinct from new_from or old_to is distinct from new_to),
 'network_cases',(select count(*) from network_compare),
 'network_mismatches',(select count(*) from network_compare where old_count<>new_count),
 'old_unsafe_edges',(select sum(old_count) from network_compare),
 'new_unsafe_edges',(select sum(new_count) from network_compare),
 'duplicate_pivots_old',(select sum(old_count) from network_compare where id in ('duplicate_pivot_a','duplicate_pivot_b')),
 'duplicate_pivots_new',(select sum(new_count) from network_compare where id in ('duplicate_pivot_a','duplicate_pivot_b')),
 'privacy_cases',(select count(*) from privacy_compare),
 'privacy_mismatches',(select count(*) from privacy_compare where old_value is distinct from new_value),
 'privacy_expected_mismatches',(select count(*) from privacy_compare where old_value is distinct from expected or new_value is distinct from expected),
 'failures',coalesce((select jsonb_agg(id) from privacy_compare where old_value is distinct from new_value or old_value is distinct from expected or new_value is distinct from expected),'[]'::jsonb)
);
