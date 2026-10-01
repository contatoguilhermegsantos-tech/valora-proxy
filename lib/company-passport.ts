type Row = Record<string, any>
export type PassportItem = {id:string; label:string; value:string; evidenceIds:string[]; date?:string; provisional?:boolean}
export type PassportSection = {key:string; title:string; items:PassportItem[]; gap:string}
export function buildCompanyPassport(d:Row, company:Row) {
 const evidence:Row[]=(d.evidence||[]).filter((e:Row)=>e.verification_status==='VERIFIED')
 const byId=new Map(evidence.map(e=>[e.id,e]))
 const refs=(row:Row,key:string):string[]=>[...new Set<string>((row[key]||[]).filter((r:Row)=>(!r.support_type||r.support_type==='SUPPORTS')&&byId.has(r.evidence_id)).map((r:Row)=>r.evidence_id))]
 const contradicted=(r:Row,key:string)=>(r[key]||[]).some((x:Row)=>x.support_type==='CONTRADICTS'&&byId.has(x.evidence_id))
 const facts:Row[]=(d.claims||[]).filter((c:Row)=>c.company_id===company.id&&c.classification==='FACT'&&c.status==='VERIFIED'&&refs(c,'claim_evidence').length&&!contradicted(c,'claim_evidence'))
 const labels:Record<string,string>={legal_name:'Razão social',registration_status:'Situação cadastral',opening_date:'Início das atividades',legal_nature:'Natureza jurídica',headquarters_branch:'Matriz / filial',location:'Localidade',cnae:'Atividade principal',cnae_code:'Código CNAE principal',secondary_activities:'Atividades secundárias',company_size:'Porte cadastral',registered_capital:'Capital social declarado',revenue:'Receita documentada',net_income:'Resultado líquido documentado',cash_balance:'Caixa documentado',debt_balance:'Dívida documentada'}
 const factItems=(predicates:string[])=>facts.filter(c=>predicates.includes(c.predicate)).map(c=>({id:c.id,label:labels[c.predicate]||c.predicate,value:String(c.value_text??'Não informado'),date:c.valid_from||undefined,evidenceIds:refs(c,'claim_evidence')}))
 const relations:Row[]=(d.relationships||[]).filter((r:Row)=>r.from_entity_type==='COMPANY'&&r.from_entity_id===company.id&&['VERIFIED','SUPPORTED'].includes(r.status)&&refs(r,'relationship_evidence').length&&!contradicted(r,'relationship_evidence'))
 const relationItems=(types:string[])=>relations.filter(r=>types.includes(r.relationship_type)).map(r=>({id:r.id,label:r.relationship_type==='ADMINISTRADOR'?'Administrador registrado':r.relationship_type==='SOCIO'?'Sócio registrado':'Relação documentada',value:String(r.to_label),provisional:r.status!=='VERIFIED',evidenceIds:refs(r,'relationship_evidence')}))
 const events:Row[]=(d.events||[]).filter((e:Row)=>e.company_id===company.id&&e.status==='VERIFIED'&&refs(e,'event_evidence').length&&!contradicted(e,'event_evidence'))
 const eventItems=(rows:Row[])=>rows.map(e=>({id:e.id,label:e.title,value:e.description||'Publicação documentada; conteúdo econômico exige validação.',date:e.event_date||undefined,evidenceIds:refs(e,'event_evidence')}))
 const sections:PassportSection[]=[
  {key:'identity',title:'Cadastro jurídico',items:factItems(['legal_name','registration_status','opening_date','legal_nature','headquarters_branch','location']),gap:'Faltam dados cadastrais sustentados por documentos verificados.'},
  {key:'operation',title:'Atividade e operação',items:factItems(['cnae','cnae_code','secondary_activities','company_size']),gap:'Atividade, escala operacional, clientes e investimentos precisam ser documentados.'},
  {key:'ownership',title:'Estrutura societária',items:relationItems(['SOCIO','ADMINISTRADOR']),gap:'Quadro societário ainda sem relações documentadas. Não inferir grupo, parentesco ou participação.'},
  {key:'decision',title:'Administração e decisão',items:relationItems(['ADMINISTRADOR']),gap:'Sem administrador documentado. O responsável por decisões financeiras deve ser validado com a empresa.'},
  {key:'events',title:'Eventos e publicações',items:eventItems(events),gap:'Nenhum evento verificado no recorte pesquisado; isso não prova ausência de mudanças.'},
  {key:'financial',title:'Documentação financeira',items:[...factItems(['revenue','net_income','cash_balance','debt_balance']),...eventItems(events.filter(e=>e.metadata?.central_balancos_document_id||/BALANCE|FINANCIAL|DEMONSTR/i.test(e.event_type||'')))],gap:'Receita, margem, dívida e liquidez não determinadas. Solicitar demonstrações atuais e validar seu conteúdo.'}
 ]
 const capital=factItems(['registered_capital']);
 const used=new Set([...sections.flatMap(s=>s.items.flatMap(i=>i.evidenceIds)),...capital.flatMap(i=>i.evidenceIds)])
 const sources=evidence.filter(e=>used.has(e.id))
 const dates=sources.map(e=>e.retrieved_at).filter((v:unknown)=>typeof v==='string'&&!Number.isNaN(Date.parse(v))).sort()
 return {company,sections,sources,lastConsulted:dates.at(-1)||null,capital,caution:'Administrador cadastral não comprova poder de decisão financeira. Capital social, contratos e financiamento não determinam patrimônio ou liquidez pessoal.'}
}
