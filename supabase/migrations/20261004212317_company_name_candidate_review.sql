-- Finalize one company-name candidate after its exact CNPJ has been enriched.
-- The browser cannot execute this routine; the authenticated endpoint uses service_role.
create or replace function public.review_company_name_candidate(
 p_org uuid, p_user uuid, p_candidate uuid, p_action text,
 p_reason text default null, p_company uuid default null, p_evidence uuid default null
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
 candidate public.candidate_entities%rowtype;
 lead public.leads%rowtype;
 company public.companies%rowtype;
 link public.lead_company_links%rowtype;
 document public.evidence%rowtype;
 candidate_lead uuid;
 cnpj text;
 action text := upper(coalesce(p_action,''));
 already_confirmed boolean;
begin
 if current_user <> 'service_role' then raise exception 'Service access required' using errcode='42501'; end if;
 if not exists(select 1 from public.profiles p join public.organization_members m on m.organization_id=p.active_organization_id and m.user_id=p.id
   where p.id=p_user and p.active_organization_id=p_org and m.status='ACTIVE' and m.role in ('OWNER','ADMIN','ANALYST','MEMBER'))
 then raise exception 'Operator access required' using errcode='42501'; end if;
 if action not in ('CONFIRM','REJECT') then raise exception 'Unsupported review action' using errcode='22023'; end if;
 select c.lead_id into candidate_lead from public.candidate_entities c where c.id=p_candidate and c.organization_id=p_org;
 if candidate_lead is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
 -- All calls lock the lead before its candidate, serializing competing CNPJ selections.
 select * into lead from public.leads l where l.id=candidate_lead and l.organization_id=p_org for update;
 if not found or lead.kind<>'COMPANY' then raise exception 'Company lead required' using errcode='22023'; end if;
 select * into candidate from public.candidate_entities c where c.id=p_candidate and c.organization_id=p_org and c.lead_id=lead.id for update;
 if not found or candidate.entity_type<>'COMPANY' or candidate.candidate_type<>'RFB_COMPANY_NAME_MATCH'
 then raise exception 'Unsupported candidate type' using errcode='22023'; end if;
 cnpj := candidate.metadata->>'full_cnpj';
 if cnpj is null or cnpj !~ '^[A-Z0-9]{12}[0-9]{2}$' then raise exception 'Valid full CNPJ required' using errcode='22023'; end if;
 if action='REJECT' then
  if length(trim(coalesce(p_reason,'')))<5 or length(p_reason)>1000 then raise exception 'Review reason required' using errcode='22023'; end if;
  if candidate.validation_status='CONFIRMED' then raise exception 'Confirmed company requires identity review' using errcode='P0001'; end if;
  if candidate.validation_status<>'REJECTED' then
   update public.candidate_entities set validation_status='REJECTED',confidence='LOW',metadata=metadata||jsonb_build_object('confirmed_by_user',false,'rejected_by_user',true,'rejected_at',now(),'rejection_reason',trim(p_reason)) where id=candidate.id;
   insert into public.identity_assessments(organization_id,lead_id,candidate_entity_id,score,decision,factors,engine_version,explanation,created_by)
   values(p_org,lead.id,candidate.id,0,'REJECTED',jsonb_build_object('user_rejected',true,'scope','LEGAL_ENTITY_CANDIDATE','reason',trim(p_reason)),'company-name-v1','Candidato de entidade jurídica descartado pelo usuário; documentos e vínculos existentes preservados.',p_user);
  end if;
  return jsonb_build_object('ok',true,'candidate_id',candidate.id,'lead_id',lead.id,'rejected',true);
 end if;
 if candidate.validation_status='REJECTED' then raise exception 'Rejected candidate cannot be confirmed' using errcode='P0001'; end if;
 if lead.initial_cnpj is not null and upper(regexp_replace(lead.initial_cnpj,'[^A-Za-z0-9]','','g'))<>cnpj
 then raise exception 'Lead already has a different CNPJ' using errcode='P0001'; end if;
 if p_company is null or p_evidence is null then raise exception 'Enriched company and evidence required' using errcode='22023'; end if;
 select * into company from public.companies c where c.id=p_company and c.organization_id=p_org and c.cnpj=cnpj for share;
 if not found then raise exception 'Company context mismatch' using errcode='P0001'; end if;
 -- Verify both the original discovery citation and the exact company registry document.
 select * into document from public.evidence e where e.id::text=candidate.metadata->>'evidence_id' and e.organization_id=p_org and e.lead_id=lead.id for share;
 if not found or document.verification_status<>'VERIFIED' or document.document_type is distinct from 'CNPJ_REGISTRY'
  or document.source_url is distinct from 'https://baseempresarial.com.br/empresa/'||cnpj
  or not exists(select 1 from public.source_registry s where s.id=document.source_registry_id and s.key='base_empresarial_rfb')
 then raise exception 'Discovery evidence requires review' using errcode='P0001'; end if;
 select * into document from public.evidence e where e.id=p_evidence and e.organization_id=p_org and e.lead_id=lead.id and e.company_id=company.id for share;
 if not found or document.verification_status<>'VERIFIED' or document.document_type is distinct from 'CNPJ_REGISTRY'
 then raise exception 'Company registry evidence requires review' using errcode='P0001'; end if;
 select * into link from public.lead_company_links l where l.organization_id=p_org and l.lead_id=lead.id and l.company_id=company.id for update;
 if not found then raise exception 'Company link not found' using errcode='P0001'; end if;
 if link.status in ('REJECTED','CONTRADICTED') then raise exception 'Rejected company attribution requires review' using errcode='P0001'; end if;
 already_confirmed := candidate.validation_status='CONFIRMED' and lead.identity_confirmed_by_user and lead.identity_status='VERIFIED' and link.status='VERIFIED';
 update public.lead_company_links set status='VERIFIED',role_label='Entidade jurídica selecionada e confirmada pelo usuário' where id=link.id;
 update public.leads set initial_cnpj=cnpj,identity_status='VERIFIED',identity_confirmed_by_user=true,updated_at=now() where id=lead.id;
 update public.candidate_entities set validation_status='CONFIRMED',confidence='HIGH',metadata=metadata||jsonb_build_object('confirmed_by_user',true,'identity_confirmed',true,'identity_confirmation_scope','LEGAL_ENTITY','kinship_confirmed',false,'confirmed_at',coalesce(metadata->'confirmed_at',to_jsonb(now())),'confirmed_company_id',company.id,'confirmed_registry_evidence_id',document.id,'assigned_initial_cnpj',coalesce((metadata->>'assigned_initial_cnpj')::boolean,lead.initial_cnpj is null)) where id=candidate.id;
 if not already_confirmed then
  insert into public.identity_assessments(organization_id,lead_id,candidate_entity_id,score,decision,factors,engine_version,explanation,created_by)
  values(p_org,lead.id,candidate.id,100,'CONFIRMED',jsonb_build_object('user_confirmed',true,'scope','LEGAL_ENTITY','confirmed_company_cnpj',cnpj,'registry_evidence_id',document.id),'company-name-v1','Entidade jurídica selecionada explicitamente pelo usuário após consulta do CNPJ exato. Não confirma grupo, marca, pessoa ou parentesco.',p_user);
 end if;
 return jsonb_build_object('ok',true,'candidate_id',candidate.id,'lead_id',lead.id,'cnpj',cnpj,'company_id',company.id,'confirmed',true,'reused',already_confirmed);
end $$;
revoke all on function public.review_company_name_candidate(uuid,uuid,uuid,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.review_company_name_candidate(uuid,uuid,uuid,text,text,uuid,uuid) to service_role;
