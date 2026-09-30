
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { collectSourcePages, insertEvidenceOnce } from '../_shared/connector-policy.ts';

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));
const pick=(o:any,...keys:string[])=>{for(const k of keys){const v=o?.[k];if(v!==undefined&&v!==null&&String(v).trim()!=="")return v}return null};
const dateOnly=(v:any)=>{const s=String(v??"").trim();if(!s)return null;const m=s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);if(m)return `${m[3]}-${m[2]}-${m[1]}`;const iso=s.match(/^\d{4}-\d{2}-\d{2}/);return iso?.[0]||null};
async function hash(v:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}

Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:H});
 if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
 const auth=req.headers.get("Authorization")||"";
 if(!auth)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

 const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const token=Deno.env.get("PORTAL_TRANSPARENCIA_API_TOKEN")||"";
 const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}}),admin=createClient(url,service);
 const {data:{user}}=await uc.auth.getUser();
 if(!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

 const b=await req.json().catch(()=>({}));
 const leadId=String(b.lead_id||""),companyId=String(b.company_id||"");
 if(!leadId||!companyId)return new Response(JSON.stringify({error:"lead_id and company_id required"}),{status:400,headers:H});

 const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
 const orgId=p?.active_organization_id;
 if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
 const {data:m}=await admin.from("organization_members").select("status,role").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
 if(m?.status!=="ACTIVE"||m.role==='VIEWER')return new Response(JSON.stringify({error:"No research permission"}),{status:403,headers:H});

 const [{data:lead},{data:company},{data:sourceRow}]=await Promise.all([
   admin.from("leads").select("id,name").eq("id",leadId).eq("organization_id",orgId).maybeSingle(),
   admin.from("companies").select("id,cnpj,legal_name,trade_name").eq("id",companyId).eq("organization_id",orgId).maybeSingle(),
   admin.from("source_registry").select("id").eq("key","portal_transparencia").maybeSingle()
 ]);
 if(!lead||!company)return new Response(JSON.stringify({error:"Lead or company not found"}),{status:404,headers:H});
 const {data:link}=await admin.from('lead_company_links').select('status').eq('organization_id',orgId).eq('lead_id',leadId).eq('company_id',companyId).in('status',['SUPPORTED','VERIFIED']).maybeSingle();
 if(!link)return new Response(JSON.stringify({error:'Company link must be supported or verified'}),{status:409,headers:H});
 const cnpj=cnpjNorm(company.cnpj);
 if(!cnpjShape(cnpj))return new Response(JSON.stringify({error:"Company has no valid numeric/alphanumeric CNPJ"}),{status:400,headers:H});

 if(!token){
   return new Response(JSON.stringify({
     error:"Portal da Transparência API token not configured",
     code:"CONFIG_REQUIRED",
     setup_url:"https://portaldatransparencia.gov.br/api-de-dados/cadastrar-email",
     note:"O conector está implementado, mas a API oficial exige token enviado no header chave-api-dados."
   }),{status:428,headers:H});
 }

 const base="https://api.portaldatransparencia.gov.br/api-de-dados";
 const headers={Accept:"application/json","chave-api-dados":token,"User-Agent":"MAX-Intelligence/1.0"};
 const started=Date.now();

 async function paged(path:string,maxPages=3){
   return collectSourcePages(base+path,headers,maxPages);
 }

 const [contractRes,ceisRes,cnepRes]=await Promise.all([paged("/contratos/cpf-cnpj?cpfCnpj="+cnpj,3),paged("/ceis?codigoSancionado="+cnpj,2),paged("/cnep?codigoSancionado="+cnpj,2)]);

 const failures=[["contracts",contractRes],["ceis",ceisRes],["cnep",cnepRes]].filter(([,r]:any)=>!r.ok);
 if(failures.length===3&&![contractRes,ceisRes,cnepRes].some(r=>r.rows.length)){
   await admin.from("source_fetch_logs").insert({
     organization_id:orgId,source_registry_id:sourceRow?.id,endpoint_reference:"api.portaldatransparencia.gov.br",
     success:false,http_status:Number((failures[0] as any)[1]?.status||0)||null,result_status:"UPSTREAM_ERROR",
     error_summary:failures.map(([k,r]:any)=>k+": "+String(r.error||r.status)).join(" | ").slice(0,1800),
     duration_ms:Date.now()-started,created_by:user.id
   });
   return new Response(JSON.stringify({error:"Portal da Transparência queries failed",detail:failures.map(([k,r]:any)=>({kind:k,status:r.status,error:r.error}))}),{status:502,headers:H});
 }

 const persisted:any[]=[];
 try{
 for(const row of contractRes.rows.slice(0,150)){
   const id=String(pick(row,"id","idContrato","codigoContrato")||"");
   const numero=String(pick(row,"numero","numeroContrato","contrato")||id||"sem número");
   const processo=String(pick(row,"processo","numeroProcesso","processoCompra")||"");
   const objeto=String(pick(row,"objeto","objetoContrato","descricaoObjeto")||"").slice(0,1200);
   const valor=pick(row,"valorInicialCompra","valorInicial","valorContrato","valorGlobal","valor");
   const assinatura=dateOnly(pick(row,"dataAssinatura","dataAssinaturaContrato"));
   const orgao=String(pick(row,"orgaoSuperior","orgaoContratante","unidadeGestora","nomeUnidadeGestora")||"Órgão federal");
   const key="portal_transparencia:contrato:"+cnpj+":"+String(id||numero+"|"+processo);
   const dig=await hash(key);
   const evd=await insertEvidenceOnce(admin,{
     organization_id:orgId,lead_id:leadId,company_id:companyId,source_registry_id:sourceRow?.id||null,
     title:"Contrato federal — "+numero,source_label:"Portal da Transparência do Governo Federal",
     source_url:"https://portaldatransparencia.gov.br/contratos/consulta",source_kind:"PRIMARY_OFFICIAL",
     document_type:"FEDERAL_PUBLIC_CONTRACT",publisher:"Controladoria-Geral da União — Portal da Transparência",
     source_date:assinatura,retrieved_at:new Date().toISOString(),evidence_hash:dig,dedupe_key:leadId+':'+key,legacy_dedupe_key:key,
     reliability_weight:1,raw_reference:JSON.stringify({id,numero,processo}).slice(0,1800),
     excerpt:[orgao,objeto?("objeto: "+objeto):null,valor!=null?("valor contratado informado: "+String(valor)):null,assinatura?("assinatura: "+assinatura):null].filter(Boolean).join("; ").slice(0,3000),
     verification_status:"VERIFIED",last_verified_at:new Date().toISOString(),usage_scope:"MENTIONABLE",created_by:user.id
   });
   if(!evd?.id||evd.verification_status!=='VERIFIED')continue;
   let createdEvent=false;
   let {data:event,error:lookupError}=await admin.from("events").select("id").eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",companyId)
     .eq("event_type","FEDERAL_PUBLIC_CONTRACT").contains("metadata",{source_dedupe_key:key}).maybeSingle();
   if(lookupError)throw new Error('Could not look up contract event');
   if(!event){
     const ins=await admin.from("events").insert({
       organization_id:orgId,lead_id:leadId,company_id:companyId,event_type:"FEDERAL_PUBLIC_CONTRACT",event_date:assinatura,
       title:"Contrato federal "+numero,
       description:"Contrato localizado em fonte oficial federal. O valor contratado não comprova pagamento, margem, caixa recebido ou liquidez pessoal dos sócios.",
       classification:"FACT",confidence:"HIGH",status:"PENDING",
       metadata:{source_dedupe_key:key,contract_id:id||null,contract_number:numero,process_number:processo||null,contract_value:valor??null,contracting_body:orgao,personal_liquidity_confirmed:false,payment_confirmed:false},
       created_by:user.id
     }).select("id").single();if(ins.error)throw new Error('Could not insert contract event');event=ins.data;createdEvent=true;
   }
   if(event?.id){
     const {error}=await admin.from("event_evidence").upsert({organization_id:orgId,event_id:event.id,evidence_id:evd.id,support_type:"SUPPORTS",strength:1},{onConflict:"event_id,evidence_id",ignoreDuplicates:true});
     if(error)throw new Error('Could not attach contract evidence');
     if(createdEvent){const {error:admitError}=await admin.from('events').update({status:'VERIFIED'}).eq('id',event.id).eq('organization_id',orgId).eq('status','PENDING');if(admitError)throw new Error('Could not admit contract event');}
   }
   persisted.push({kind:"CONTRACT",evidence_id:evd.id,event_id:event?.id||null});
 }

 for(const [registry,res,eventType] of [["CEIS",ceisRes,"FEDERAL_CEIS_RECORD"],["CNEP",cnepRes,"FEDERAL_CNEP_RECORD"]] as any[]){
   for(const row of res.rows.slice(0,80)){
     const id=String(pick(row,"id","idRegistro")||"");
     const inicio=dateOnly(pick(row,"dataInicioSancao","dataInicio","dataSancao"));
     const fim=dateOnly(pick(row,"dataFimSancao","dataFim"));
     const tipo=String(pick(row,"tipoSancao.descricaoResumida","descricaoSancao","tipoSancao","sancao")||"Registro administrativo");
     const processo=String(pick(row,"numeroProcesso","processo")||"");
     const key="portal_transparencia:"+registry.toLowerCase()+":"+cnpj+":"+String(id||inicio+"|"+processo+"|"+tipo);
     const dig=await hash(key);
     const evd=await insertEvidenceOnce(admin,{
       organization_id:orgId,lead_id:leadId,company_id:companyId,source_registry_id:sourceRow?.id||null,
       title:registry+" — registro administrativo oficial",source_label:"Portal da Transparência do Governo Federal",
       source_url:"https://portaldatransparencia.gov.br/sancoes",source_kind:"PRIMARY_OFFICIAL",
       document_type:registry+"_ADMINISTRATIVE_RECORD",publisher:"Controladoria-Geral da União — Portal da Transparência",
       source_date:inicio,retrieved_at:new Date().toISOString(),evidence_hash:dig,dedupe_key:leadId+':'+key,legacy_dedupe_key:key,reliability_weight:1,
       raw_reference:JSON.stringify({id,processo}).slice(0,1800),
       excerpt:[registry,tipo,processo?("processo: "+processo):null,inicio?("início: "+inicio):null,fim?("fim: "+fim):null].filter(Boolean).join("; ").slice(0,2500),
       verification_status:"VERIFIED",last_verified_at:new Date().toISOString(),usage_scope:"INTERNAL",created_by:user.id
     });
     if(!evd?.id||evd.verification_status!=='VERIFIED')continue;
     let createdEvent=false;
     let {data:event,error:lookupError}=await admin.from("events").select("id").eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",companyId)
       .eq("event_type",eventType).contains("metadata",{source_dedupe_key:key}).maybeSingle();
     if(lookupError)throw new Error('Could not look up registry event');
     if(!event){
       const ins=await admin.from("events").insert({
         organization_id:orgId,lead_id:leadId,company_id:companyId,event_type:eventType,event_date:inicio,
         title:registry+" — registro administrativo",
         description:"Registro localizado em cadastro administrativo oficial. O MAX não infere crime, dolo ou conduta pessoal de sócios a partir desse registro.",
         classification:"FACT",confidence:"HIGH",status:"PENDING",
         metadata:{source_dedupe_key:key,registry,record_id:id||null,process_number:processo||null,sanction_type:tipo||null,end_date:fim||null,criminal_conduct_inferred:false},
         created_by:user.id
       }).select("id").single();if(ins.error)throw new Error('Could not insert registry event');event=ins.data;createdEvent=true;
     }
     if(event?.id){
       const {error}=await admin.from("event_evidence").upsert({organization_id:orgId,event_id:event.id,evidence_id:evd.id,support_type:"SUPPORTS",strength:1},{onConflict:"event_id,evidence_id",ignoreDuplicates:true});
       if(error)throw new Error('Could not attach registry evidence');
       if(createdEvent){const {error:admitError}=await admin.from('events').update({status:'VERIFIED'}).eq('id',event.id).eq('organization_id',orgId).eq('status','PENDING');if(admitError)throw new Error('Could not admit registry event');}
     }
     persisted.push({kind:registry,evidence_id:evd.id,event_id:event?.id||null});
   }
 }
 }catch{
  await admin.from('source_fetch_logs').insert({organization_id:orgId,source_registry_id:sourceRow?.id,endpoint_reference:base,success:false,result_status:'PERSIST_FAILED',error_summary:'Source results could not be fully persisted',duration_ms:Date.now()-started,created_by:user.id});
  return new Response(JSON.stringify({error:'Could not fully persist source results',status:'PARTIAL',persisted:persisted.length}),{status:500,headers:H});
 }

 const now=new Date().toISOString();
 const partial=[contractRes,ceisRes,cnepRes].some(r=>!r.complete)||contractRes.rows.length>150||ceisRes.rows.length>80||cnepRes.rows.length>80;
 const resultStatus=partial?'PARTIAL':persisted.length?'SUCCESS':'NO_MATCH';
 const updates=await Promise.all([
   admin.from("source_fetch_logs").insert({
     organization_id:orgId,source_registry_id:sourceRow?.id,endpoint_reference:"api.portaldatransparencia.gov.br/api-de-dados",
     success:!partial,http_status:200,result_status:resultStatus,error_summary:partial?'Incomplete queries or pagination limit; do not infer absence':null,duration_ms:Date.now()-started,created_by:user.id
   }),
   admin.from("source_registry").update({
     connection_status:"CONNECTED_LIMITED",last_checked_at:now,
     method:"API REST oficial autenticada por token (header chave-api-dados)",
     limitations:"Cobertura federal. Contrato não comprova pagamento, margem, caixa livre ou liquidez pessoal. CEIS/CNEP são registros administrativos e não autorizam inferir crime ou conduta pessoal de sócios."
   }).eq("key","portal_transparencia"),
   admin.from("source_sync_state").upsert({
     source_key:"portal_transparencia",last_attempt_at:now,...(!partial?{last_success_at:now}:{}),last_status:resultStatus,last_error:partial?'Incomplete queries or pagination limit':null,
     records_indexed:persisted.length,metadata:{last_cnpj:cnpj,contracts_found:contractRes.rows.length,ceis_found:ceisRes.rows.length,cnep_found:cnepRes.rows.length},updated_at:now
   },{onConflict:"source_key"})
 ]);
 if(updates.some(r=>r.error))return new Response(JSON.stringify({error:'Could not record source execution'}),{status:500,headers:H});

 return new Response(JSON.stringify({
   ok:true,status:resultStatus,complete:!partial,queries:{contracts:{complete:contractRes.complete,pages:contractRes.pages},ceis:{complete:ceisRes.complete,pages:ceisRes.pages},cnep:{complete:cnepRes.complete,pages:cnepRes.pages}},cnpj,contracts_found:contractRes.rows.length,ceis_found:ceisRes.rows.length,cnep_found:cnepRes.rows.length,persisted:persisted.length,
   caveat:"Contratos e sanções administrativas são tratados como fatos documentais da fonte oficial; não implicam pagamento, margem, liquidez pessoal, crime ou dolo."
 }),{headers:H});
});

