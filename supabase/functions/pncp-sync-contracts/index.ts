
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const H={"Content-Type":"application/json"};
const digits=(v:unknown)=>String(v??"").replace(/\D/g,"");
const toDate=(v:unknown)=>{const s=String(v??"").trim();return s&&s.length>=10?s.slice(0,10):null};
const num=(v:unknown)=>{if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null};
const ymd=(d:Date)=>String(d.getUTCFullYear())+String(d.getUTCMonth()+1).padStart(2,"0")+String(d.getUTCDate()).padStart(2,"0");
const iso=(d:Date)=>String(d.getUTCFullYear())+"-"+String(d.getUTCMonth()+1).padStart(2,"0")+"-"+String(d.getUTCDate()).padStart(2,"0");
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

async function fetchJsonWithRetry(endpoint:URL){
 let lastErr="unknown",lastStatus:number|null=null,empty200Count=0;
 const pageSizes=[100,50,20];
 for(const pageSize of pageSizes){
  endpoint.searchParams.set("tamanhoPagina",String(pageSize));
  for(let attempt=0;attempt<3;attempt++){
   try{
    const resp=await fetch(endpoint.toString(),{headers:{Accept:"application/json","User-Agent":"MAX-Intelligence/1.0"}});
    lastStatus=resp.status;const text=await resp.text();
    if(!resp.ok){
     lastErr="HTTP "+resp.status+(text?" — "+text.slice(0,160):"");
     if(![408,425,429,500,502,503,504].includes(resp.status))break;
    }else if(!text.trim()){
     empty200Count++;lastErr="HTTP 200 with empty body at page_size="+pageSize;
     break;
    }else{
     try{return {ok:true,status:resp.status,json:JSON.parse(text),error:null,pageSize,empty200:false}}
     catch(e){lastErr="Invalid/truncated JSON at page_size="+pageSize+": "+String(e)+"; bytes="+text.length;break}
    }
   }catch(e){lastErr="Network error: "+String(e)}
   if(attempt<2)await sleep(500*Math.pow(2,attempt));
  }
 }
 if(empty200Count===pageSizes.length)return {ok:true,status:200,json:{data:[],totalPaginas:0,paginasRestantes:0},error:null,pageSize:20,empty200:true};
 return {ok:false,status:lastStatus,json:null,error:lastErr,pageSize:null,empty200:false};
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
 const maxPages=Math.min(Math.max(Number(body.max_pages||200),1),400);
 const {data:run}=await admin.from("connector_run_log").insert({source_key:"pncp",run_type:"CONTRACT_INDEX",date_from:iso(from),date_to:iso(to),status:"RUNNING"}).select("id").single();
 let page=1,pagesFetched=0,recordsSeen=0,recordsIndexed=0,status="SUCCESS",errorSummary:string|null=null,lastPageSize:number|null=null,empty200Observed=false;
 try{
  while(page<=maxPages){
   const endpoint=new URL("https://pncp.gov.br/api/consulta/v1/contratos");endpoint.searchParams.set("dataInicial",ymd(from));endpoint.searchParams.set("dataFinal",ymd(to));endpoint.searchParams.set("pagina",String(page));
   const fetched=await fetchJsonWithRetry(endpoint);
   if(!fetched.ok){status=pagesFetched>0?"PARTIAL":"FAILED";errorSummary="PNCP unavailable on page "+page+": "+fetched.error;break}
   lastPageSize=fetched.pageSize;empty200Observed=empty200Observed||Boolean(fetched.empty200);
   const json:any=fetched.json;const rows:any[]=Array.isArray(json?.data)?json.data:Array.isArray(json?.items)?json.items:Array.isArray(json)?json:[];
   pagesFetched++;recordsSeen+=rows.length;if(!rows.length)break;
   const pageMap=new Map<string,any>();
   for(const r of rows){
    const supplier=digits(r.niFornecedor??r.fornecedor?.ni??r.fornecedor?.cnpj),personType=String(r.tipoPessoa??r.tipoPessoaFornecedor??r.fornecedor?.tipoPessoa??"").toUpperCase();
    if(supplier.length!==14||(personType&&personType!=="PJ"))continue;
    const control=String(r.numeroControlePNCP??r.numeroControlePncp??r.id??"").trim();if(!control)continue;
    const orgCnpj=digits(r.orgaoEntidade?.cnpj??r.orgao?.cnpj??r.cnpjOrgao??r.orgaoCnpj),orgName=String(r.orgaoEntidade?.razaoSocial??r.orgao?.razaoSocial??r.nomeOrgao??"").trim()||null;
    const year=Number(r.anoContrato??r.ano??0)||null,seq=r.sequencialContrato??r.sequencial??null,sourceUrl=orgCnpj&&year&&seq?"https://pncp.gov.br/app/contratos/"+orgCnpj+"/"+year+"/"+seq:endpoint.toString();
    pageMap.set(control,{pncp_control_number:control,supplier_cnpj:supplier,supplier_name:String(r.nomeRazaoSocialFornecedor??r.fornecedor?.nome??"").trim()||null,public_body_cnpj:orgCnpj||null,public_body_name:orgName,administrative_unit:String(r.unidadeOrgao?.nomeUnidade??r.unidade?.nomeUnidade??r.nomeUnidade??"").trim()||null,object_text:String(r.objetoContrato??r.objeto??"").trim()||null,contract_number:String(r.numeroContratoEmpenho??r.numeroContrato??"").trim()||null,contract_year:year,contract_type:String(r.tipoContrato?.nome??r.tipoContratoNome??r.tipoContratoId??"").trim()||null,initial_value:num(r.valorInicial),global_value:num(r.valorGlobal),accumulated_value:num(r.valorAcumulado),signature_date:toDate(r.dataAssinatura),validity_start:toDate(r.dataVigenciaInicio),validity_end:toDate(r.dataVigenciaFim),pncp_publication_date:r.dataPublicacaoPncp??r.dataPublicacaoPNCP??null,pncp_update_date:r.dataAtualizacao??r.dataAtualizacaoGlobal??null,source_url:sourceUrl,raw_public_metadata:{categoriaProcessoNome:r.categoriaProcesso?.nome??r.categoriaProcessoNome??null,modalidadeNome:r.modalidadeNome??r.modalidade?.nome??null,numeroParcelas:r.numeroParcelas??null,valorParcela:num(r.valorParcela)},indexed_at:new Date().toISOString()});
   }
   const payload=[...pageMap.values()];if(payload.length){const {error}=await admin.from("public_contract_index").upsert(payload,{onConflict:"pncp_control_number"});if(error){status=pagesFetched>1?"PARTIAL":"FAILED";errorSummary="Database batch upsert failed on page "+page+": "+error.message;break}recordsIndexed+=payload.length}
   const totalPages=Number(json?.totalPaginas??json?.total_pages??0),remaining=Number(json?.paginasRestantes??json?.remainingPages??0);
   if((totalPages&&page>=totalPages)||(!totalPages&&remaining===0&&rows.length<(lastPageSize||100)))break;page++;
  }
  if(status==="SUCCESS"&&page>maxPages){status="PARTIAL";errorSummary="Reached configured page cap before confirming end of result set"}
 }catch(e){status=pagesFetched>0?"PARTIAL":"FAILED";errorSummary=String(e)}
 await admin.from("connector_run_log").update({finished_at:new Date().toISOString(),status,pages_fetched:pagesFetched,records_seen:recordsSeen,records_indexed:recordsIndexed,error_summary:errorSummary}).eq("id",run?.id);
 const now=new Date().toISOString(),{data:prev}=await admin.from("source_sync_state").select("last_successful_date").eq("source_key","pncp").maybeSingle();
 const update:any={source_key:"pncp",last_attempt_at:now,last_status:status,last_error:errorSummary,metadata:{pages_fetched:pagesFetched,records_seen:recordsSeen,date_from:iso(from),date_to:iso(to),page_size:lastPageSize,empty_http_200_treated_as_zero_results:empty200Observed},updated_at:now};
 if(status==="SUCCESS"){const previous=String(prev?.last_successful_date||"");update.last_successful_date=previous&&previous>iso(to)?previous:iso(to);update.last_success_at=now;update.records_indexed=recordsIndexed}
 await admin.from("source_sync_state").upsert(update,{onConflict:"source_key"});
 if(status==="SUCCESS")await admin.from("source_registry").update({connection_status:"CONNECTED_LIMITED",last_checked_at:now,limitations:"API oficial conectada para indexação incremental de contratos. A API pode responder HTTP 200 sem corpo em datas sem resultados; o MAX só trata isso como zero após repetir a consulta em três tamanhos de página. Contrato publicado não comprova pagamento, margem, caixa recebido ou liquidez pessoal."}).eq("key","pncp");
 return new Response(JSON.stringify({ok:status!=="FAILED",status,date_from:iso(from),date_to:iso(to),pages_fetched:pagesFetched,records_seen:recordsSeen,records_indexed:recordsIndexed,page_size:lastPageSize,empty_200:empty200Observed,error:errorSummary}),{status:status==="FAILED"?502:200,headers:H});
});
