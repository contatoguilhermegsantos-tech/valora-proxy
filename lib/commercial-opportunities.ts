import {buildCompanyPassport} from './company-passport'
type Row=Record<string,any>
export type CommercialOpportunity={id:string;company:string;theme:string;stage:string;basis:string;question:string;validation:string;limit:string;evidenceIds:string[]}
export function buildCommercialOpportunities(d:Row):CommercialOpportunity[]{
 const rejected=new Set((d.companies||[]).filter((c:Row)=>c.link_status==='REJECTED').map((c:Row)=>c.id))
 const companies=[...new Map<string,Row>([...(d.extra_companies||[]),...(d.companies||[])].filter((c:Row)=>!rejected.has(c.id)).map((c:Row)=>[c.id,c] as [string,Row])).values()]
 const usable=new Set((d.evidence||[]).filter((e:Row)=>e.verification_status==='VERIFIED').map((e:Row)=>e.id))
 const supported=(r:Row,k:string)=>r.status==='VERIFIED'&&r.classification==='FACT'&&(r[k]||[]).some((x:Row)=>(!x.support_type||x.support_type==='SUPPORTS')&&usable.has(x.evidence_id))&&!(r[k]||[]).some((x:Row)=>x.support_type==='CONTRADICTS'&&usable.has(x.evidence_id))
 const refs=(r:Row,k:string):string[]=>[...new Set<string>((r[k]||[]).filter((x:Row)=>(!x.support_type||x.support_type==='SUPPORTS')&&usable.has(x.evidence_id)).map((x:Row)=>x.evidence_id))]
 const out:CommercialOpportunity[]=[]
 for(const c of companies){
  const passport=buildCompanyPassport(d,c),name=c.legal_name||c.trade_name||c.cnpj
  const add=(theme:string,basis:string,question:string,validation:string,limit:string,ids:string[])=>{if(ids.length)out.push({id:`${c.id}:${theme}`,company:name,theme,stage:'Hipótese para descoberta',basis,question,validation,limit,evidenceIds:[...new Set(ids)]})}
  const operation=passport.sections.find(s=>s.key==='operation')?.items||[]
  const primary=operation.find(i=>i.label==='Atividade principal'),secondary=operation.find(i=>i.label==='Atividades secundárias')
  const activity=primary&&!primary.value.includes('descrição indisponível')?primary:secondary||primary
  const activityBasis=activity?.label==='Atividades secundárias'?'Atividades secundárias cadastradas':'Atividade principal cadastrada'
  if(activity){
   const sector=/hospital|saúde|saude|médic|medic|clínic|clinic/i.test(activity.value)?'Qual é o prazo de recebimento de convênios e atendimentos e como ele se compara ao pagamento da equipe e de insumos?':/agric|pecu|rural|cultivo/i.test(activity.value)?'Como o calendário de safra, os estoques e os recebimentos afetam os pagamentos ao longo do ano?':'Como os prazos de clientes, estoques e fornecedores se combinam no ciclo operacional?'
   add('Crédito e ciclo de caixa',`${activityBasis}: ${activity.value}.`,sector,'Confirmar ciclo atual, receitas, recebíveis, obrigações, garantias e interesse da empresa.','Atividade cadastral orienta a pergunta; não demonstra falta de caixa nem elegibilidade para crédito.',activity.evidenceIds)
   add('Investimento e expansão',`${activityBasis}: ${activity.value}.`,'Existe investimento aprovado em equipamentos, capacidade ou expansão? Qual prazo, orçamento e fonte de recursos?','Confirmar projeto, orçamento, cronograma, retorno esperado e capacidade de pagamento.','CNAE e porte não demonstram projeto em curso ou capacidade de investimento.',activity.evidenceIds)
  }
  const ownership=passport.sections.find(s=>s.key==='ownership')?.items||[]
  const financial=passport.sections.find(s=>s.key==='financial')?.items||[]
  const statementValues=financial.filter(i=>['Receita documentada','Resultado líquido documentado','Caixa documentado'].includes(i.label))
  if(statementValues.length)add('Planejamento financeiro documentado',statementValues.map(i=>`${i.label}: ${i.value}`).join(' '),'Como os resultados do exercício documentado se comparam à posição atual, ao orçamento e aos investimentos previstos?','Confirmar demonstrações atuais e individuais, contas a receber, dívida detalhada e necessidades declaradas pela empresa.','Valores consolidados históricos incluem controladas; não comprovam caixa disponível hoje, distribuição aos sócios ou patrimônio pessoal.',statementValues.flatMap(i=>i.evidenceIds))
  const participants=new Set(ownership.map(i=>i.value.trim().toUpperCase()))
  if(participants.size>=2){const ids=ownership.flatMap(i=>i.evidenceIds)
   add('Governança e decisão',`${ownership.length} vínculos de sócios ou administradores documentados no quadro consultado.`,'Quem pode deliberar sobre caixa, endividamento, investimentos e distribuição de resultados?','Validar contrato social atual, poderes, quóruns e responsáveis financeiros.','Vínculo no QSA não comprova poder de decisão financeira, participação ou conflito.',ids)
   add('Continuidade e sucessão',`O quadro consultado registra vários participantes da sociedade ou administração.`,'Há um plano acordado para continuidade da gestão, saída de participantes e transferência de poderes?','Validar interesse dos participantes e documentos de governança; assessoria especializada se o tema for pertinente.','Pergunta exploratória: não presume parentesco, idade, falecimento, conflito ou sucessão em curso.',ids)
  }
  const contracts=(d.events||[]).filter((e:Row)=>e.company_id===c.id&&/CONTRACT/i.test(e.event_type||'')&&supported(e,'event_evidence'))
  if(contracts.length)add('Execução de contratos',`${contracts.length} contrato(s) publicado(s), com datas na linha do tempo.`,'Esses contratos ainda estão em execução? Qual o cronograma de entrega, faturamento e recebimento?','Validar vigência, execução, aditivos, recebíveis atuais e eventuais obrigações.','Valor contratado não é receita recebida, lucro, liquidez ou garantia de novos negócios.',contracts.flatMap((e:Row)=>refs(e,'event_evidence')))
  const financing=(d.events||[]).filter((e:Row)=>e.company_id===c.id&&/FINANCING/i.test(e.event_type||'')&&supported(e,'event_evidence'))
  if(financing.length)add('Estrutura de financiamento',`${financing.length} operação(ões) de financiamento publicada(s), com datas na linha do tempo.`,'Qual foi a finalidade da operação e qual é a situação atual do projeto e das obrigações?','Validar projeto, saldo atual, prazo, garantias e demais dívidas com documentação atual.','Operação histórica não informa saldo devedor atual, caixa ou necessidade de refinanciamento.',financing.flatMap((e:Row)=>refs(e,'event_evidence')))
 }
 return out
}
