import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'jsr:@supabase/supabase-js@2';
import {selectTerritory,searchOutcome} from '../_shared/source-operations.ts';
import {fetchQueridoDiarioJson,QUERIDO_DIARIO_API as API} from '../_shared/querido-diario-fetch.ts';

const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const norm=(v:string)=>(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const strip=(v:string)=>(v||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const digits=(v:string)=>(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const reply=(body:unknown,status=200,retry:number|null=null)=>new Response(JSON.stringify(body),{status,headers:{...H,...(retry&&retry>0?{'Retry-After':String(retry)}:{})}});
const retryDate=(seconds:number|null)=>{if(!seconds)return null;const d=new Date(Date.now()+seconds*1000);return Number.isNaN(d.getTime())?null:d.toISOString()};

Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return reply({ok:true});if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization');if(!auth)return reply({error:'Unauthorized'},401);
 try{
  const url=Deno.env.get('SUPABASE_URL')!,admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),client=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
  const session=await client.auth.getUser(),user=session.data?.user;if(session.error||!user)return reply({error:'Unauthorized'},401);
  const b=await req.json().catch(()=>null);if(!b||typeof b!=='object'||Array.isArray(b)||!uuid(b.lead_id)||b.research_run_id&&!uuid(b.research_run_id))return reply({error:'Valid lead_id and research_run_id required'},400);
  const leadId=b.lead_id,runId=b.research_run_id||null,maxResults=Number(b.max_results??10);
  if(!Number.isInteger(maxResults)||maxResults<1||maxResults>20)return reply({error:'max_results must be an integer from 1 to 20'},400);
  const p=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();if(p.error)throw Error('Profile read failed');const orgId=p.data?.active_organization_id;if(!orgId)return reply({error:'No active organization'},409);
  const member=await admin.from('organization_members').select('status,role').eq('organization_id',orgId).eq('user_id',user.id).maybeSingle();if(member.error)throw Error('Membership read failed');if(member.data?.status!=='ACTIVE'||!['OWNER','ADMIN','ANALYST','MEMBER'].includes(member.data.role))return reply({error:'No research permission'},403);
  const loaded=await admin.from('leads').select('id,name,city,state').eq('id',leadId).eq('organization_id',orgId).maybeSingle();if(loaded.error)throw Error('Lead read failed');const lead=loaded.data;if(!lead)return reply({error:'Lead not found'},404);
  if(runId){const run=await admin.from('research_runs').select('id').eq('id',runId).eq('lead_id',leadId).eq('organization_id',orgId).maybeSingle();if(run.error)throw Error('Run read failed');if(!run.data)return reply({error:'Research run not found'},404)}
  const source=await admin.from('source_registry').select('id,connection_status').eq('key','querido_diario').maybeSingle();if(source.error)throw Error('Source read failed');
  if(!source.data||!['CONNECTED','CONNECTED_LIMITED'].includes(source.data.connection_status))return reply({ok:true,status:'BLOCKED',complete:false,mentions_found:0,note:'Fonte Querido Diário desativada ou indisponível no catálogo; nenhuma consulta foi iniciada.'});
  const started=Date.now(),deadline=started+45000,sourceAttempts:any[]=[],sourceErrors:any[]=[];let retryAfter:number|null=null;
  async function read(path:string,valid:(v:any)=>boolean,queryIndex:number|null=null){
   const result=await fetchQueridoDiarioJson(API+path,valid,{deadline});const endpoint=path.split('?')[0];
   sourceAttempts.push(...result.attempts.map(a=>({...a,endpoint,query_index:queryIndex})));
   if(result.retry_after_seconds!==null)retryAfter=Math.max(retryAfter||0,result.retry_after_seconds);
   if(!result.ok)sourceErrors.push({endpoint,query_index:queryIndex,status:result.status,error:result.error,retry_after_seconds:result.retry_after_seconds});
   return result;
  }
  const diagnostics=()=>({source_key:'querido_diario',upstream_http_status:sourceAttempts.at(-1)?.status??null,source_error:sourceErrors.at(-1)?.error||null,source_errors:sourceErrors,source_attempts:sourceAttempts,retry_after_seconds:retryAfter,retry_not_before:retryDate(retryAfter)});
  async function log(result:string,success:boolean,endpoint:string){
   const saved=await admin.from('source_fetch_logs').insert({organization_id:orgId,research_run_id:runId,source_registry_id:source.data.id,endpoint_reference:API+endpoint,success,http_status:sourceAttempts.at(-1)?.status??null,result_status:result,error_summary:sourceErrors.length?JSON.stringify({errors:sourceErrors,retry_after_seconds:retryAfter}).slice(0,1800):null,duration_ms:Date.now()-started,created_by:user.id});if(saved.error)throw Error('Source log persistence failed');
  }
  async function stop(status:string,note:string,responseStatus=200){await log(status,status==='CITY_NOT_COVERED_CONFIRMED','/cities');return reply({ok:responseStatus===200,status,complete:false,territory_found:false,mentions_found:0,results:[],note,...diagnostics()},responseStatus,retryAfter)}
  if(!String(lead.city||'').trim())return stop('CITY_REQUIRED','Informe o município para consultar os diários locais.');
  const cities=await read('/cities?city_name='+encodeURIComponent(String(lead.city).trim()),v=>{const rows=Array.isArray(v)?v:v?.cities;return Array.isArray(rows)&&rows.every(c=>c&&typeof c==='object'&&/^\d{7}$/.test(String(c.territory_id||c.id||''))&&String(c.territory_name||c.name||c.city_name||'').trim()&&/^[A-Z]{2}$/i.test(String(c.state_code||c.state||'')))});
  if(!cities.ok)return stop('CITY_LOOKUP_FAILED','Consulta de municípios indisponível: '+cities.error+'. Isso não confirma ausência de cobertura.',502);
  const selected=selectTerritory(Array.isArray(cities.data)?cities.data:cities.data.cities,String(lead.city),String(lead.state||''));
  if(selected.ambiguous)return stop('CITY_AMBIGUOUS','Município ambíguo; informe a UF.');
  const city=selected.city,territoryId=String(city?.territory_id||city?.id||'');
  if(!territoryId)return stop('CITY_NOT_COVERED_CONFIRMED','Município/UF não encontrado na resposta válida de cobertura do Querido Diário.');
  const linked=await admin.from('lead_company_links').select('company_id,companies(cnpj,legal_name,trade_name)').eq('lead_id',leadId).eq('organization_id',orgId).neq('status','REJECTED');if(linked.error)throw Error('Company context read failed');
  const terms:string[]=[];if(lead.name)terms.push(String(lead.name).trim());
  for(const l of linked.data||[]){const c:any=l.companies;if(c?.legal_name)terms.push(String(c.legal_name).trim());if(c?.trade_name&&norm(c.trade_name)!==norm(c.legal_name))terms.push(String(c.trade_name).trim());if(c?.cnpj)terms.push(digits(String(c.cnpj)))}
  if(Array.isArray(b.terms))for(const t of b.terms)if(typeof t==='string'&&t.trim())terms.push(t.trim());
  const uniq=[...new Map(terms.filter(x=>x.length>=4).map(x=>[norm(x),x])).values()].slice(0,4),persisted:any[]=[],seen=new Set<string>();
  if(!uniq.length)return stop('NO_SEARCH_TERMS','Não há termos suficientes para a pesquisa.');
  let completed=0,failed=0,skipped=0,truncated=false,reviewExcluded=false;
  for(let i=0;i<uniq.length;i++){
   if(Date.now()+100>=deadline){skipped=uniq.length-i;sourceErrors.push({endpoint:'/gazettes',query_index:i,status:null,error:'DEADLINE',retry_after_seconds:null});break}
   const term=uniq[i],size=Math.min(maxResults,10),qs=new URLSearchParams({territory_ids:territoryId,querystring:term,excerpt_size:'700',number_of_excerpts:'3',size:String(size)});
   const result=await read('/gazettes?'+qs.toString(),v=>Array.isArray(v?.gazettes)&&v.gazettes.length<=size,i);
   if(!result.ok){failed++;if([401,403,429].includes(result.status||0)||result.retry_after_seconds!==null&&result.retry_after_seconds>2){skipped=uniq.length-i-1;break}continue}
   if(!Number.isInteger(result.data.total_gazettes)||result.data.total_gazettes<result.data.gazettes.length||result.data.total_gazettes>result.data.gazettes.length)truncated=true;
   for(const g of result.data.gazettes){
    if(!g||String(g.territory_id)!==territoryId||String(g.state_code||'').toUpperCase()!==String(city.state_code||city.state||lead.state||'').toUpperCase()||!/^https:\/\//i.test(String(g.url||g.file_url||g.source_url||''))||!/^\d{4}-\d{2}-\d{2}$/.test(String(g.date||g.published_at||'').slice(0,10))){truncated=true;sourceErrors.push({endpoint:'/gazettes',query_index:i,status:result.status,error:'INVALID_GAZETTE_ROW',retry_after_seconds:null});continue}
    const srcUrl=String(g.url||g.file_url||g.source_url||''),date=String(g.date||g.published_at||'').slice(0,10)||null,key=`${srcUrl}|${norm(term)}`;if(seen.has(key))continue;seen.add(key);
    let ex:any[]=Array.isArray(g.excerpts)?g.excerpts:[];if(!ex.length&&g.excerpt)ex=[g.excerpt];if(!ex.length&&g.text_excerpt)ex=[g.text_excerpt];
    const excerpt=strip(ex.map(x=>typeof x==='string'?x:(x?.text||x?.excerpt||JSON.stringify(x))).join(' … ')).slice(0,3500),bytes=new TextEncoder().encode(`querido_diario|${territoryId}|${srcUrl}|${term}`),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const territoryName=String(g.territory_name||city?.territory_name||lead.city||'Município'),stateCode=String(g.state_code||city?.state_code||lead.state||'');
    const payload={organization_id:orgId,lead_id:leadId,source_registry_id:source.data.id,title:`Menção em Diário Oficial Municipal — ${territoryName}/${stateCode}`,source_label:'Querido Diário — Diários Oficiais Municipais',source_url:srcUrl||null,source_kind:'AGGREGATOR',document_type:'MUNICIPAL_GAZETTE_MENTION',publisher:`Querido Diário / Diário Oficial de ${territoryName}`,source_date:date,retrieved_at:new Date().toISOString(),evidence_hash:hash,dedupe_key:`${leadId}:querido_diario:${hash}`,reliability_weight:0.8,raw_reference:`territory_id=${territoryId}; query=${term}`,excerpt:excerpt||`O termo "${term}" foi localizado em edição do Diário Oficial Municipal.`,verification_status:'PENDING',last_verified_at:null,usage_scope:'INTERNAL',created_by:user.id};
    const inserted=await admin.from('evidence').upsert(payload,{onConflict:'organization_id,dedupe_key',ignoreDuplicates:true});if(inserted.error)throw Error('Evidence persistence failed');
    const ev=await admin.from('evidence').select('id,title,source_url,source_date,excerpt,verification_status').eq('organization_id',orgId).eq('lead_id',leadId).eq('dedupe_key',payload.dedupe_key).single();if(ev.error||!ev.data)throw Error('Evidence readback failed');
    if(['PENDING','VERIFIED'].includes(ev.data.verification_status))persisted.push({...ev.data,query:term,territory_id:territoryId});else reviewExcluded=true;
   }
   completed++;
  }
  if(persisted.length){const existing=await admin.from('investigation_questions').select('id').eq('organization_id',orgId).eq('lead_id',leadId).eq('question_type','MUNICIPAL_GAZETTE_CONTEXT').eq('status','OPEN').maybeSingle();if(existing.error)throw Error('Question read failed');if(!existing.data){const saved=await admin.from('investigation_questions').insert({organization_id:orgId,lead_id:leadId,research_run_id:runId,question_type:'MUNICIPAL_GAZETTE_CONTEXT',question:'As menções encontradas em diários oficiais municipais representam contrato, nomeação, ato societário, licitação, pagamento ou apenas citação contextual? Validar o documento antes de transformar em fato.',status:'OPEN',created_by:user.id});if(saved.error)throw Error('Question persistence failed')}}
  const outcome=searchOutcome(completed,failed+skipped+(truncated||reviewExcluded?1:0),persisted.length),complete=completed===uniq.length&&!failed&&!skipped&&!truncated&&!reviewExcluded;
  await log(outcome,!failed&&!skipped&&!sourceErrors.length,'/gazettes');
  const note=outcome==='QUERY_FAILED'?`Consulta à fonte não concluída: ${[...new Set(sourceErrors.map(e=>e.error))].join(', ')}. Não interpretar como ausência de menções.`:outcome==='PARTIAL'?'Consulta parcial; documentos já encontrados foram preservados. As consultas não concluídas e o recorte limitado não comprovam ausência de menções.':outcome==='NO_MENTIONS'?'Nenhuma menção encontrada nos termos e município consultados; isso não comprova inexistência fora desse recorte.':`${persisted.length} menção(ões) de publicação encontrada(s); validar os documentos antes de transformar em fatos.`;
  return reply({ok:completed>0,status:outcome,complete,queries_completed:completed,queries_failed:failed,queries_skipped:skipped,truncated,review_excluded:reviewExcluded,territory_found:true,territory_id:territoryId,territory_name:city?.territory_name||lead.city,terms_searched:uniq,mentions_found:persisted.length,evidence:persisted,note,...diagnostics(),caveat:'Menção em diário municipal é evidência de publicação, não prova por si só relação econômica, pagamento, parentesco ou patrimônio.'},completed?200:502,retryAfter);
 }catch{return reply({error:'Não foi possível concluir ou registrar a consulta municipal.',status:'PERSISTENCE_OR_CONTEXT_FAILED',complete:false},500)}
});
