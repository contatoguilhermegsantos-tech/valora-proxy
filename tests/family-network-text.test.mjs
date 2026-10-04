import test from 'node:test';import assert from 'node:assert/strict';
import {familyNetworkText} from '../supabase/functions/_shared/family-network-text.ts';
test('nomes empresariais removem identificadores pessoais antes de truncar',()=>{
 for(const identifier of ['12345678909','123.456.789-09','123 456 789 09','***123456**','***.123.456-**','***12345**'])assert.equal(familyNetworkText('Empresa '+identifier),'Empresa [identificador removido]');
 assert.equal(familyNetworkText('Empresa 12345678909',12),'Empresa [ide');assert.equal(familyNetworkText(null),'');
});
test('sanitização preserva CNPJ completo, UUID, datas e nomes empresariais sem identificador pessoal',()=>{
 for(const value of ['Empresa 12345678000199','CNPJ 12.345.678/0001-99','company:12345678000199','11111111-1111-4111-8111-11111111111a','11111111-1111-4111-8111-a11111111111','2026-10-03T12:00:00.123Z','Ana Santos Comércio LTDA'])assert.equal(familyNetworkText(value),value);
 assert.equal(familyNetworkText('Empresa 12345678909 e 98765432100'),'Empresa [identificador removido] e [identificador removido]');
});
