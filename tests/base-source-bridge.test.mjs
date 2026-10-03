import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {EventEmitter} from 'node:events';

function fixture({ role='ANALYST', status='ACTIVE', user=true, profile=true, dbError=false, upstream=()=>Response.json({data:[],meta:{has_more:false}}) }={}) {
  const reads=[], requests=[];
  const db={auth:{getUser:async token=>({data:{user:user?{id:'user'}:null},error:null})},from(table){const filters={};const q={select:()=>q,eq:(key,value)=>{filters[key]=value;return q},maybeSingle:async()=>{reads.push({table,filters});return {data:table==='profiles'?(profile?{active_organization_id:'org'}:null):{role,status},error:dbError?{}:null}}};return q}};
  const source=fs.readFileSync(new URL('../app/api/source/base-empresarial/route.ts',import.meta.url),'utf8').replace(/^import .*\r?\n/gm,'');
  const httpsRequest=(url,options,callback)=>{
    const request=new EventEmitter();let destroyed=false;
    request.destroy=error=>{destroyed=true;if(error)request.emit('error',error);request.emit('close')};
    request.end=()=>{requests.push({url,options});(async()=>{
      try {const raw=await upstream(url,options);const response=new EventEmitter();response.statusCode=raw.status;response.headers=Object.fromEntries(raw.headers);response.destroy=()=>{destroyed=true;request.emit('close')};callback(response);if(destroyed)return;const reader=raw.body?.getReader();if(reader)while(true){const {done,value}=await reader.read();if(done||destroyed)break;response.emit('data',value)}if(!destroyed)response.emit('end');request.emit('close')}
      catch(error){request.emit('error',error);request.emit('close')}
    })()};return request;
  };
  const context={exports:{},createClient:()=>db,httpsRequest,process:{env:{}},Request,Response,AbortSignal,TextDecoder,ReadableStream,Error,setTimeout,clearTimeout};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {reads,requests,call:(body={operation:'companies_search',city_id:'3525607',page:1},token='fixture')=>context.exports.POST(new Request('https://max.test/api/source/base-empresarial',{method:'POST',headers:{...(token?{Authorization:`Bearer ${token}`} :{}),'Content-Type':'application/json'},body:JSON.stringify(body)}))};
}

test('bridge requires verified user and active organization write membership before public source access',async()=>{
  for(const options of [{user:false},{profile:false},{role:'VIEWER'},{status:'INVITED'},{dbError:true}]){const f=fixture(options);const response=await f.call();assert.ok([401,403,503].includes(response.status));assert.equal(f.requests.length,0)}
  const f=fixture();assert.equal((await f.call(undefined,'')).status,401);assert.equal(f.reads.length,0);assert.equal(f.requests.length,0);
});
test('bridge scopes both database reads, uses fixed public source, and never forwards user credentials',async()=>{
  const f=fixture();const response=await f.call();assert.equal(response.status,200);assert.deepEqual(await response.json(),{data:[],meta:{has_more:false}});assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(f.reads,[{table:'profiles',filters:{id:'user'}},{table:'organization_members',filters:{organization_id:'org',user_id:'user'}}]);
  assert.equal(f.requests[0].url,'https://app.baseempresarial.com.br/api/v1/companies/search?city_id=3525607&per_page=100&sort=id&page=1');assert.equal(f.requests[0].options.headers.Authorization,undefined);assert.equal(f.requests[0].options.family,4);assert.equal(f.requests[0].options.rejectUnauthorized,undefined);
});
test('bridge only accepts bounded documented operations, never arbitrary URLs or extra personal input',async()=>{
  for(const body of [null,[],{operation:'url',url:'https://example.com'},{operation:'companies_search',city_id:'../x',page:1},{operation:'companies_search',city_id:'3525607',page:0},{operation:'companies_search',city_id:'3525607',page:1,url:'https://example.com'},{operation:'companies_search',city_id:'3525607',page:1,name:'Person'},{operation:'company_detail',basic_cnpj:'07916090000104'},{operation:'company_detail',basic_cnpj:'07916090',timeout_ms:999},{operation:'company_detail',basic_cnpj:'07916090',timeout_ms:15001},{operation:'company_detail',basic_cnpj:'07916090',timeout_ms:'1000'},{operation:'company_detail',basic_cnpj:'x'.repeat(3000)}]){const f=fixture();assert.equal((await f.call(body)).status,400);assert.equal(f.requests.length,0)}
});
test('bridge returns original company contract with no writes or evidence assertion',async()=>{
  const payload={data:{corporate_name:'Fixture',partners:[],establishments:[]}};const f=fixture({upstream:()=>Response.json(payload)});const response=await f.call({operation:'company_detail',basic_cnpj:'07916090',timeout_ms:1000});assert.equal(response.status,200);assert.deepEqual(await response.json(),payload);assert.equal(f.requests[0].url,'https://app.baseempresarial.com.br/api/v1/companies/07916090');assert.equal(f.reads.length,2);
});
test('bridge supports registry alphanumeric roots without accepting paths or lowercase input',async()=>{
  const f=fixture({upstream:()=>Response.json({data:{corporate_name:'Fixture'}})});assert.equal((await f.call({operation:'company_detail',basic_cnpj:'AB12CD34'})).status,200);assert.equal(f.requests[0].url,'https://app.baseempresarial.com.br/api/v1/companies/AB12CD34');
  for(const basic_cnpj of ['ab12cd34','../12345','AB12CD3/']){const invalid=fixture();assert.equal((await invalid.call({operation:'company_detail',basic_cnpj})).status,400);assert.equal(invalid.requests.length,0)}
});
test('upstream blocked, missing and throttled responses stay errors, with safe Retry-After preserved',async()=>{
  for(const status of [403,404,429,503]){const f=fixture({upstream:()=>new Response('private source error',{status,headers:{'Retry-After':'60'}})});const response=await f.call();assert.equal(response.status,status);assert.equal(response.headers.get('retry-after'),'60');assert.deepEqual(await response.json(),{ok:false,error:`SOURCE_HTTP_${status}`})}
});
test('source redirects are not followed to another destination',async()=>{
  const f=fixture({upstream:()=>new Response(null,{status:302,headers:{Location:'https://elsewhere.test'}})});const response=await f.call();assert.equal(response.status,502);assert.equal(f.requests.length,1);assert.equal((await response.json()).error,'SOURCE_HTTP_302');
});
test('malformed or oversized source never becomes a successful empty search',async()=>{
  for(const payload of [new Response('html'),Response.json({error:'upstream'}),Response.json({data:null}),Response.json({data:[],large:'x'.repeat(1024*1024)})]){const f=fixture({upstream:()=>payload});const response=await f.call();assert.equal(response.status,502);assert.equal((await response.json()).ok,false)}
});
test('transport timeouts and network failures expose safe errors without raw exceptions',async()=>{
  for(const [name,status,error] of [['TimeoutError',504,'SOURCE_TIMEOUT'],['AbortError',504,'SOURCE_TIMEOUT'],['TypeError',502,'SOURCE_UNAVAILABLE']]){const f=fixture({upstream:()=>{const e=new Error('secret detail');e.name=name;throw e}});const response=await f.call();assert.equal(response.status,status);assert.deepEqual(await response.json(),{ok:false,error})}
});
