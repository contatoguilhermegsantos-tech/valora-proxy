import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {summarizeSourceHealth,summarizeQualityRun} from '../supabase/functions/_shared/source-operations.ts';

const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333',SOURCE='44444444-4444-4444-8444-444444444444';
const NOW=Date.parse('2026-10-07T12:00:00Z'),FINISHED='2026-10-07T11:00:00Z';
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture(overrides={}){
 let handler;const reads=[],writes=[],clients=[];
 const state={user:{id:USER},activeOrg:ORG,member:{user_id:USER,organization_id:ORG,status:'ACTIVE'},quality:[{status:'FAIL',critical_count:1,warning_count:0,finished_at:FINISHED,snapshot:{error:'PRIVATE_SQL_TIMEOUT',sql:'PRIVATE_SQL_BODY',token:'PRIVATE_SNAPSHOT_TOKEN'}}],logs:[{organization_id:ORG,source_registry_id:SOURCE,result_status:'HTTP_503',success:false,duration_ms:100,queried_at:'2026-10-07T10:00:00Z',raw_response:'PRIVATE_UPSTREAM_BODY'},{organization_id:OTHER,source_registry_id:OTHER,result_status:'MENTIONS_FOUND',success:true,duration_ms:20,queried_at:'2026-10-07T10:30:00Z',raw_response:'FOREIGN_ORG_RECORD'},{organization_id:ORG,source_registry_id:OTHER,result_status:'MENTIONS_FOUND',success:true,duration_ms:20,queried_at:'2026-10-01T10:30:00Z',raw_response:'OLD_RECORD'}],...overrides};
 const tables={source_registry:[{id:SOURCE,key:'querido_diario',name:'Querido Diário',category:'PUBLIC_RECORD',source_tier:'AGGREGATOR',domain:'queridodiario.org.br',connection_status:'CONNECTED_LIMITED',limitations:'Cobertura limitada',coverage_notes:'Municipal',action_url:'https://queridodiario.ok.org.br/',token:'PRIVATE_CONNECTOR_TOKEN'}],source_candidate_backlog:[],source_sync_state:[],source_backfill_queue:[]};
 function database(auth){return{auth:{getUser:async()=>({data:{user:auth?state.user:null},error:null})},from(table){let columns='*',single=false,limit=null,sort=null,mode='read';const filters=[],q={};q.select=value=>{columns=value||'*';return q};q.single=q.maybeSingle=()=>{single=true;return q};q.order=(key,options={})=>{sort={key,ascending:options.ascending!==false};return q};q.limit=value=>{limit=value;return q};for(const op of ['eq','neq','gte'])q[op]=(key,value)=>{filters.push({op,key,value});return q};for(const op of ['insert','update','upsert'])q[op]=()=>{mode=op;return q};
  q.then=(resolve,reject)=>Promise.resolve().then(()=>{
   const entry={table,columns,filters:clone(filters),limit,sort};(mode==='read'?reads:writes).push(entry);
   let rows=table==='profiles'?[{id:USER,active_organization_id:state.activeOrg}]:table==='organization_members'?state.member?[state.member]:[]:table==='system_quality_runs'?state.quality:table==='source_fetch_logs'?state.logs:tables[table]||[];
   rows=rows.filter(row=>filters.every(({op,key,value})=>op==='eq'?row[key]===value:op==='neq'?row[key]!==value:String(row[key])>=String(value)));
   if(sort)rows=[...rows].sort((a,b)=>String(a[sort.key]).localeCompare(String(b[sort.key]))*(sort.ascending?1:-1));if(limit!==null)rows=rows.slice(0,limit);
   const selected=rows.map(row=>columns==='*'?clone(row):Object.fromEntries(columns.split(',').filter(key=>Object.hasOwn(row,key)).map(key=>[key,clone(row[key])])));
   return{data:single?selected[0]||null:selected,error:null};
  }).then(resolve,reject);return q;
 }};}
 const source=fs.readFileSync(new URL('../supabase/functions/get-source-status/index.ts',import.meta.url),'utf8').replace(/^\uFEFF/,'').replace(/^import .*;\r?\n/gm,'');
 const clockDate=class extends Date{constructor(...args){super(...(args.length?args:[NOW]))}static now(){return NOW}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:key=>key==='SUPABASE_URL'?'https://qa.supabase.co':key==='SUPABASE_ANON_KEY'?'qa-anon-public':'PRIVATE_SERVICE_TOKEN'},serve:fn=>handler=fn},createClient:(url,key,options)=>{clients.push({url,key,auth:options?.global?.headers?.Authorization||null});return database(options?.global?.headers?.Authorization)},summarizeSourceHealth,summarizeQualityRun,Date:clockDate,Request,Response,console,fetch:()=>{throw Error('Unexpected source call')}});
 return{state,reads,writes,clients,call:async({auth=true,method='POST'}={})=>handler(new Request('https://qa.test',{method,headers:auth?{Authorization:'Bearer synthetic','Content-Type':'application/json'}:{'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})}))};
}

test('authenticated source status distinguishes a failed audit query from a measured violation and strips the private journal',async()=>{
 const f=fixture(),response=await f.call(),data=await response.json();assert.equal(response.status,200);
 assert.deepEqual(data.quality,{status:'FAIL',critical_count:null,warning_count:null,finished_at:FINISHED,completed:false,error_code:'AUDIT_QUERY_FAILED'});
 assert.equal(data.sources[0].key,'querido_diario');assert.equal(data.health[0].health,'FAILURE');assert.equal(f.writes.length,0);
 assert.doesNotMatch(JSON.stringify(data),/PRIVATE_|snapshot|raw_response|FOREIGN_ORG_RECORD|OLD_RECORD/);
 const qualityRead=f.reads.find(r=>r.table==='system_quality_runs');assert.ok(qualityRead.columns.split(',').includes('snapshot'));assert.deepEqual(qualityRead.filters,[{op:'neq',key:'status',value:'RUNNING'}]);assert.equal(qualityRead.limit,1);assert.deepEqual(qualityRead.sort,{key:'finished_at',ascending:false});
});

test('real completed FAIL keeps its measured counts and operational status without exposing metrics or arbitrary fields',async()=>{
 const f=fixture({quality:[{status:'FAIL',critical_count:2,warning_count:1,finished_at:FINISHED,snapshot:{metrics:{invalid_lead_cnpjs:2,stuck_research_runs:1,private:'PRIVATE_METRIC'},raw:'PRIVATE_JOURNAL'}}]}),response=await f.call(),data=await response.json();
 assert.equal(response.status,200);assert.deepEqual(data.quality,{status:'FAIL',critical_count:2,warning_count:1,finished_at:FINISHED,completed:true,error_code:null});assert.doesNotMatch(JSON.stringify(data),/PRIVATE_|snapshot|metrics|invalid_lead_cnpjs/);assert.equal(f.writes.length,0);
});

test('no finished audit remains null and a newer RUNNING attempt does not replace the last finished result',async()=>{
 const absent=fixture({quality:[]}),noAudit=await(await absent.call()).json();assert.equal(noAudit.quality,null);assert.equal(noAudit.sources.length,1);assert.equal(absent.writes.length,0);
 const f=fixture({quality:[{status:'RUNNING',critical_count:0,warning_count:0,finished_at:'2026-10-07T11:30:00Z',snapshot:{error:'PRIVATE_RUNNING'}},{status:'PASS',critical_count:0,warning_count:0,finished_at:FINISHED}]}),data=await(await f.call()).json();assert.equal(data.quality.status,'PASS');assert.equal(data.quality.completed,true);assert.equal(data.quality.finished_at,FINISHED);assert.equal(data.quality.error_code,null);assert.doesNotMatch(JSON.stringify(data),/PRIVATE_RUNNING|snapshot/);
});

test('operational source status rejects unauthenticated or inactive organization access before querying audit or tenant logs',async()=>{
 for(const [overrides,options,status]of [[{},{auth:false},401],[{user:null},{},401],[{activeOrg:null},{},403],[{member:null},{},403],[{member:{user_id:USER,organization_id:ORG,status:'INACTIVE'}},{},403],[{member:{user_id:USER,organization_id:OTHER,status:'ACTIVE'}},{},403]]){
  const f=fixture(overrides),response=await f.call(options);assert.equal(response.status,status);assert.equal(f.reads.some(r=>['system_quality_runs','source_fetch_logs','source_registry'].includes(r.table)),false);assert.equal(f.writes.length,0);assert.doesNotMatch(await response.text(),/PRIVATE_|snapshot/);
 }
 const preflight=fixture();assert.equal((await preflight.call({auth:false,method:'OPTIONS'})).status,200);assert.equal(preflight.reads.length,0);assert.equal(preflight.clients.length,0);
 const invalidMethod=fixture();assert.equal((await invalidMethod.call({method:'GET'})).status,405);assert.equal(invalidMethod.reads.length,0);
});

test('source health only consumes recent logs from the active organization while quality stays shared operational metadata',async()=>{
 const f=fixture(),data=await(await f.call()).json();assert.equal(data.health.length,1);assert.equal(data.health[0].source_id,SOURCE);assert.equal(data.health[0].attempts,1);assert.equal(data.health[0].failures,1);
 const membership=f.reads.find(r=>r.table==='organization_members');assert.deepEqual(membership.filters,[{op:'eq',key:'organization_id',value:ORG},{op:'eq',key:'user_id',value:USER}]);
 const logs=f.reads.find(r=>r.table==='source_fetch_logs');assert.deepEqual(logs.filters,[{op:'eq',key:'organization_id',value:ORG},{op:'gte',key:'queried_at',value:'2026-10-05T12:00:00.000Z'}]);assert.equal(logs.limit,500);assert.equal(logs.columns,'source_registry_id,result_status,success,duration_ms,queried_at');assert.equal(data.observation.sample_limit,500);assert.equal(data.observation.sample_limited,false);assert.equal(f.reads.find(r=>r.table==='system_quality_runs').filters.some(r=>r.key==='organization_id'),false);assert.equal(f.writes.length,0);
});
