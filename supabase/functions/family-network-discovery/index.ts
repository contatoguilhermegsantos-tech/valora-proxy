import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'jsr:@supabase/supabase-js@2';
import {familyContext,familyStableId,familyQueryFingerprint,familyNorm} from '../_shared/family-discovery.ts';
import {expandFamilyNetwork} from '../_shared/family-network.ts';
import {persistSourceEvidence} from '../_shared/source-evidence.ts';
import {familyNetworkText} from '../_shared/family-network-text.ts';
const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const reply=(b:unknown,status=200)=>new Response(JSON.stringify(b),{status,headers:H});
const uuid=(s:unknown)=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const enabled=(s:any)=>s&&['CONNECTED','CONNECTED_LIMITED'].includes(s.connection_status);
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return reply({ok:true});if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization');if(!auth)return reply({error:'Unauthorized'},401);
 try{
  const url=Deno.env.get('SUPABASE_URL')!,admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),uc=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
  const {data:{user},error:authError}=await uc.auth.getUser();if(authError||!user)return reply({error:'Unauthorized'},401);
  const body=await req.text();if(body.length>2048)return reply({error:'Request too large'},413);
  let b:any;try{b=JSON.parse(body)}catch{return reply({error:'JSON object required'},400)}
  if(!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).some(k=>!['lead_id','action','research_run_id'].includes(k))||b.action&&b.action!=='expand'||!uuid(b.lead_id)||b.research_run_id&&!uuid(b.research_run_id))return reply({error:'Valid lead and expansion action required'},400);
  const profile=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();if(profile.error)throw Error('Profile');const org=profile.data?.active_organization_id;if(!org)return reply({error:'No active organization'},409);
  const membership=await admin.from('organization_members').select('role,status').eq('organization_id',org).eq('user_id',user.id).maybeSingle();if(membership.error)throw Error('Membership');if(membership.data?.status!=='ACTIVE'||!['OWNER','ADMIN','ANALYST','MEMBER'].includes(membership.data.role))return reply({error:'Write access required'},403);
  const [lead,registry,candidates,evidence]=await Promise.all([
   admin.from('leads').select('id,kind,name,city,state,segment').eq('id',b.lead_id).eq('organization_id',org).maybeSingle(),
   admin.from('source_registry').select('id,key,connection_status').in('key',['base_empresarial_rfb','minha_receita_rfb']),
   admin.from('candidate_entities').select('*').eq('organization_id',org).eq('lead_id',b.lead_id).in('candidate_type',['FAMILY_SEARCH_PIVOT','FAMILY_CONTEXT_MATCH','FAMILY_NETWORK_PIVOT','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON']).range(0,899),
   admin.from('evidence').select('id,organization_id,lead_id,verification_status,source_registry_id').eq('organization_id',org).eq('lead_id',b.lead_id).order('retrieved_at',{ascending:false}).range(0,899)
  ]);
  if([lead,registry,candidates,evidence].some(r=>r.error))throw Error('Context');if(!lead.data)return reply({error:'Lead not found'},404);
  if(lead.data.kind!=='PERSON')return reply({ok:true,status:'BLOCKED',continuation:false,note:'O mapa do pivô exige um núcleo de pessoa.'});
  if(b.research_run_id){const run=await admin.from('research_runs').select('id').eq('id',b.research_run_id).eq('organization_id',org).eq('lead_id',b.lead_id).maybeSingle();if(run.error)throw Error('Run');if(!run.data)return reply({error:'Research run not found'},404)}
  const previous=candidates.data.find((c:any)=>c.candidate_type==='FAMILY_NETWORK_PIVOT'),seedPivot=candidates.data.find((c:any)=>c.candidate_type==='FAMILY_SEARCH_PIVOT');
  if(previous?.validation_status==='REJECTED'||seedPivot?.validation_status==='REJECTED')return reply({ok:true,status:'BLOCKED',continuation:false,note:'Pivô descartado; revisão preservada.'});
  const context=familyContext(lead.data);if(!context.ok)return reply({ok:true,status:'BLOCKED',continuation:false,note:'Resolva o município, UF e atividade para iniciar o pivô.'});
  const fingerprint=await familyQueryFingerprint(context),verified=new Map(evidence.data.filter((e:any)=>e.verification_status==='VERIFIED'&&e.source_registry_id).map((e:any)=>[e.id,e]));
  const seeds=candidates.data.filter((c:any)=>c.candidate_type==='FAMILY_CONTEXT_MATCH'&&c.validation_status==='UNVALIDATED'&&c.confidence==='LOW'&&c.metadata?.kinship_confirmed===false&&c.metadata?.query_fingerprint===fingerprint&&verified.has(c.metadata.evidence_id)).map((c:any)=>({candidate_id:c.id,full_cnpj:c.metadata.full_cnpj,company_name:c.metadata.company_name,city:c.metadata.city,state:c.metadata.state,person_name:c.metadata.person_name,match_basis:c.metadata.match_basis}));
  if(!seeds.length)return reply({ok:true,status:'BLOCKED',continuation:false,note:'Aguarde um CNPJ documentado no pivô para iniciar a expansão.'});
  const rejected=candidates.data.filter((c:any)=>c.validation_status==='REJECTED');
  const excludedCnpjs=rejected.filter((c:any)=>c.entity_type==='COMPANY').map((c:any)=>c.metadata?.full_cnpj).filter(Boolean),excludedNodeKeys=rejected.flatMap((c:any)=>c.metadata?.network_node_key?[c.metadata.network_node_key]:c.candidate_type==='FAMILY_CONTEXT_MATCH'&&c.entity_type==='PERSON'&&c.metadata?.full_cnpj&&c.metadata?.person_name?[`person:${c.metadata.full_cnpj}:${familyNorm(c.metadata.person_name)}`]:[]);
  const baseSource=registry.data.find((s:any)=>s.key==='base_empresarial_rfb'),minhaSource=registry.data.find((s:any)=>s.key==='minha_receita_rfb');
  const started=Date.now(),result=await expandFamilyNetwork(context,seeds,previous?.metadata?.state||{},{baseAvailable:Boolean(enabled(baseSource)),minhaAvailable:Boolean(enabled(minhaSource)),excludedCnpjs,excludedNodeKeys});
  const observationDocs=new Map<string,any>();
  for(const observation of result.observations){
   const source=observation.provider==='MINHA_RECEITA'?minhaSource:baseSource;if(!enabled(source))throw Error('Source');
   const stableData={provider:observation.provider,full_cnpj:observation.full_cnpj,company_name:observation.company_name,city:observation.city,state:observation.state,cnae_code:observation.cnae_code,cnae_description:observation.cnae_description,trade_name:observation.trade_name||'',registration_status:observation.registration_status||'',people:observation.people};
   const digest=await familyStableId(JSON.stringify(stableData));
   const document=await persistSourceEvidence(admin,{organization_id:org,lead_id:b.lead_id,source_registry_id:source.id,title:'Cadastro e nomes no QSA — '+observation.company_name,source_label:(observation.provider==='MINHA_RECEITA'?'Minha Receita':'Base Empresarial')+' / dados públicos CNPJ-RFB',source_url:observation.source_url,source_kind:'AGGREGATOR',document_type:'CNPJ_REGISTRY',publisher:observation.provider==='MINHA_RECEITA'?'Minha Receita':'Base Empresarial',source_date:null,retrieved_at:observation.queried_at,dedupe_key:`${b.lead_id}:family-network:${digest}`,reliability_weight:0.7,raw_reference:JSON.stringify(stableData),excerpt:`CNPJ ${observation.full_cnpj}; razão social ${observation.company_name}; município da empresa ${observation.city}/${observation.state}; CNAE ${observation.cnae_code} — ${observation.cnae_description}. Nomes citados no QSA: ${observation.people.map(p=>p.name+' ('+p.role+')').join('; ')||'nenhum nome físico informado'}. A citação cadastral não confirma identidade individual, parentesco, residência ou poderes financeiros.`,verification_status:'VERIFIED',last_verified_at:observation.queried_at,usage_scope:'INTERNAL',created_by:user.id});
   if(document.error||!document.data)throw Error('Evidence');if(document.data.verification_status==='VERIFIED')observationDocs.set(observation.key,{evidence:document.data,observation});
  }
  const payload:any[]=[],nodes:any[]=[],existingById=new Map(candidates.data.map((c:any)=>[c.id,c]));
  for(const node of result.nodes){
   if(node.type==='ROOT'){nodes.push(node);continue}
   const observed=observationDocs.get(node.observation_key||'');if(!observed)continue;
   const o=observed.observation,id=await familyStableId(`family-network|${org}|${b.lead_id}|${node.key}`),person=node.type==='PERSON_CITATION';
   const metadata={network_node_key:node.key,full_cnpj:o.full_cnpj,basic_cnpj:o.full_cnpj.slice(0,8),company_name:o.company_name,city:o.city,state:o.state,segment:o.cnae_description,cnae_code:o.cnae_code,person_name:person?node.person_name:null,match_basis:person?'QSA_PERSON':'COMPANY_REGISTRY',evidence_id:observed.evidence.id,source_provider:o.provider,source_key:o.provider==='MINHA_RECEITA'?'minha_receita_rfb':'base_empresarial_rfb',source_url:o.source_url,identity_confirmed:false,kinship_confirmed:false,geography_scope:'COMPANY_ESTABLISHMENT',query_fingerprint:fingerprint};
   const existing:any=existingById.get(id);
   // Preserve the first reviewed observation. New documents never silently rewrite a candidate.
   if(existing){
    const old=existing.metadata;
    if(existing.validation_status!=='UNVALIDATED'||existing.confidence!=='LOW'||old?.identity_confirmed!==false||old?.kinship_confirmed!==false||!verified.has(old.evidence_id))continue;
    nodes.push({...node,label:familyNetworkText(existing.label),full_cnpj:old.full_cnpj,person_name:person?familyNetworkText(old.person_name):undefined,city:person?undefined:familyNetworkText(old.city,120),state:person?undefined:old.state,cnae_code:person?undefined:old.cnae_code,cnae_description:person?undefined:familyNetworkText(old.segment),candidate_id:id,evidence_id:old.evidence_id,identity_confirmed:false,kinship_confirmed:false});
    continue;
   }
   payload.push({id,candidate_type:person?'FAMILY_NETWORK_PERSON':'FAMILY_NETWORK_COMPANY',entity_type:person?'PERSON':'COMPANY',label:node.label,candidate_reason:'Nó do mapa a partir de CNPJ e nomes cadastrais; identidade e parentesco pendentes de validação.',metadata});
   nodes.push({...node,candidate_id:id,evidence_id:observed.evidence.id,identity_confirmed:false,kinship_confirmed:false});
  }
  const nodeMap=new Map(nodes.map(n=>[n.key,n])),edges=result.edges.flatMap(edge=>{
   const observed=observationDocs.get(edge.observation_key),from=nodeMap.get(edge.from),to=nodeMap.get(edge.to);if(!observed||!from||!to)return [];
   const ids=[...new Set([observed.evidence.id,from.evidence_id,to.evidence_id].filter(Boolean))];
   return [{...edge,evidence_id:observed.evidence.id,evidence_ids:ids,identity_confirmed:false,kinship_confirmed:false}];
  });
  const graph={nodes,edges,status:result.status,complete:false,continuation:result.continuation,notes:[...new Set([...(result.search_lineage.notes||[]),...(result.state.coverage_errors||[]),...(result.state.limits_reached||[])])],retry_not_before:result.state.retry_not_before,pagination_stalled:result.state.pagination_stalled,scanned_count:result.state.scanned_count,pages_scanned:result.state.pages_scanned,counts:{companies:nodes.filter(n=>n.type==='COMPANY').length,people:nodes.filter(n=>n.type==='PERSON_CITATION').length,edges:edges.length},search_lineage:result.search_lineage,last_queried_at:new Date().toISOString(),identity_confirmed:false,kinship_confirmed:false};
  const commit=await admin.rpc('commit_family_network',{p_org:org,p_user:user.id,p_lead:b.lead_id,p_pivot:previous?.id||await familyStableId(`family-network-pivot|${org}|${b.lead_id}`),p_revision:Number(previous?.metadata?.revision)||0,p_state:result.state,p_graph:graph,p_candidates:payload,p_run:b.research_run_id||null});
  if(commit.error){
   const reasons=new Set(['Valid network context required','Write access required','Origin lead not found','Invalid research run','Invalid network shape','Invalid network payload','Unsafe network candidate','Physical QSA citation required','Company registry identity required','Unsafe graph node','Unique unbound root required','Bound node identity and evidence required','Unsafe network edge','Bound edge documents required','Valid edge document identifier required','Primary edge document must match bound documents','Pivot review blocks expansion','Candidate scope conflict','Persisted candidate review blocks expansion','Verified scoped evidence required','Node candidate scope required','Node must match its persisted unresolved candidate','Company node identity mismatch','Person citation identity mismatch','Node evidence required','Unique network root and node keys required','Edge evidence required','canceling statement due to statement timeout']);
   console.error('FAMILY_NETWORK_COMMIT_FAILED',{code:/^[A-Z0-9]{5}$/.test(commit.error.code||'')?commit.error.code:'UNKNOWN',reason:reasons.has(commit.error.message)?commit.error.message:'UNCLASSIFIED'});
   if(commit.error.code==='57014')return reply({error:'A gravação excedeu o tempo disponível. O progresso anterior foi preservado; tente retomar mais tarde.',status:'FAILED',continuation:false},503);
   return reply({error:'A gravação do mapa foi bloqueada por revisão, documento ou contexto. Atualize o dossiê.',status:'FAILED',continuation:false},409);
  }
  if(commit.data?.conflict)return reply({error:'O mapa avançou em outra consulta. Atualize antes de continuar.',status:'PARTIAL',continuation:false},409);
  for(const provider of ['MINHA_RECEITA','BASE_EMPRESARIAL']){
   const attempts=result.search_lineage.source_attempts.filter((a:any)=>a.provider===provider);if(!attempts.length)continue;const last=attempts.at(-1),source=provider==='MINHA_RECEITA'?minhaSource:baseSource;
   const log=await admin.from('source_fetch_logs').insert({organization_id:org,research_run_id:b.research_run_id||null,source_registry_id:source?.id,endpoint_reference:'Family network: CNPJ -> QSA names -> exact-name and all-sector municipal expansion',success:last.status>=200&&last.status<300&&!last.error,http_status:last.status,result_status:'FAMILY_NETWORK_'+(last.error?'QUERY_FAILED':result.status),duration_ms:Date.now()-started,created_by:user.id});if(log.error)throw Error('Log');
  }
  return reply({ok:result.status!=='FAILED',status:result.status,complete:false,continuation:result.continuation,network:commit.data.network,pivot:commit.data.pivot,note:'Mapa de citações cadastrais e hipóteses de identidade; parentesco não confirmado.'},result.status==='FAILED'?502:200);
 }catch{return reply({error:'Não foi possível concluir ou registrar a expansão. As revisões anteriores foram preservadas.',status:'FAILED',continuation:false},500)}
});
