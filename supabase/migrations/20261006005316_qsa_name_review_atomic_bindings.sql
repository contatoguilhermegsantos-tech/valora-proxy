-- QSA name matches remain scoped to one human-selected business link.
create or replace function private.qsa_name_key(v text) returns text
language sql immutable security invoker set search_path='' as $$
 select trim(regexp_replace(regexp_replace(translate(upper(coalesce(v,'')),
 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ','AAAAAEEEEIIIIOOOOOUUUUCN'),'[^A-Z0-9 ]',' ','g'),' +',' ','g'))
$$;
create or replace function private.qsa_discovery_evidence_valid(p_org uuid,p_lead uuid,p_meta jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare d public.evidence%rowtype; r jsonb; v_full text:=p_meta->>'full_cnpj'; v_root text:=p_meta->>'basic_cnpj'; v_name text:=p_meta->>'partner_name';
begin
 if v_full is null or not private.is_valid_cnpj(v_full) or v_root is distinct from left(v_full,8) or length(private.qsa_name_key(v_name))<3 then return false; end if;
 select * into d from public.evidence e where e.id::text=p_meta->>'evidence_id' and e.organization_id=p_org and e.lead_id=p_lead;
 if not found or d.verification_status<>'VERIFIED' or d.document_type is distinct from 'RFB_QSA_NAME_DISCOVERY'
  or d.source_url is distinct from 'https://baseempresarial.com.br/empresa/'||v_full
  or not exists(select 1 from public.source_registry s where s.id=d.source_registry_id and s.key='base_empresarial_rfb') then return false; end if;
 if exists(select 1 from public.evidence e join public.source_registry s on s.id=e.source_registry_id and s.key='base_empresarial_rfb' where e.organization_id=p_org and e.lead_id=p_lead and e.document_type='RFB_QSA_NAME_DISCOVERY' and e.source_url='https://baseempresarial.com.br/empresa/'||v_full and e.raw_reference='partner_name='||v_name||'; basic_cnpj='||v_root and e.verification_status<>'VERIFIED') then return false; end if;
 begin r:=d.raw_reference::jsonb; exception when invalid_text_representation then r:=null; end;
 if r is not null then
  return coalesce(jsonb_typeof(r)='object' and r->>'schema_version'='2' and r->>'full_cnpj'=v_full and r->>'basic_cnpj'=v_root
   and private.qsa_name_key(r->>'partner_name')=private.qsa_name_key(v_name)
   and private.qsa_name_key(r->>'query_name')=private.qsa_name_key(v_name)
   and length(private.qsa_name_key(r->>'company_name'))>0 and private.qsa_name_key(r->>'company_name')=private.qsa_name_key(p_meta->>'company_name'),false);
 end if;
 return d.raw_reference is not distinct from 'partner_name='||v_name||'; basic_cnpj='||v_root;
end $$;
revoke all on function private.qsa_name_key(text),private.qsa_discovery_evidence_valid(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.qsa_name_key(text),private.qsa_discovery_evidence_valid(uuid,uuid,jsonb) to service_role;

create or replace function private.lock_qsa_discovery(p_org uuid,p_lead uuid,p_meta jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform e.id from public.evidence e where e.organization_id=p_org and e.lead_id=p_lead and (e.id::text=p_meta->>'evidence_id'
  or e.document_type='RFB_QSA_NAME_DISCOVERY' and e.source_url='https://baseempresarial.com.br/empresa/'||(p_meta->>'full_cnpj') and e.raw_reference='partner_name='||(p_meta->>'partner_name')||'; basic_cnpj='||(p_meta->>'basic_cnpj')) order by e.id for share;
end $$;
revoke all on function private.lock_qsa_discovery(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.lock_qsa_discovery(uuid,uuid,jsonb) to service_role;

create or replace function public.guard_qsa_candidate_review() returns trigger
language plpgsql security invoker set search_path='' as $$
declare review_action text:=current_setting('max.qsa_review_action',true); review_id text:=current_setting('max.qsa_review_candidate',true);
begin
 if old.candidate_type<>'RFB_QSA_NAME_MATCH' then return new; end if;
 if new.candidate_type is distinct from old.candidate_type or new.lead_id is distinct from old.lead_id or new.organization_id is distinct from old.organization_id
  or new.entity_type is distinct from old.entity_type then raise exception 'QSA candidate scope is immutable' using errcode='P0001'; end if;
 if old.validation_status in ('CONFIRMED','REJECTED') and
  ((new.metadata->>'full_cnpj') is distinct from (old.metadata->>'full_cnpj')
   or (new.metadata->>'basic_cnpj') is distinct from (old.metadata->>'basic_cnpj')
   or (new.metadata->>'partner_name') is distinct from (old.metadata->>'partner_name')
   or (new.metadata->>'company_name') is distinct from (old.metadata->>'company_name')
   or ((new.metadata->>'confirmed_registry_evidence_id') is distinct from (old.metadata->>'confirmed_registry_evidence_id') and not coalesce(old.metadata->>'confirmed_registry_evidence_id' is null and review_action='CONFIRM' and review_id=old.id::text,false))
   or ((new.metadata->>'confirmed_company_id') is distinct from (old.metadata->>'confirmed_company_id') and not coalesce(old.metadata->>'confirmed_company_id' is null and review_action='CONFIRM' and review_id=old.id::text,false))
   or (old.metadata->>'evidence_id' is not null and (new.metadata->>'evidence_id') is distinct from (old.metadata->>'evidence_id')))
 then raise exception 'Reviewed QSA occurrence is immutable; create a separate candidate' using errcode='P0001'; end if;
 if old.validation_status='REJECTED' and (new.validation_status<>'REJECTED' or new.confidence<>old.confidence
  or (new.metadata->'confirmed_by_user') is distinct from (old.metadata->'confirmed_by_user')
  or (new.metadata->'rejected_by_user') is distinct from (old.metadata->'rejected_by_user')
  or (new.metadata->'rejection_reason') is distinct from (old.metadata->'rejection_reason')
  or (new.metadata->>'evidence_id') is distinct from (old.metadata->>'evidence_id'))
 then raise exception 'Rejected QSA candidate cannot be reopened automatically' using errcode='P0001'; end if;
 if old.validation_status='CONFIRMED' and new.validation_status not in ('CONFIRMED','REJECTED') then raise exception 'Human QSA confirmation cannot be downgraded automatically' using errcode='P0001'; end if;
 if old.validation_status='CONFIRMED' and new.validation_status='CONFIRMED' and not coalesce(current_user='service_role' and review_id=old.id::text and review_action='CONFIRM',false) and
  ((new.metadata->'confirmed_by_user') is distinct from (old.metadata->'confirmed_by_user') or (new.metadata->'identity_confirmed') is distinct from (old.metadata->'identity_confirmed')
   or (new.metadata->'identity_confirmation_scope') is distinct from (old.metadata->'identity_confirmation_scope') or (new.metadata->'kinship_confirmed') is distinct from (old.metadata->'kinship_confirmed')
   or (new.metadata->'assigned_initial_cnpj') is distinct from (old.metadata->'assigned_initial_cnpj')) then raise exception 'Human QSA review fields are immutable' using errcode='P0001'; end if;
 if new.validation_status<>old.validation_status and new.validation_status in ('CONFIRMED','REJECTED') and
  (current_user<>'service_role' or review_id is distinct from old.id::text or review_action is distinct from case new.validation_status when 'CONFIRMED' then 'CONFIRM' else 'REJECT' end)
 then raise exception 'Explicit atomic QSA review required' using errcode='42501'; end if;
 if new.validation_status='SUPPORTED' or new.validation_status='CONFIRMED' and old.validation_status<>'CONFIRMED'
  or new.metadata->>'evidence_id' is distinct from old.metadata->>'evidence_id' and old.validation_status='CONFIRMED' then
  if not exists(select 1 from public.leads l where l.id=new.lead_id and l.organization_id=new.organization_id and l.kind='PERSON' and private.qsa_name_key(l.name)=private.qsa_name_key(new.metadata->>'partner_name')) then raise exception 'Current person name context required' using errcode='P0001'; end if;
  perform private.lock_qsa_discovery(new.organization_id,new.lead_id,new.metadata);
  if private.qsa_discovery_evidence_valid(new.organization_id,new.lead_id,new.metadata) is not true then raise exception 'Verified scoped QSA discovery required' using errcode='P0001'; end if;
 end if;
 return new;
end $$;
revoke all on function public.guard_qsa_candidate_review() from public,anon,authenticated;
grant execute on function public.guard_qsa_candidate_review() to service_role;
create trigger guard_qsa_candidate_review_trg before update on public.candidate_entities for each row execute function public.guard_qsa_candidate_review();

create or replace function public.review_qsa_name_candidate(p_org uuid,p_user uuid,p_candidate uuid,p_action text,p_reason text default null,p_company uuid default null,p_evidence uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.candidate_entities%rowtype; l public.leads%rowtype; co public.companies%rowtype; li public.lead_company_links%rowtype; d public.evidence%rowtype;
 v_lead uuid; v_cnpj text; v_action text:=upper(coalesce(p_action,'')); v_prior boolean; v_same_confirmed boolean; v_other_confirmed boolean; v_assigned boolean; v_old_action text; v_old_id text;
begin
 if current_user<>'service_role' then raise exception 'Service access required' using errcode='42501'; end if;
 if not exists(select 1 from public.profiles p join public.organization_members m on m.organization_id=p.active_organization_id and m.user_id=p.id where p.id=p_user and p.active_organization_id=p_org and m.status='ACTIVE' and m.role in ('OWNER','ADMIN','ANALYST','MEMBER')) then raise exception 'Operator access required' using errcode='42501'; end if;
 if v_action not in ('CONFIRM','REJECT') then raise exception 'Unsupported review action' using errcode='22023'; end if;
 select x.lead_id into v_lead from public.candidate_entities x where x.id=p_candidate and x.organization_id=p_org;
 if v_lead is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
 select * into l from public.leads x where x.id=v_lead and x.organization_id=p_org for update;
 if not found or l.kind<>'PERSON' then raise exception 'Person lead required for QSA review' using errcode='22023'; end if;
 select * into c from public.candidate_entities x where x.id=p_candidate and x.organization_id=p_org and x.lead_id=l.id for update;
 if not found or c.candidate_type<>'RFB_QSA_NAME_MATCH' or c.entity_type<>'COMPANY' then raise exception 'QSA company candidate required' using errcode='22023'; end if;
 v_cnpj:=c.metadata->>'full_cnpj';
 if v_cnpj is null or not private.is_valid_cnpj(v_cnpj) or left(v_cnpj,8) is distinct from c.metadata->>'basic_cnpj' then raise exception 'Valid candidate CNPJ required' using errcode='22023'; end if;
 v_old_action:=current_setting('max.qsa_review_action',true); v_old_id:=current_setting('max.qsa_review_candidate',true);
 perform set_config('max.qsa_review_action',v_action,true),set_config('max.qsa_review_candidate',c.id::text,true);
 if v_action='REJECT' then
  if length(trim(coalesce(p_reason,'')))<5 or length(p_reason)>1000 then raise exception 'Review reason required' using errcode='22023'; end if;
  if c.validation_status='REJECTED' then
   perform public.refresh_qsa_identity_status(p_org,p_user,l.id);
   perform set_config('max.qsa_review_action',coalesce(v_old_action,''),true),set_config('max.qsa_review_candidate',coalesce(v_old_id,''),true);
   return jsonb_build_object('ok',true,'candidate_id',c.id,'lead_id',l.id,'rejected',true,'reused',true);
  end if;
  v_prior:=c.validation_status='CONFIRMED';
  update public.candidate_entities set validation_status='REJECTED',confidence='LOW',metadata=metadata||jsonb_build_object('confirmed_by_user',false,'identity_confirmed',false,'identity_confirmation_scope','BUSINESS_LINK','kinship_confirmed',false,'rejected_by_user',true,'rejected_at',now(),'rejection_reason',trim(p_reason)) where id=c.id;
  select exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.validation_status='CONFIRMED') into v_other_confirmed;
  select exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.validation_status='CONFIRMED' and x.metadata->>'full_cnpj'=v_cnpj) into v_same_confirmed;
  if not v_same_confirmed then
   select * into co from public.companies x where x.organization_id=p_org and x.cnpj=v_cnpj;
   if found then
    update public.lead_company_links set status='REJECTED' where organization_id=p_org and lead_id=l.id and company_id=co.id and status not in ('REJECTED','CONTRADICTED') and (v_prior or status<>'VERIFIED');
    update public.relationships set status='REJECTED',reason='Vínculo rejeitado pelo usuário: '||trim(p_reason),updated_at=now() where organization_id=p_org and lead_id=l.id and from_entity_type='LEAD' and from_entity_id=l.id and to_entity_type='COMPANY' and to_entity_id=co.id and relationship_type='BUSINESS_LINK' and status not in ('REJECTED','CONTRADICTED') and (v_prior or status<>'VERIFIED');
   end if;
   if l.initial_cnpj=v_cnpj and exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.candidate_type='RFB_QSA_NAME_MATCH' and x.metadata->>'full_cnpj'=v_cnpj and x.metadata->>'assigned_initial_cnpj'='true' and x.validation_status in ('CONFIRMED','REJECTED')) then update public.leads set initial_cnpj=null,updated_at=now() where id=l.id; end if;
  end if;
  if v_prior and not v_other_confirmed then update public.leads set identity_confirmed_by_user=false,identity_status='CAUTION',updated_at=now() where id=l.id; end if;
  perform public.refresh_qsa_identity_status(p_org,p_user,l.id);
  insert into public.identity_assessments(organization_id,lead_id,candidate_entity_id,score,decision,factors,engine_version,explanation,created_by,created_at) values(p_org,l.id,c.id,0,'REJECTED',jsonb_build_object('user_rejected',true,'scope','BUSINESS_LINK','reason',trim(p_reason)),'qsa-review-v1','Vínculo selecionado rejeitado pelo usuário; outros vínculos e documentos preservados.',p_user,clock_timestamp());
  perform set_config('max.qsa_review_action',coalesce(v_old_action,''),true),set_config('max.qsa_review_candidate',coalesce(v_old_id,''),true);
  return jsonb_build_object('ok',true,'candidate_id',c.id,'lead_id',l.id,'rejected',true,'reused',false);
 end if;
 if c.validation_status='REJECTED' then raise exception 'Rejected candidate cannot be confirmed' using errcode='P0001'; end if;
 if private.qsa_name_key(c.metadata->>'partner_name') is distinct from private.qsa_name_key(l.name) then raise exception 'Lead name context changed; repeat discovery' using errcode='P0001'; end if;
 perform private.lock_qsa_discovery(p_org,l.id,c.metadata);
 if private.qsa_discovery_evidence_valid(p_org,l.id,c.metadata) is not true then raise exception 'Discovery evidence requires review or requery' using errcode='P0001'; end if;
 if p_company is null or p_evidence is null then raise exception 'Enriched company and evidence required' using errcode='22023'; end if;
 select * into co from public.companies x where x.id=p_company and x.organization_id=p_org and x.cnpj=v_cnpj for share;
 if not found then raise exception 'Company context mismatch' using errcode='P0001'; end if;
 select * into d from public.evidence x where x.id=p_evidence and x.organization_id=p_org and x.lead_id=l.id and x.company_id=co.id for share;
 if not found or d.verification_status<>'VERIFIED' or d.document_type is distinct from 'CNPJ_REGISTRY' or d.raw_reference is distinct from v_cnpj or not exists(select 1 from public.source_registry s where s.id=d.source_registry_id and s.key in ('brasilapi_cnpj','base_empresarial_rfb')) then raise exception 'Verified exact company registry required' using errcode='P0001'; end if;
 select * into li from public.lead_company_links x where x.organization_id=p_org and x.lead_id=l.id and x.company_id=co.id for update;
 if not found or li.status in ('REJECTED','CONTRADICTED') then raise exception 'Rejected or missing attribution requires review' using errcode='P0001'; end if;
 perform x.id from public.relationships x where x.organization_id=p_org and x.lead_id=l.id and x.from_entity_type='LEAD' and x.from_entity_id=l.id and x.to_entity_type='COMPANY' and x.to_entity_id=co.id and x.relationship_type='BUSINESS_LINK' for update;
 if exists(select 1 from public.relationships x where x.organization_id=p_org and x.lead_id=l.id and x.from_entity_type='LEAD' and x.from_entity_id=l.id and x.to_entity_type='COMPANY' and x.to_entity_id=co.id and x.relationship_type='BUSINESS_LINK' and x.status in ('REJECTED','CONTRADICTED')) then raise exception 'Rejected relationship requires review' using errcode='P0001'; end if;
 v_prior:=c.validation_status='CONFIRMED' and l.identity_confirmed_by_user and l.identity_status='VERIFIED' and li.status='VERIFIED';
 v_assigned:=l.initial_cnpj is null or coalesce(c.metadata->>'assigned_initial_cnpj'='true',false);
 update public.lead_company_links set status='VERIFIED',role_label=coalesce(c.metadata->>'partner_role','Vínculo empresarial selecionado pelo usuário') where id=li.id;
 update public.leads set initial_cnpj=coalesce(initial_cnpj,v_cnpj),identity_status='VERIFIED',identity_confirmed_by_user=true,updated_at=now() where id=l.id;
 update public.candidate_entities set validation_status='CONFIRMED',confidence='HIGH',metadata=metadata||jsonb_build_object('confirmed_by_user',true,'identity_confirmed',true,'identity_confirmation_scope','BUSINESS_LINK','kinship_confirmed',false,'confirmed_at',coalesce(metadata->'confirmed_at',to_jsonb(now())),'confirmed_company_id',co.id,'confirmed_registry_evidence_id',d.id,'assigned_initial_cnpj',v_assigned) where id=c.id;
 if not v_prior then insert into public.identity_assessments(organization_id,lead_id,candidate_entity_id,score,decision,factors,engine_version,explanation,created_by,created_at) values(p_org,l.id,c.id,100,'CONFIRMED',jsonb_build_object('user_confirmed',true,'scope','BUSINESS_LINK','confirmed_company_cnpj',v_cnpj,'discovery_evidence_id',c.metadata->>'evidence_id','registry_evidence_id',d.id),'qsa-review-v1','Vínculo empresarial selecionado explicitamente pelo usuário após validação dos documentos; não confirma parentesco nem os demais vínculos.',p_user,clock_timestamp()); end if;
 perform set_config('max.qsa_review_action',coalesce(v_old_action,''),true),set_config('max.qsa_review_candidate',coalesce(v_old_id,''),true);
 return jsonb_build_object('ok',true,'candidate_id',c.id,'lead_id',l.id,'cnpj',v_cnpj,'company_id',co.id,'confirmed',true,'reused',v_prior);
end $$;
revoke all on function public.review_qsa_name_candidate(uuid,uuid,uuid,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.review_qsa_name_candidate(uuid,uuid,uuid,text,text,uuid,uuid) to service_role;

-- Automatic enrichment consumes current candidate and source state in one transaction.
create or replace function public.apply_qsa_candidate_company_link(p_org uuid,p_user uuid,p_candidate uuid,p_company uuid,p_evidence uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.candidate_entities%rowtype; l public.leads%rowtype; co public.companies%rowtype; li public.lead_company_links%rowtype; d public.evidence%rowtype; rel public.relationships%rowtype; v_lead uuid; v_confirmed boolean; v_status text;
begin
 if current_user<>'service_role' then raise exception 'Service access required' using errcode='42501'; end if;
 if not exists(select 1 from public.profiles p join public.organization_members m on m.organization_id=p.active_organization_id and m.user_id=p.id where p.id=p_user and p.active_organization_id=p_org and m.status='ACTIVE' and m.role in ('OWNER','ADMIN','ANALYST','MEMBER')) then raise exception 'Operator access required' using errcode='42501'; end if;
 select x.lead_id into v_lead from public.candidate_entities x where x.id=p_candidate and x.organization_id=p_org;
 if v_lead is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
 select * into l from public.leads x where x.id=v_lead and x.organization_id=p_org for update;
 if not found or l.kind<>'PERSON' then raise exception 'Person lead required' using errcode='22023'; end if;
 select * into c from public.candidate_entities x where x.id=p_candidate and x.organization_id=p_org and x.lead_id=l.id for update;
 if not found or c.entity_type<>'COMPANY' or c.candidate_type<>'RFB_QSA_NAME_MATCH' or c.validation_status not in ('SUPPORTED','CONFIRMED') then raise exception 'Current supported candidate required' using errcode='P0001'; end if;
 v_confirmed:=c.validation_status='CONFIRMED'; v_status:=case when v_confirmed then 'VERIFIED' else 'SUPPORTED' end;
 if not v_confirmed and (coalesce(c.metadata#>>'{identity_engine,ambiguous}','true')<>'false' or c.metadata#>>'{identity_engine,decision}' is distinct from 'SUPPORTED'
  or not (case when c.metadata#>>'{identity_engine,score}' ~ '^[0-9]{1,3}$' then (c.metadata#>>'{identity_engine,score}')::integer>=75 else false end or coalesce(c.metadata#>>'{cross_identity_validation,matched}'='true',false))) then raise exception 'Current unambiguous support required' using errcode='P0001'; end if;
 if private.qsa_name_key(c.metadata->>'partner_name') is distinct from private.qsa_name_key(l.name) then raise exception 'Lead name context changed' using errcode='P0001'; end if;
 perform private.lock_qsa_discovery(p_org,l.id,c.metadata);
 if private.qsa_discovery_evidence_valid(p_org,l.id,c.metadata) is not true then raise exception 'Discovery evidence requires review or requery' using errcode='P0001'; end if;
 select * into co from public.companies x where x.id=p_company and x.organization_id=p_org and x.cnpj=c.metadata->>'full_cnpj' for share;
 if not found then raise exception 'Company context mismatch' using errcode='P0001'; end if;
 select * into d from public.evidence x where x.id=p_evidence and x.organization_id=p_org and x.lead_id=l.id and x.company_id=co.id for share;
 if not found or d.verification_status<>'VERIFIED' or d.document_type is distinct from 'CNPJ_REGISTRY' or d.raw_reference is distinct from co.cnpj or not exists(select 1 from public.source_registry s where s.id=d.source_registry_id and s.key in ('brasilapi_cnpj','base_empresarial_rfb')) then raise exception 'Verified exact company registry required' using errcode='P0001'; end if;
 select * into li from public.lead_company_links x where x.organization_id=p_org and x.lead_id=l.id and x.company_id=co.id for update;
 if not found or li.status in ('REJECTED','CONTRADICTED') then raise exception 'Rejected or missing attribution requires review' using errcode='P0001'; end if;
 if li.status<>'VERIFIED' then update public.lead_company_links set status=v_status,role_label=case when v_confirmed then coalesce(c.metadata->>'partner_role','Vínculo confirmado pelo usuário') else 'Suportado por resolução de identidade' end where id=li.id; else v_status:='VERIFIED'; end if;
 perform x.id from public.relationships x where x.organization_id=p_org and x.lead_id=l.id and x.from_entity_type='LEAD' and x.from_entity_id=l.id and x.to_entity_type='COMPANY' and x.to_entity_id=co.id and x.relationship_type='BUSINESS_LINK' order by x.id for update;
 if exists(select 1 from public.relationships x where x.organization_id=p_org and x.lead_id=l.id and x.from_entity_type='LEAD' and x.from_entity_id=l.id and x.to_entity_type='COMPANY' and x.to_entity_id=co.id and x.relationship_type='BUSINESS_LINK' and x.status in ('REJECTED','CONTRADICTED')) then raise exception 'Rejected relationship requires review' using errcode='P0001'; end if;
 select * into rel from public.relationships x where x.organization_id=p_org and x.lead_id=l.id and x.from_entity_type='LEAD' and x.from_entity_id=l.id and x.to_entity_type='COMPANY' and x.to_entity_id=co.id and x.relationship_type='BUSINESS_LINK' order by x.id limit 1;
 if found and rel.status in ('REJECTED','CONTRADICTED') then raise exception 'Rejected relationship requires review' using errcode='P0001'; end if;
 if not found then
  insert into public.relationships(organization_id,lead_id,from_entity_type,from_entity_id,from_label,to_entity_type,to_entity_id,to_label,relationship_type,classification,confidence,status,reason,created_by) values(p_org,l.id,'LEAD',l.id,l.name,'COMPANY',co.id,co.legal_name,'BUSINESS_LINK',case when v_confirmed then 'FACT' else 'INDICATION' end,'HIGH','PENDING',case when v_confirmed then 'Vínculo selecionado explicitamente pelo usuário com documentos de suporte.' else 'Vínculo suportado por contexto; exige confirmação humana.' end,p_user) returning * into rel;
 end if;
 insert into public.relationship_evidence(organization_id,relationship_id,evidence_id,support_type,strength) values(p_org,rel.id,d.id,'SUPPORTS',case when v_confirmed then 1 else 0.8 end),(p_org,rel.id,(c.metadata->>'evidence_id')::uuid,'SUPPORTS',case when v_confirmed then 1 else 0.8 end) on conflict(relationship_id,evidence_id) do nothing;
 if v_confirmed then update public.relationships set classification='FACT',confidence='HIGH',status='VERIFIED',updated_at=now() where id=rel.id; end if;
 return jsonb_build_object('ok',true,'candidate_id',c.id,'company_id',co.id,'cnpj',co.cnpj,'validation_status',c.validation_status,'link_status',v_status,'relationship_id',rel.id,'evidence_id',d.id);
end $$;
revoke all on function public.apply_qsa_candidate_company_link(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.apply_qsa_candidate_company_link(uuid,uuid,uuid,uuid,uuid) to service_role;

create or replace function public.refresh_qsa_identity_status(p_org uuid,p_user uuid,p_lead uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare l public.leads%rowtype; v_status text;
begin
 if current_user<>'service_role' or not exists(select 1 from public.profiles p join public.organization_members m on m.organization_id=p.active_organization_id and m.user_id=p.id where p.id=p_user and p.active_organization_id=p_org and m.status='ACTIVE' and m.role in ('OWNER','ADMIN','ANALYST','MEMBER')) then raise exception 'Operator service access required' using errcode='42501'; end if;
 select * into l from public.leads where id=p_lead and organization_id=p_org for update;
 if not found then raise exception 'Lead not found' using errcode='P0002'; end if;
 v_status:=l.identity_status;
 if l.kind='PERSON' and not l.identity_confirmed_by_user and l.identity_status<>'REJECTED' and exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.candidate_type='RFB_QSA_NAME_MATCH') then
  if exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.candidate_type='RFB_QSA_NAME_MATCH' and x.validation_status<>'REJECTED' and x.metadata#>>'{identity_engine,decision}'='AMBIGUOUS') then v_status:='CAUTION';
  elsif exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.candidate_type='RFB_QSA_NAME_MATCH' and x.validation_status='SUPPORTED' and private.qsa_discovery_evidence_valid(p_org,l.id,x.metadata) and private.qsa_name_key(x.metadata->>'partner_name')=private.qsa_name_key(l.name)) then v_status:='SUPPORTED';
  elsif exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.candidate_type='RFB_QSA_NAME_MATCH' and (x.validation_status<>'REJECTED' or x.metadata->>'confirmed_at' is not null)) then v_status:='CAUTION';else v_status:='PENDING';end if;
  if v_status is distinct from l.identity_status then update public.leads set identity_status=v_status,updated_at=now() where id=l.id; end if;
 end if;
 return jsonb_build_object('ok',true,'lead_status',v_status);
end $$;
revoke all on function public.refresh_qsa_identity_status(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.refresh_qsa_identity_status(uuid,uuid,uuid) to service_role;

-- Score + candidate + lead state share the same review lock and CAS snapshot.
create or replace function public.assess_qsa_name_candidate(p_org uuid,p_user uuid,p_candidate uuid,p_expected_status text,p_expected_meta jsonb,p_score integer,p_decision text,p_factors jsonb,p_run uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.candidate_entities%rowtype; l public.leads%rowtype; v_lead uuid; v_id uuid; v_valid boolean; v_status text; v_score integer:=p_score; v_decision text:=p_decision; v_factors jsonb:=coalesce(p_factors,'{}'::jsonb); v_lead_status text;
begin
 if current_user<>'service_role' or not exists(select 1 from public.profiles p join public.organization_members m on m.organization_id=p.active_organization_id and m.user_id=p.id where p.id=p_user and p.active_organization_id=p_org and m.status='ACTIVE' and m.role in ('OWNER','ADMIN','ANALYST','MEMBER')) then raise exception 'Operator service access required' using errcode='42501'; end if;
 select lead_id into v_lead from public.candidate_entities where id=p_candidate and organization_id=p_org;
 if v_lead is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
 select * into l from public.leads where id=v_lead and organization_id=p_org for update;
 if not found or l.kind<>'PERSON' then raise exception 'Person lead required' using errcode='22023'; end if;
 if p_run is not null and not exists(select 1 from public.research_runs r where r.id=p_run and r.organization_id=p_org and r.lead_id=l.id) then raise exception 'Run context mismatch' using errcode='P0002'; end if;
 select * into c from public.candidate_entities where id=p_candidate and organization_id=p_org and lead_id=l.id for update;
 if not found or c.candidate_type<>'RFB_QSA_NAME_MATCH' or c.entity_type<>'COMPANY' then raise exception 'QSA company candidate required' using errcode='22023'; end if;
 if c.validation_status='REJECTED' or c.validation_status is distinct from p_expected_status or c.metadata is distinct from p_expected_meta then return jsonb_build_object('applied',false,'validation_status',c.validation_status,'lead_status',l.identity_status); end if;
 if p_score not between 0 and 100 or p_score is null or p_decision not in ('WEAK','REVIEW','SUPPORTED','AMBIGUOUS','CONFIRMED') or p_decision is null then raise exception 'Valid assessment required' using errcode='22023'; end if;
 perform private.lock_qsa_discovery(p_org,l.id,c.metadata);
 v_valid:=private.qsa_discovery_evidence_valid(p_org,l.id,c.metadata) and private.qsa_name_key(l.name)=private.qsa_name_key(c.metadata->>'partner_name');
 if c.validation_status='CONFIRMED' then v_score:=100;v_decision:='CONFIRMED';
 elsif v_valid is not true then v_score:=0;v_decision:='REVIEW';v_factors:=v_factors||jsonb_build_object('evidence_binding_valid',false,'requires_canonical_requery',true);
 elsif v_decision='CONFIRMED' or v_decision='SUPPORTED' and v_score<75 then raise exception 'Automatic human confirmation forbidden' using errcode='P0001'; end if;
 v_status:=case when c.validation_status='CONFIRMED' then 'CONFIRMED' when v_decision='SUPPORTED' then 'SUPPORTED' else 'UNVALIDATED' end;
 update public.candidate_entities set validation_status=v_status,confidence=case when v_score>=75 then 'HIGH' when v_score>=45 then 'MEDIUM' else 'LOW' end,metadata=metadata||jsonb_build_object('identity_engine',jsonb_build_object('score',v_score,'decision',v_decision,'ambiguous',v_decision='AMBIGUOUS','engine_version','identity-v1.3','assessed_at',clock_timestamp(),'evidence_binding_valid',coalesce(v_valid,false))) where id=c.id;
 insert into public.identity_assessments(organization_id,lead_id,candidate_entity_id,research_run_id,score,decision,factors,engine_version,explanation,created_by,created_at) values(p_org,l.id,c.id,p_run,v_score,v_decision,v_factors,'identity-v1.3',case when c.validation_status='CONFIRMED' then 'Confirmação humana preservada; não confirma parentesco nem outros vínculos.' when v_valid is not true then 'Documento de descoberta ausente, revisado ou fora do contexto atual; exige reconsulta canônica.' when v_decision='SUPPORTED' then 'Suporte contextual algorítmico com documento válido; exige confirmação humana.' when v_decision='AMBIGUOUS' then 'Candidatos contextuais próximos; exige desambiguação.' else 'Sinais insuficientes para atribuir identidade.' end,p_user,clock_timestamp()) returning id into v_id;
 v_lead_status:=l.identity_status;
 if not l.identity_confirmed_by_user and l.identity_status<>'REJECTED' then
  if exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.candidate_type='RFB_QSA_NAME_MATCH' and x.validation_status<>'REJECTED' and x.metadata#>>'{identity_engine,decision}'='AMBIGUOUS') then v_lead_status:='CAUTION';
  elsif exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.candidate_type='RFB_QSA_NAME_MATCH' and x.validation_status='SUPPORTED' and private.qsa_discovery_evidence_valid(p_org,l.id,x.metadata) and private.qsa_name_key(x.metadata->>'partner_name')=private.qsa_name_key(l.name)) then v_lead_status:='SUPPORTED';
  elsif exists(select 1 from public.candidate_entities x where x.organization_id=p_org and x.lead_id=l.id and x.candidate_type='RFB_QSA_NAME_MATCH' and x.validation_status<>'REJECTED') then v_lead_status:='CAUTION';else v_lead_status:='PENDING';end if;
  update public.leads set identity_status=v_lead_status,updated_at=now() where id=l.id;
 end if;
 return jsonb_build_object('applied',true,'assessment_id',v_id,'validation_status',v_status,'score',v_score,'decision',v_decision,'lead_status',v_lead_status);
end $$;
revoke all on function public.assess_qsa_name_candidate(uuid,uuid,uuid,text,jsonb,integer,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.assess_qsa_name_candidate(uuid,uuid,uuid,text,jsonb,integer,text,jsonb,uuid) to service_role;

create or replace function public.record_qsa_cross_validation(p_org uuid,p_user uuid,p_candidate uuid,p_expected_status text,p_expected_meta jsonb,p_cross jsonb,p_evidence uuid,p_run uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.candidate_entities%rowtype; l public.leads%rowtype; d public.evidence%rowtype; v_lead uuid; v_status text;
begin
 if current_user<>'service_role' or not exists(select 1 from public.profiles p join public.organization_members m on m.organization_id=p.active_organization_id and m.user_id=p.id where p.id=p_user and p.active_organization_id=p_org and m.status='ACTIVE' and m.role in ('OWNER','ADMIN','ANALYST','MEMBER')) then raise exception 'Operator service access required' using errcode='42501'; end if;
 select lead_id into v_lead from public.candidate_entities where id=p_candidate and organization_id=p_org;
 if v_lead is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
 select * into l from public.leads where id=v_lead and organization_id=p_org for update;
 if not found or l.kind<>'PERSON' then raise exception 'Person lead required' using errcode='22023'; end if;
 if p_run is not null and not exists(select 1 from public.research_runs r where r.id=p_run and r.organization_id=p_org and r.lead_id=l.id) then raise exception 'Run context mismatch' using errcode='P0002'; end if;
 select * into c from public.candidate_entities where id=p_candidate and organization_id=p_org and lead_id=l.id for update;
 if c.candidate_type<>'RFB_QSA_NAME_MATCH' or c.entity_type<>'COMPANY' then raise exception 'QSA company candidate required' using errcode='22023'; end if;
 if c.validation_status='REJECTED' or c.validation_status is distinct from p_expected_status or c.metadata is distinct from p_expected_meta then return jsonb_build_object('applied',false,'validation_status',c.validation_status); end if;
 perform private.lock_qsa_discovery(p_org,l.id,c.metadata);
 if private.qsa_discovery_evidence_valid(p_org,l.id,c.metadata) is not true or private.qsa_name_key(l.name) is distinct from private.qsa_name_key(c.metadata->>'partner_name') then raise exception 'Current scoped discovery required' using errcode='P0001'; end if;
 select * into d from public.evidence e where e.id=p_evidence and e.organization_id=p_org and e.lead_id=l.id for share;
 if not found or d.verification_status<>'VERIFIED' or d.document_type is distinct from 'QSA_CROSS_IDENTITY_MATCH' or d.source_url is distinct from 'https://brasilapi.com.br/api/cnpj/v1/'||(c.metadata->>'full_cnpj') or d.raw_reference is distinct from 'candidate='||c.id::text||'; group='||(p_cross->>'group_id') or not exists(select 1 from public.source_registry s where s.id=d.source_registry_id and s.key='brasilapi_cnpj') then raise exception 'Current cross document required' using errcode='P0001'; end if;
 if coalesce(p_cross->>'matched','false')<>'true' or p_cross->>'method' is distinct from 'MASKED_QSA_IDENTIFIER_HASH' or coalesce(p_cross->>'fingerprint_hash','') !~ '^[a-f0-9]{64}$' or p_cross->>'group_id' is distinct from left(p_cross->>'fingerprint_hash',16) or (case when p_cross->>'group_size' ~ '^[0-9]{1,2}$' then (p_cross->>'group_size')::integer<2 or (p_cross->>'group_size')::integer>12 else true end) then raise exception 'Valid bounded cross context required' using errcode='22023'; end if;
 v_status:=case when c.validation_status='CONFIRMED' then 'CONFIRMED' else 'SUPPORTED' end;
 update public.candidate_entities set validation_status=v_status,confidence='HIGH',metadata=metadata||jsonb_build_object('cross_identity_validation',p_cross||jsonb_build_object('evidence_id',d.id,'validated_at',clock_timestamp())) where id=c.id;
 if c.validation_status<>'CONFIRMED' then insert into public.identity_assessments(organization_id,lead_id,candidate_entity_id,research_run_id,score,decision,factors,engine_version,explanation,created_by,created_at) values(p_org,l.id,c.id,p_run,88,'SUPPORTED',jsonb_build_object('cross_qsa_masked_identifier_match',true,'group_size',p_cross->'group_size','evidence_id',d.id),'identity-cross-v1.1','Mesmo nome e identificador parcialmente mascarado em múltiplos QSA; suporte algorítmico, exige confirmação humana.',p_user,clock_timestamp()); end if;
 return jsonb_build_object('applied',true,'validation_status',v_status,'evidence_id',d.id);
end $$;
revoke all on function public.record_qsa_cross_validation(uuid,uuid,uuid,text,jsonb,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.record_qsa_cross_validation(uuid,uuid,uuid,text,jsonb,jsonb,uuid,uuid) to service_role;
