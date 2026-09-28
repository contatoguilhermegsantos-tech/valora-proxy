import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessIdentity} from '../supabase/functions/identity-resolution/policy.ts';

const lead={name:'João da Silva',city:'Barretos',state:'SP'};
const candidate=(id,extra={})=>({id,validation_status:'UNVALIDATED',metadata:{partner_name:'JOAO DA SILVA',city:'Barretos',state:'SP',full_cnpj:'12345678000195',...extra}});
test('nome e cidade normalizados sustentam, nunca confirmam automaticamente',()=>{
 const r=assessIdentity(lead,[candidate('a')]);assert.equal(r.top.decision,'SUPPORTED');assert.equal(r.top.score,75);
});
test('homônimos empatados incluem o líder e todos os concorrentes na ambiguidade',()=>{
 const r=assessIdentity(lead,[candidate('a'),candidate('b')]);assert.equal(r.ambiguous,true);assert.deepEqual([...r.ambiguousCandidateIds].sort(),['a','b']);
});
test('empresas no mesmo grupo corroborado não geram falsa competição',()=>{
 const cross={matched:true,group_id:'g',group_size:2};const r=assessIdentity(lead,[candidate('a',{cross_identity_validation:cross}),candidate('b',{cross_identity_validation:cross})]);assert.equal(r.ambiguous,false);
});
test('grupo líder inteiro fica ambíguo quando outro grupo tem mesma pontuação',()=>{
 const r=assessIdentity(lead,[candidate('a',{cross_identity_validation:{matched:true,group_id:'g'}}),candidate('b',{cross_identity_validation:{matched:true,group_id:'g'}}),candidate('c',{cross_identity_validation:{matched:true,group_id:'h'}})]);assert.deepEqual([...r.ambiguousCandidateIds].sort(),['a','b','c']);
});
test('confirmação explícita mantém 100 mesmo sem contexto',()=>{
 const r=assessIdentity({},[{...candidate('a'),validation_status:'CONFIRMED'}]);assert.equal(r.top.decision,'CONFIRMED');assert.equal(r.top.score,100);assert.equal(r.ambiguous,false);
});
test('alteração de cidade não reutiliza flags antigas',()=>{
 const r=assessIdentity({...lead,city:'Campinas'},[candidate('a',{city_match:true,state_match:true,exact_name_match:true})]);assert.equal(r.top.score,40);assert.equal(r.top.decision,'WEAK');
});
test('mesmo estado não equivale à mesma cidade',()=>{
 const r=assessIdentity(lead,[candidate('a',{city:'São Paulo'})]);assert.equal(r.top.score,40);
});
test('nome diferente não recebe pontos de coincidência antiga',()=>{
 const r=assessIdentity(lead,[candidate('a',{partner_name:'José Pereira',exact_name_match:true})]);assert.equal(r.top.score,40);
});
test('ausência de candidatos permanece sem conclusão',()=>{
 const r=assessIdentity(lead,[]);assert.equal(r.top,null);assert.equal(r.ambiguous,false);
});

