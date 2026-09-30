type Row = Record<string, any>;
export type BriefTopic = {title:string; basis:string; relevance:string; question:string; caution:string; evidenceIds:string[]};
export function buildCommercialBrief(d:Row) {
 const evidence:Row[]=d.evidence||[];
 const usable=new Set(evidence.filter(e=>e.verification_status==='VERIFIED').map(e=>e.id));
 const refs=(row:Row,key:string):string[]=>[...new Set<string>((row[key]||[]).filter((x:Row)=>!x.support_type||x.support_type==='SUPPORTS').map((x:Row)=>x.evidence_id).filter((id:string)=>usable.has(id)))];
 const facts:Row[]=(d.claims||[]).filter((c:Row)=>c.status==='VERIFIED'&&c.classification==='FACT'&&refs(c,'claim_evidence').length);
 const events:Row[]=(d.events||[]).filter((e:Row)=>e.status==='VERIFIED'&&refs(e,'event_evidence').length);
 const rels:Row[]=(d.relationships||[]).filter((r:Row)=>r.status==='VERIFIED'&&refs(r,'relationship_evidence').length);
 const linked:Row[]=(d.companies||[]).filter((c:Row)=>c.link_status!=='REJECTED');
 const rejected=new Set((d.companies||[]).filter((c:Row)=>c.link_status==='REJECTED').map((c:Row)=>c.id));
 const companies=[...new Map<string,Row>([...(d.extra_companies||[]).filter((c:Row)=>!rejected.has(c.id)),...linked].map((c:Row)=>[c.id,c] as [string,Row])).values()];
 const topics:BriefTopic[]=[];
 const combine=(rows:Row[],key:string)=>[...new Set(rows.flatMap(r=>refs(r,key)))];
 for(const company of companies){
  const companyFacts=facts.filter(f=>f.company_id===company.id);
  const activity=companyFacts.find(c=>c.predicate==='cnae');
  if(activity)topics.push({title:`Operação · ${company.legal_name||company.trade_name}`,basis:`Atividade cadastrada: ${activity.value_text}.`,relevance:'A atividade orienta a descoberta do ciclo operacional, dos recebimentos e dos investimentos previstos.',question:'Como funciona o ciclo entre prestar o serviço ou vender, receber e pagar fornecedores? Há expansão ou investimento planejado?',caution:'Tema de descoberta, sem afirmar necessidade de crédito, faturamento ou caixa disponível.',evidenceIds:refs(activity,'claim_evidence')});
  const partners=rels.filter(r=>r.from_entity_type==='COMPANY'&&r.from_entity_id===company.id&&['SOCIO','ADMINISTRADOR'].includes(r.relationship_type));
  const people=[...new Set(partners.map(p=>p.to_entity_id||p.to_label))];
  if(people.length>=2)topics.push({title:`Governança · ${company.legal_name||company.trade_name}`,basis:`${people.length} pessoas constam como sócios ou administradores no quadro consultado.`,relevance:'Uma estrutura com vários participantes torna relevante entender quem decide sobre caixa, investimentos e continuidade.',question:'Quem participa das decisões financeiras e como estão definidos os poderes, a distribuição de resultados e a continuidade da gestão?',caution:'O QSA não comprova parentesco, conflito, sucessão em curso ou percentual de participação.',evidenceIds:combine(partners,'relationship_evidence')});
 }
 const validClaims=new Set(facts.map(c=>c.id)),validEvents=new Set(events.map(e=>e.id));
 for(const signal of d.signals||[]){
  const ids:string[]=signal.evidence_ids||[];
  if(signal.status!=='ACTIVE'||!ids.length||!ids.every(id=>usable.has(id))||!(signal.claim_ids||[]).every((id:string)=>validClaims.has(id))||!(signal.event_ids||[]).every((id:string)=>validEvents.has(id)))continue;
  topics.push({title:signal.title,basis:signal.summary,relevance:signal.commercial_theme||'Validar o contexto do evento.',question:signal.discovery_question||'O que mudou desde o evento documentado?',caution:signal.caution||'Validar o contexto atual antes de propor uma solução.',evidenceIds:ids});
 }
 const docs=events.filter(e=>e.metadata?.central_balancos_document_id||e.metadata?.category);
 if(docs.length)topics.push({title:'Documentos empresariais para aprofundar',basis:`${docs.length} publicação(ões) documentada(s) na linha do tempo.`,relevance:'Demonstrações e atos podem esclarecer resultados, estrutura de capital e mudanças societárias após leitura do conteúdo.',question:'Qual demonstração mais recente e quais atos ajudam a entender a situação atual da empresa?',caution:'A presença no índice comprova a publicação; valores, lucro ou liquidez exigem leitura e validação do documento.',evidenceIds:combine(docs,'event_evidence')});
 const latest=[...(d.research_runs||[])].sort((a:Row,b:Row)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
 const gaps:Row[]=(latest?.research_steps||[]).filter((s:Row)=>['BLOCKED','FAILED','PARTIAL','PENDING','RUNNING'].includes(s.status)&&s.source_key).map((s:Row)=>({title:s.title,status:s.status,reason:s.result_summary||s.error_summary||'Consulta ainda não concluída.',url:s.action_url}));
 return {facts,events,companies,topics,gaps,hasResearch:Boolean(latest),evidence,financialWarning:'Receita, margem, saldo devedor e liquidez atual precisam de documentação específica. Ausência nas fontes consultadas não demonstra ausência de atividade.'};
}
