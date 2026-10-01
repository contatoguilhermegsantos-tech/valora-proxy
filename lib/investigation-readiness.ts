import {buildCompanyPassport} from './company-passport';
type Row=Record<string,any>;
export function buildInvestigationReadiness(d:Row) {
 const companies:Row[]=(d.companies||[]).filter((c:Row)=>['SUPPORTED','VERIFIED'].includes(c.link_status));
 const passports=companies.map((c:Row)=>buildCompanyPassport(d,c));
 const fields=[
  {key:'identity',title:'Cadastro jurídico',question:'Quem é a entidade jurídica?',next:'Comprovar cadastro do CNPJ exato; marca e grupo não substituem a entidade jurídica.'},
  {key:'operation',title:'Atividade e operação',question:'O que a empresa faz e qual sua escala?',next:'Validar unidades, operação atual, clientes e expansão. CNAE e porte são apenas dados cadastrais.'},
  {key:'ownership',title:'Sócios e administradores',question:'Quem participa da sociedade?',next:'Revisar QSA e atos; participações percentuais e controle final exigem documentos específicos.'},
  {key:'decision',title:'Poderes de decisão',question:'Quem pode decidir financeiramente?',next:'Obter contrato social e poderes atuais; administrador cadastral não comprova poder financeiro.'},
  {key:'events',title:'Eventos econômicos',question:'O que aconteceu e em qual estágio?',next:'Buscar publicações, atos e documentos que comprovem evento e estágio; ausência de resultado é inconclusiva.'},
  {key:'financial',title:'Situação financeira',question:'Quais receitas, resultados, caixa e dívida são documentados?',next:'Obter demonstrações atuais e validar valores e período. Capital social não representa caixa.'}
 ];
 const companyIds=new Set(companies.map((c:Row)=>c.id));
 const conflictKeys=new Set((d.claims||[]).filter((c:Row)=>companyIds.has(c.company_id)&&c.status==='CONTRADICTED').map((c:Row)=>c.predicate));
 const predicates:Record<string,string[]>={identity:['legal_name','registration_status','opening_date','location','legal_nature'],operation:['cnae','cnae_code','secondary_activities','company_size'],ownership:[],decision:[],events:[],financial:['revenue','net_income','cash_balance','debt_balance']};
 const dimensions=fields.map(f=>{
  const items=passports.flatMap(p=>(p.sections.find(s=>s.key===f.key)?.items||[]).map(i=>({...i,companyName:p.company.legal_name||p.company.cnpj||'Empresa'})));
  const evidenceIds=[...new Set(items.flatMap(i=>i.evidenceIds))];
  // Published documents and cadastral roles supply context, not validated financial values or powers.
  const sufficient=f.key==='identity'?passports.length>0&&passports.every(p=>['legal_name','registration_status','location'].every(pred=>(d.claims||[]).some((c:Row)=>c.company_id===p.company.id&&c.predicate===pred&&c.classification==='FACT'&&c.status==='VERIFIED'&&items.some(i=>i.id===c.id)))):false;
  const relationConflict=['ownership','decision'].includes(f.key)&&(d.relationships||[]).some((r:Row)=>r.from_entity_type==='COMPANY'&&companyIds.has(r.from_entity_id)&&r.status==='CONTRADICTED'&&(f.key==='ownership'||r.relationship_type==='ADMINISTRADOR'));
  const conflict=relationConflict||predicates[f.key].some(p=>conflictKeys.has(p))||(d.divergences||[]).some((x:Row)=>x.status==='OPEN'&&companyIds.has(x.company_id)&&predicates[f.key].includes(x.field_key));
  return {...f,state:conflict?'CONFLICTING':sufficient?'DOCUMENTED':items.length?'PARTIAL':'UNKNOWN',itemCount:items.length,evidenceIds,items};
 });
 const run=(d.research_runs||[])[0];
 const running=run&&['PENDING','RUNNING'].includes(run.status);
 return {dimensions,companyCount:companies.length,state:running?'RUNNING':dimensions.some(x=>x.state==='CONFLICTING')?'REVIEW_REQUIRED':dimensions.some(x=>x.state!=='DOCUMENTED')?'NEEDS_MORE_EVIDENCE':'DOCUMENTED',latestRun:run||null};
}
