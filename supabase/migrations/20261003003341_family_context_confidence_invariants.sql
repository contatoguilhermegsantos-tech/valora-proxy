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
    +family_context_candidates_with_personal_data),
  'warning_count',(stuck_research_runs+stuck_research_jobs)
)
from metrics;
$function$;

REVOKE ALL ON FUNCTION public.max_invariant_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.max_invariant_snapshot() TO service_role;
