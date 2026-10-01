
import {buildSourceRoutes} from '../_shared/source-router.ts';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, GET, OPTIONS"};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization"); if(!auth) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});
  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}}),admin=createClient(url,service);
  const {data:{user}}=await uc.auth.getUser(); if(!user) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});
  const b=await req.json().catch(()=>({})), leadId=String(b.lead_id||"");
  if(!leadId) return new Response(JSON.stringify({error:"lead_id required"}),{status:400,headers:H});
  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single(); const orgId=p?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:membership}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(membership?.status!=="ACTIVE") return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});

  const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!lead) return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  const [links,relationships,events,evidence,claims,signals,runs,candidates,questions,divergences,coverage,identityAssessments,identityAudit,identitySourceAttempts,webHits]=await Promise.all([
    admin.from("lead_company_links").select("*,companies(*)").eq("lead_id",leadId).eq("organization_id",orgId),
    admin.from("relationships").select("*,relationship_evidence(evidence_id,support_type)").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at"),
    admin.from("events").select("*,event_evidence(evidence_id,support_type)").eq("lead_id",leadId).eq("organization_id",orgId).order("event_date",{ascending:true,nullsFirst:false}),
    admin.from("evidence").select("*").eq("lead_id",leadId).eq("organization_id",orgId).order("retrieved_at",{ascending:false}),
    admin.from("claims").select("*,claim_evidence(evidence_id,support_type,strength)").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at",{ascending:false}),
    admin.from("commercial_signals").select("*").eq("lead_id",leadId).eq("organization_id",orgId).eq("status","ACTIVE").order("created_at",{ascending:false}),
    admin.from("research_runs").select("*,research_steps(*)").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at",{ascending:false}),
    admin.from("candidate_entities").select("*").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at",{ascending:false}),
    admin.from("investigation_questions").select("*").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at",{ascending:false}),
    admin.from("divergences").select("*").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at",{ascending:false}),
    admin.from("lead_evidence_coverage").select("*").eq("lead_id",leadId).eq("organization_id",orgId).maybeSingle(),
    admin.from("identity_assessments").select("*").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at",{ascending:false}).limit(100),
    admin.from("identity_status_audit").select("*").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at",{ascending:false}).limit(50),
    admin.from("identity_source_attempts").select("*").eq("lead_id",leadId).eq("organization_id",orgId).order("created_at",{ascending:false}).limit(100),
    admin.from("web_context_hits").select("id,result_url,title,snippet,result_domain,result_class,validation_status,created_at").eq("organization_id",orgId).eq("lead_id",leadId).neq("validation_status","REJECTED").order("created_at",{ascending:false}).limit(100)
  ]);

  if([links,relationships,events,evidence,claims,signals,runs,candidates,questions,divergences,coverage,identityAssessments,identityAudit,identitySourceAttempts,webHits].some(result=>result.error))return new Response(JSON.stringify({error:"Could not load complete dossier; retry before comparing history"}),{status:500,headers:H});

  // Older connectors stored a source document once per organization. Include documents
  // referenced by this dossier even if their original lead_id belongs to another nucleus.
  const referencedEvidenceIds=[...new Set([
    ...(claims.data||[]).flatMap((r:any)=>(r.claim_evidence||[]).map((x:any)=>x.evidence_id)),
    ...(events.data||[]).flatMap((r:any)=>(r.event_evidence||[]).map((x:any)=>x.evidence_id)),
    ...(relationships.data||[]).flatMap((r:any)=>(r.relationship_evidence||[]).map((x:any)=>x.evidence_id))
  ])];
  const missingIds=referencedEvidenceIds.filter(id=>!(evidence.data||[]).some(e=>e.id===id));
  if(missingIds.length){
    const extra=await admin.from('evidence').select('*').eq('organization_id',orgId).in('id',missingIds);
    if(extra.error)return new Response(JSON.stringify({error:extra.error.message}),{status:500,headers:H});
    evidence.data=[...(evidence.data||[]),...(extra.data||[])];
  }
  const personIds=[...new Set((relationships.data||[]).flatMap((r:any)=>[
    r.from_entity_type==="PERSON"?r.from_entity_id:null,
    r.to_entity_type==="PERSON"?r.to_entity_id:null
  ]).filter(Boolean))];
  const companyIds=[...new Set((relationships.data||[]).flatMap((r:any)=>[
    r.from_entity_type==="COMPANY"?r.from_entity_id:null,
    r.to_entity_type==="COMPANY"?r.to_entity_id:null
  ]).filter(Boolean))];
  const [people,extraCompanies]=await Promise.all([
    personIds.length?admin.from("people").select("*").eq("organization_id",orgId).in("id",personIds):Promise.resolve({data:[]}),
    companyIds.length?admin.from("companies").select("*").eq("organization_id",orgId).in("id",companyIds):Promise.resolve({data:[]})
  ]);

  const latestRun=(runs.data||[])[0]||null;
  if(people.error||extraCompanies.error)return new Response(JSON.stringify({error:"Could not load dossier entities"}),{status:500,headers:H});
  const [history,reviewLog,candidateReviewLog]=b.include_history===false?[{data:[],error:null},{data:[],error:null},{data:[],error:null}]:await Promise.all([
    admin.from('intelligence_snapshots').select('id,captured_at,research_run_id,payload').eq('organization_id',orgId).eq('lead_id',leadId).order('captured_at',{ascending:false}).limit(20),
    admin.from('relationship_review_log').select('id,relationship_id,previous_status,new_status,reason,created_at').eq('organization_id',orgId).eq('lead_id',leadId).order('created_at',{ascending:false}).limit(50),
    admin.from('graph_candidate_review_log').select('id,candidate_id,action,reason,created_at').eq('organization_id',orgId).eq('lead_id',leadId).order('created_at',{ascending:false}).limit(50)
  ]);
  if(history.error||reviewLog.error||candidateReviewLog.error)return new Response(JSON.stringify({error:'Could not load intelligence history'}),{status:500,headers:H});
  const latestSourceSteps=(latestRun?.research_steps||[]).filter((s:any)=>s.source_key);
  const relevantSources=[...new Set(latestSourceSteps.map((s:any)=>s.source_key))];
  const successfulSources=[...new Set(latestSourceSteps.filter((s:any)=>["COMPLETED","PARTIAL"].includes(s.status)).map((s:any)=>s.metadata?.provider||s.source_key))];
  const attemptedSources=[...new Set(latestSourceSteps.filter((s:any)=>["COMPLETED","PARTIAL","FAILED"].includes(s.status)).map((s:any)=>s.source_key))];
  const blockedSources=[...new Set(latestSourceSteps.filter((s:any)=>s.status==="BLOCKED").map((s:any)=>s.source_key))];
  const sourceCoverage={
    relevant_count:relevantSources.length,
    successful_count:successfulSources.length,
    attempted_count:attemptedSources.length,
    blocked_count:blockedSources.length,
    successful_pct:relevantSources.length?Math.round((successfulSources.length/relevantSources.length)*100):null,
    relevant_sources:relevantSources,
    successful_sources:successfulSources,
    attempted_sources:attemptedSources,
    blocked_sources:blockedSources
  };

  const {data:registry,error:registryError}=await admin.from('source_registry').select('key,name,connection_status,action_url,limitations');
  if(registryError)return new Response(JSON.stringify({error:'Could not load investigation source routes'}),{status:500,headers:H});
  const sourceRoutes=buildSourceRoutes(registry||[],{kind:lead.kind,companyResolved:(links.data||[]).some((l:any)=>['SUPPORTED','VERIFIED'].includes(l.status)),braveConfigured:!!Deno.env.get('BRAVE_SEARCH_API_KEY'),portalConfigured:!!Deno.env.get('PORTAL_TRANSPARENCIA_API_TOKEN')});
  return new Response(JSON.stringify({
    ok:true,role:membership.role,lead,source_routes:sourceRoutes,web_context_hits:webHits.data||[],intelligence_snapshots:history.data||[],relationship_reviews:reviewLog.data||[],graph_candidate_reviews:candidateReviewLog.data||[],
    companies:(links.data||[]).map((l:any)=>({...l.companies,link_id:l.id,link_status:l.status,link_role:l.role_label})),
    people:people.data||[],extra_companies:extraCompanies.data||[],
    relationships:relationships.data||[],events:events.data||[],evidence:evidence.data||[],claims:claims.data||[],
    signals:signals.data||[],research_runs:runs.data||[],candidates:candidates.data||[],questions:questions.data||[],
    divergences:divergences.data||[],identity_assessments:identityAssessments.data||[],identity_audit:identityAudit.data||[],identity_source_attempts:identitySourceAttempts.data||[],coverage:coverage.data||null,source_coverage:sourceCoverage
  }),{headers:H});
});
