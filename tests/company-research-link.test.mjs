import test from 'node:test';import assert from 'node:assert/strict';import {ensureCompanyResearchLink,persistCompanyIdentitySupport} from '../supabase/functions/_shared/company-research-link.ts';
function fixture({status='PENDING',evidenceStatus='VERIFIED',race=false}={}){let updates=0;const db={from(table){let action='read',payload;const q={};for(const m of ['select','eq','maybeSingle'])q[m]=()=>q;q.update=p=>{action='update';payload=p;return q};q.then=resolve=>Promise.resolve().then(()=>{if(action==='update'){updates++;status=race?'REJECTED':payload.status}return {data:table==='evidence'?{id:'ev',verification_status:evidenceStatus}:{id:'link',status},error:null}}).then(resolve);return q}};return {db,updates:()=>updates}}
const company={id:'lead',kind:'COMPANY',initial_cnpj:'84.429.695/0001-11'};const args=[company,'org','company','84429695000111','ev'];
test('núcleo empresarial com CNPJ exato e documento verificado suporta vínculo pendente para fontes profundas',async()=>{const f=fixture();assert.equal(await ensureCompanyResearchLink(f.db,...args),true);assert.equal(f.updates(),1)});
test('pessoa, outro CNPJ e fonte revisada não recebem atribuição automática',async()=>{for(const c of [{lead:{...company,kind:'PERSON'}},{lead:{...company,initial_cnpj:'89096457000155'}},{evidenceStatus:'FAILED'}]){const f=fixture(c);assert.equal(await ensureCompanyResearchLink(f.db,c.lead||company,...args.slice(1)),false);assert.equal(f.updates(),0)}});
test('vínculo rejeitado ou rejeição concorrente impedem fontes e confirmação prévia permanece intacta',async()=>{const f=fixture({status:'REJECTED'});assert.equal(await ensureCompanyResearchLink(f.db,...args),false);assert.equal(f.updates(),0);const race=fixture({race:true});assert.equal(await ensureCompanyResearchLink(race.db,...args),false);const verified=fixture({status:'VERIFIED'});assert.equal(await ensureCompanyResearchLink(verified.db,...args),true);assert.equal(verified.updates(),0)});

function identityFixture({identityStatus='PENDING',leadKind='COMPANY',writeError=false,readError=false,readbackStatus,foreign=false}={}){
 const row={id:'lead',organization_id:'org',kind:leadKind,identity_status:identityStatus},calls=[];
 let changed=0;
 const db={from(table){
  assert.equal(table,'leads');let operation='read',payload;const equals={},excludes={};const q={};
  q.update=value=>{operation='update';payload=value;return q};q.select=()=>q;q.maybeSingle=()=>q;
  q.eq=(key,value)=>{equals[key]=value;return q};q.neq=(key,value)=>{excludes[key]=value;return q};
  q.then=(resolve,reject)=>Promise.resolve().then(()=>{
   calls.push({operation,equals,excludes});
   if(operation==='update'&&writeError||operation==='read'&&readError)return {data:null,error:{message:'Controlled database failure'}};
   const matches=!foreign&&Object.entries(equals).every(([key,value])=>row[key]===value)&&Object.entries(excludes).every(([key,value])=>row[key]!==value);
   if(operation==='update'){if(matches){Object.assign(row,payload);changed++}return {data:null,error:null}}
   return {data:matches?{...row,identity_status:readbackStatus??row.identity_status}:null,error:null};
  }).then(resolve,reject);return q;
 }};
 return {db,calls,row,changes:()=>changed};
}

test('suporte de identidade só é retornado após escrita e releitura na mesma organização empresarial',async()=>{
 const f=identityFixture();assert.equal(await persistCompanyIdentitySupport(f.db,'lead','org'),'SUPPORTED');assert.equal(f.changes(),1);
 assert.deepEqual(f.calls.map(c=>c.operation),['update','read']);
 for(const call of f.calls)assert.deepEqual(call.equals,{id:'lead',organization_id:'org',kind:'COMPANY'});
 assert.equal(f.calls[0].excludes.identity_status,'VERIFIED');
});

test('falhas de escrita e releitura não reportam suporte de identidade como persistido',async()=>{
 const write=identityFixture({writeError:true});await assert.rejects(persistCompanyIdentitySupport(write.db,'lead','org'),/persist company identity/);assert.equal(write.changes(),0);assert.equal(write.calls.length,1);
 const read=identityFixture({readError:true});await assert.rejects(persistCompanyIdentitySupport(read.db,'lead','org'),/confirm persisted company identity/);
 for(const option of [{readbackStatus:'CAUTION'},{foreign:true},{leadKind:'PERSON'}]){
  const f=identityFixture(option);await assert.rejects(persistCompanyIdentitySupport(f.db,'lead','org'),/support was not persisted/);
  if(option.foreign||option.leadKind==='PERSON')assert.equal(f.changes(),0);
 }
});

test('identidade já verificada permanece intacta e a releitura retorna VERIFIED',async()=>{
 const f=identityFixture({identityStatus:'VERIFIED'});assert.equal(await persistCompanyIdentitySupport(f.db,'lead','org'),'VERIFIED');assert.equal(f.changes(),0);assert.equal(f.row.identity_status,'VERIFIED');
});
