import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "jsr:@supabase/supabase-js@2";
import {fetchSourceJson} from '../_shared/source-operations.ts';
import {normalizeBaseCompany,validateQsaMapping} from '../_shared/cnpj-fallback.ts';
import {persistSourceEvidence} from '../_shared/source-evidence.ts';
const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
Deno.serve(async(req:Request)=>{
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
 if(req.method==='OPTIONS')return reply({ok:true});if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization');if(!auth)return reply({error:'Unauthorized'},401);
 const url=Deno.env.get('SUPABASE_URL')!,admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),uc=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
 const {data:{user}}=await uc.auth.getUser();if(!user)return reply({error:'Unauthorized'},401);
 const {data:p}=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();const org=p?.active_organization_id;if(!org)return reply({error:'No active organization'},409);
 const {data:m}=await admin.from('organization_members').select('role,status').eq('organization_id',org).eq('user_id',user.id).maybeSingle();if(m?.status!=='ACTIVE'||!['OWNER','ADMIN','ANALYST','MEMBER'].includes(m.role))return reply({error:'Write access required'},403);
 const b=await req.json().catch(()=>({})),id=String(b.candidate_id||''),action=String(b.action||''),reason=String(b.reason||'').trim(),cnpj=String(b.cnpj||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(!/^[0-9a-f-]{36}$/i.test(id)||!['RESOLVE','REJECT'].includes(action)||reason.length<5||reason.length>2000)return reply({error:'Candidate, action and reason required'},400);
 const {data:c}=await admin.from('candidate_entities').select('*').eq('id',id).eq('organization_id',org).maybeSingle();if(!c||!['QSA_LEGAL_ENTITY','QSA_UNRESOLVED_ENTITY','FAMILY_CONTEXT_MATCH','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON'].includes(c.candidate_type))return reply({error:'Candidate not found'},404);
 if(['FAMILY_CONTEXT_MATCH','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON'].includes(c.candidate_type)&&action!=='REJECT')return reply({error:'A pista familiar pode ser aberta para pesquisa independente ou descartada; parentesco não é confirmado por este fluxo.'},409);
 const args:any={p_org:org,p_user:user.id,p_candidate:id,p_action:action,p_reason:reason};
 try{
  if(action==='RESOLVE'){
   if(c.validation_status==='REJECTED'||c.candidate_type!=='QSA_LEGAL_ENTITY')return reply({error:'Candidate requires manual review'},409);
   if(!/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj)||cnpj.slice(0,8)!==c.metadata?.basic_cnpj)return reply({error:'Informe o CNPJ completo da mesma raiz cadastral do candidato.'},400);
   const {data:parent}=await admin.from('companies').select('*').eq('id',c.metadata?.parent_company_id).eq('organization_id',org).maybeSingle();if(!parent)return reply({error:'Parent company not found'},404);
   const read=(id:string)=>fetchSourceJson('https://app.baseempresarial.com.br/api/v1/companies/'+id.slice(0,8),v=>Boolean(normalizeBaseCompany(v,id)),{timeoutMs:8000});
   const [parentSource,targetSource]=await Promise.all([read(parent.cnpj),read(cnpj)]);
   if(!parentSource.ok||!targetSource.ok)return reply({error:'Não foi possível validar os dois cadastros. Candidato mantido pendente.'},502);
   const target=normalizeBaseCompany(targetSource.data,cnpj);
   if(!validateQsaMapping(parentSource.data,targetSource.data,cnpj,c))return reply({error:'O QSA atual, o nome ou o CNPJ não corroboram este candidato. Nenhum vínculo foi criado.'},409);
   const {data:company,error}=await admin.from('companies').upsert({organization_id:org,cnpj,legal_name:target.razao_social,trade_name:target.nome_fantasia,city:target.municipio,state:target.uf,cnae_code:String(target.cnae_fiscal||''),source_label:'Base Empresarial / base pública RFB',source_url:'https://baseempresarial.com.br/empresa/'+cnpj,consulted_at:new Date().toISOString(),created_by:user.id},{onConflict:'organization_id,cnpj',ignoreDuplicates:true}).select('id').maybeSingle();
   if(error)return reply({error:'Could not resolve company'},500);
   const resolved=company||(await admin.from('companies').select('id').eq('organization_id',org).eq('cnpj',cnpj).single()).data;if(!resolved)return reply({error:'Could not resolve company'},500);
   const {data:registry}=await admin.from('source_registry').select('id').eq('key','base_empresarial_rfb').maybeSingle();
   const payload=(companyId:string,key:string,title:string,excerpt:string,sourceCnpj:string)=>({organization_id:org,lead_id:c.lead_id,company_id:companyId,source_registry_id:registry?.id,title,excerpt,source_label:'Base Empresarial / base pública RFB',source_url:'https://baseempresarial.com.br/empresa/'+sourceCnpj,source_kind:'AGGREGATOR',document_type:'CNPJ_REGISTRY',publisher:'Base Empresarial',retrieved_at:new Date().toISOString(),dedupe_key:key,reliability_weight:0.75,raw_reference:sourceCnpj,verification_status:'VERIFIED',last_verified_at:new Date().toISOString(),usage_scope:'INTERNAL',created_by:user.id});
   const a=await persistSourceEvidence(admin,payload(parent.id,`${c.lead_id}:qsa-parent:${id}`,`QSA de ${parent.legal_name}`,`${c.label} consta como pessoa jurídica sócia de ${parent.legal_name}; CNPJ de origem ${parent.cnpj}.`,parent.cnpj));
   const t=await persistSourceEvidence(admin,payload(resolved.id,`${c.lead_id}:qsa-target:${id}`,`Cadastro da empresa sócia ${target.razao_social}`,`CNPJ completo ${cnpj}; razão social ${target.razao_social}; raiz ${cnpj.slice(0,8)}; município ${target.municipio||'não informado'}/${target.uf||'não informado'}.`,cnpj));
   if(a.error||t.error)return reply({error:'Could not persist supporting documents'},500);
   if(a.data.verification_status!=='VERIFIED'||t.data.verification_status!=='VERIFIED')return reply({error:'Os documentos aguardam revisão. Nenhum vínculo foi confirmado.'},409);
   Object.assign(args,{p_company:resolved.id,p_parent_evidence:a.data.id,p_target_evidence:t.data.id});
  }
  const {data,error}=await admin.rpc('review_graph_candidate',args);if(error)return reply({error:'Revisão bloqueada por identidade, documento ou vínculo rejeitado.'},409);
  return reply({ok:true,candidate:data,company_id:data.metadata?.resolved_company_id||null});
 }catch{return reply({error:'Candidate review failed; retry without changing identity'},502);}
});
