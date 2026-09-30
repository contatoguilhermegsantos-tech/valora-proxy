
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchSourceJson, advanceCoverage } from "../_shared/source-operations.ts";
import { sourceBatches } from '../_shared/source-batches.ts';
const H={"Content-Type":"application/json"};
const digits=(v:unknown)=>String(v??"").replace(/\D/g,"");
const toDate=(v:unknown)=>{const s=String(v??"").trim();return s&&s.length>=10?s.slice(0,10):null};
const num=(v:unknown)=>{if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null};
const ymd=(d:Date)=>String(d.getUTCFullYear())+String(d.getUTCMonth()+1).padStart(2,"0")+String(d.getUTCDate()).padStart(2,"0");
const iso=(d:Date)=>String(d.getUTCFullYear())+"-"+String(d.getUTCMonth()+1).padStart(2,"0")+"-"+String(d.getUTCDate()).padStart(2,"0");
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

async function fetchJsonWithRetry(endpoint:URL){
 endpoint.searchParams.set("tamanhoPagina","100");
 const result=await fetchSourceJson(endpoint.toString(),v=>Array.isArray(v?.data)||Array.isArray(v?.items)||Array.isArray(v));
 return {...result,json:result.data,pageSize:100,empty200:false};
}

Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
 const url=Deno.env.get("SUPABASE_URL")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,admin=createClient(url,service);
 const presented=req.headers.get("X-MAX-SYNC-TOKEN")||"";
 const {data:tokenRow}=await admin.from("system_internal_tokens").select("token").eq("key","pncp_sync").maybeSingle();
 if(!tokenRow?.token||presented!==tokenRow.token)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});
 const body=await req.json().catch(()=>({}));
 let from:Date,to:Date;
 if(body.mode==="yesterday"||(!body.date_from&&!body.date_to)){to=new Date();to.setUTCDate(to.getUTCDate()-1);from=new Date(to)}
 else{from=new Date(String(body.date_from)+"T00:00:00Z");to=new Date(String(body.date_to||body.date_from)+"T00:00:00Z");if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime()))return new Response(JSON.stringify({error:"Invalid date range"}),{status:400,headers:H})}
 const days=Math.floor((to.getTime()-from.getTime())/86400000);if(days<0||days>31)return new Response(JSON.stringify({error:"Date range must be 0-31 days"}),{status:400,headers:H});
 // Daily cron only enqueues dates. The existing worker owns bounded, resumable batches.
 if(!body.queue_id){
  if(body.mode==="yesterday"||(!body.date_from&&!body.date_to)){
   const {data:coverage}=await admin.from("source_sync_state").select("last_successful_date").eq("source_key","pncp").maybeSingle();
   if(coverage?.last_successful_date){const next=new Date(coverage.last_successful_date+"T00:00:00Z");next.setUTCDate(next.getUTCDate()+1);from=new Date(Math.max(next.getTime(),to.getTime()-30*86400000));}
  }
  const dates=[];for(let d=new Date(from);d<=to;d.setUTCDate(d.getUTCDate()+1))dates.push({source_key:"pncp",target_date:iso(d),status:"PENDING"});
  const {error}=await admin.from("source_backfill_queue").upsert(dates,{onConflict:"source_key,target_date",ignoreDuplicates:true});
  return new Response(JSON.stringify({ok:!error,status:error?"FAILED":"QUEUED",dates:dates.length,error:error?"Could not enqueue dates":null}),{status:error?500:200,headers:H});
 }
 const {data:queueItem}=await admin.from("source_backfill_queue").select("id,target_date,next_page,status").eq("id",body.queue_id).eq("source_key","pncp").maybeSingle();
 if(!queueItem||queueItem.status!=="RUNNING"||queueItem.target_date!==iso(from)||iso(from)!==iso(to))return new Response(JSON.stringify({error:"Invalid worker claim"}),{status:409,headers:H});
 const startPage=Number(queueItem.next_page||1),maxPages=5;
 const {data:run}=await admin.from("connector_run_log").insert({source_key:"pncp",run_type:"CONTRACT_INDEX",date_from:iso(from),date_to:iso(to),status:"RUNNING"}).select("id").single();
 let page=startPage,pagesFetched=0,recordsSeen=0,recordsIndexed=0,status="SUCCESS",errorSummary:string|null=null,lastPageSize:number|null=null,empty200Observed=false,finished=false;
 try{
  while(pagesFetched<maxPages){
   const endpoint=new URL("https://pncp.gov.br/api/consulta/v1/contratos");endpoint.searchParams.set("dataInicial",ymd(from));endpoint.searchParams.set("dataFinal",ymd(to));endpoint.searchParams.set("pagina",String(page));
   const fetched=await fetchJsonWithRetry(endpoint);
   if(!fetched.ok){status=pagesFetched>0?"PARTIAL":"FAILED";errorSummary="PNCP unavailable on page "+page+": "+fetched.error;break}
   lastPageSize=fetched.pageSize;empty200Observed=empty200Observed||Boolean(fetched.empty200);
   const json:any=fetched.json;const rows:any[]=Array.isArray(json?.data)?json.data:Array.isArray(json?.items)?json.items:Array.isArray(json)?json:[];
   pagesFetched++;recordsSeen+=rows.length;if(!rows.length){finished=true;break;}
   const pageMap=new Map<string,any>();
   for(const r of rows){
    const supplier=digits(r.niFornecedor??r.fornecedor?.ni??r.fornecedor?.cnpj),personType=String(r.tipoPessoa??r.tipoPessoaFornecedor??r.fornecedor?.tipoPessoa??"").toUpperCase();
    if(supplier.length!==14||(personType&&personType!=="PJ"))continue;
    const control=String(r.numeroControlePNCP??r.numeroControlePncp??r.id??"").trim();if(!control)continue;
    const orgCnpj=digits(r.orgaoEntidade?.cnpj??r.orgao?.cnpj??r.cnpjOrgao??r.orgaoCnpj),orgName=String(r.orgaoEntidade?.razaoSocial??r.orgao?.razaoSocial??r.nomeOrgao??"").trim()||null;
    const year=Number(r.anoContrato??r.ano??0)||null,seq=r.sequencialContrato??r.sequencial??null,sourceUrl=orgCnpj&&year&&seq?"https://pncp.gov.br/app/contratos/"+orgCnpj+"/"+year+"/"+seq:endpoint.toString();
    pageMap.set(control,{pncp_control_number:control,supplier_cnpj:supplier,supplier_name:String(r.nomeRazaoSocialFornecedor??r.fornecedor?.nome??"").trim()||null,public_body_cnpj:orgCnpj||null,public_body_name:orgName,administrative_unit:String(r.unidadeOrgao?.nomeUnidade??r.unidade?.nomeUnidade??r.nomeUnidade??"").trim()||null,object_text:String(r.objetoContrato??r.objeto??"").trim()||null,contract_number:String(r.numeroContratoEmpenho??r.numeroContrato??"").trim()||null,contract_year:year,contract_type:String(r.tipoContrato?.nome??r.tipoContratoNome??r.tipoContratoId??"").trim()||null,initial_value:num(r.valorInicial),global_value:num(r.valorGlobal),accumulated_value:num(r.valorAcumulado),signature_date:toDate(r.dataAssinatura),validity_start:toDate(r.dataVigenciaInicio),validity_end:toDate(r.dataVigenciaFim),pncp_publication_date:r.dataPublicacaoPncp??r.dataPublicacaoPNCP??null,pncp_update_date:r.dataAtualizacao??r.dataAtualizacaoGlobal??null,source_url:sourceUrl,raw_public_metadata:{categoriaProcessoNome:r.categoriaProcesso?.nome??r.categoriaProcessoNome??null,modalidadeNome:r.modalidadeNome??r.modalidade?.nome??null,numeroParcelas:r.numeroParcelas??null,valorParcela:num(r.valorParcela)},indexed_at:new Date().toISOString()});
   }
   const payload=[...pageMap.values()];
   for(const batch of sourceBatches(payload)){
    const {error}=await admin.from("public_contract_index").upsert(batch,{onConflict:"pncp_control_number"});
    if(error)throw new Error("Database batch upsert failed on page "+page);
    recordsIndexed+=batch.length;
   }
   const totalPages=Number(json?.totalPaginas??json?.total_pages??0),remaining=Number(json?.paginasRestantes??json?.remainingPages??0);
   finished=Boolean((totalPages&&page>=totalPages)||(!totalPages&&remaining===0&&rows.length<100));
   // Re-read the terminal page if interrupted before the worker commits DONE.
   const {error:checkpointError}=await admin.from("source_backfill_queue").update({next_page:finished?page:page+1}).eq("id",queueItem.id).eq("status","RUNNING");
   if(checkpointError)throw new Error("Could not save PNCP checkpoint");
   if(finished)break;page++;
   if(pagesFetched<maxPages)await sleep(1500);
  }
  if(status==="SUCCESS"&&!finished){status="PARTIAL";errorSummary="Batch complete; continuation saved for next worker execution"}
 }catch(e){status=pagesFetched>0?"PARTIAL":"FAILED";errorSummary=String(e)}
 await admin.from("connector_run_log").update({finished_at:new Date().toISOString(),status,pages_fetched:pagesFetched,records_seen:recordsSeen,records_indexed:recordsIndexed,error_summary:errorSummary}).eq("id",run?.id);
 const now=new Date().toISOString(),{data:prev}=await admin.from("source_sync_state").select("last_successful_date").eq("source_key","pncp").maybeSingle();
 const update:any={source_key:"pncp",last_attempt_at:now,last_status:status,last_error:errorSummary,metadata:{pages_fetched:pagesFetched,records_seen:recordsSeen,date_from:iso(from),date_to:iso(to),page_size:lastPageSize,empty_http_200_treated_as_zero_results:empty200Observed},updated_at:now};
 if(status==="SUCCESS"){
  const previous=String(prev?.last_successful_date||"");
  const {data:dates,error:datesError}=await admin.from("source_backfill_queue").select("target_date,status").eq("source_key","pncp").gt("target_date",previous||"1900-01-01").order("target_date").limit(1000);
  // A repaired gap may unlock later already-completed dates, but never skip missing days.
  if(!datesError)update.last_successful_date=previous?advanceCoverage(previous,(dates||[]).map(d=>d.target_date===iso(to)?{...d,status:"DONE"}:d)):iso(to);
  update.last_success_at=now;update.records_indexed=recordsIndexed;
 }
 await admin.from("source_sync_state").upsert(update,{onConflict:"source_key"});
 if(status==="SUCCESS")await admin.from("source_registry").update({connection_status:"CONNECTED_LIMITED",last_checked_at:now,limitations:"Indexação incremental em lotes de até 5 páginas, com retomada e tamanho fixo de 100. Resposta vazia ou inválida não confirma ausência de contratos. Contrato publicado não comprova pagamento, margem, caixa recebido ou liquidez pessoal."}).eq("key","pncp");
 return new Response(JSON.stringify({ok:status!=="FAILED",status,date_from:iso(from),date_to:iso(to),pages_fetched:pagesFetched,records_seen:recordsSeen,records_indexed:recordsIndexed,page_size:lastPageSize,empty_200:empty200Observed,error:errorSummary}),{status:status==="FAILED"?502:200,headers:H});
});
