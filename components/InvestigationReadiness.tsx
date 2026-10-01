import {buildInvestigationReadiness} from '@/lib/investigation-readiness';
const stateLabels:Record<string,string>={DOCUMENTED:'Documentado no cadastro',PARTIAL:'Parte documentada',UNKNOWN:'Ainda desconhecido',CONFLICTING:'Há divergência',READY:'Consulta automática disponível',NEEDS_COMPANY:'Depende de empresa/CNPJ',CONFIG_REQUIRED:'Acesso não configurado',MANUAL:'Pesquisa documental/manual',UNAVAILABLE:'Integração indisponível'};
const stepLabels:Record<string,string>={COMPLETED:'Consulta concluída',PARTIAL:'Consulta inconclusiva ou limitada',FAILED:'Falha na consulta',BLOCKED:'Consulta bloqueada',SKIPPED:'Etapa não executada',RUNNING:'Consulta em andamento',PENDING:'Aguardando consulta'};
export function InvestigationReadiness({dossier}:{dossier:any}) {
 const readiness=buildInvestigationReadiness(dossier);
 const routes=dossier.source_routes||[];
 const steps=readiness.latestRun?.research_steps||[];
 return <div className="stack section">
  <section className="card" aria-label="Perguntas da investigação"><h3>O que sabemos e o que falta investigar</h3><p className="muted">Respostas sobre as empresas vinculadas a este núcleo. A pesquisa organiza evidências por pergunta. Consulta concluída não significa investigação completa.</p>
   {!readiness.companyCount&&<div className="caution">Primeiro resolva uma empresa/CNPJ. Empresas candidatas e dados de outros núcleos não preenchem estas respostas.</div>}
   <div className="two">{readiness.dimensions.map(row=><div className="banner" key={row.key}><div className="pill-row"><strong>{row.title}</strong><span className="badge neutral">{stateLabels[row.state]}</span></div><p>{row.question}</p><div className="micro">{row.itemCount} registro(s) com suporte documental · {row.evidenceIds.length} evidência(s)</div>{row.items.length>0&&<details><summary className="source-link">Consultar registros e evidências</summary>{row.items.map(item=><p key={item.id}><strong>{item.companyName} · {item.label}:</strong> {item.value}{item.provisional?' · vínculo ainda indicativo':''}</p>)}{(dossier.evidence||[]).filter((e:any)=>row.evidenceIds.includes(e.id)&&e.verification_status==='VERIFIED').map((e:any)=><div className="micro" key={e.id}>{e.title} · {e.source_label}{e.retrieved_at?' · '+new Date(e.retrieved_at).toLocaleDateString('pt-BR'):''}{e.source_url&&/^https:\/\//.test(e.source_url)&&<div><a className="source-link" href={e.source_url} target="_blank" rel="noreferrer">Abrir documento ↗</a></div>}</div>)}</details>}<p><strong>Próxima validação:</strong> {row.next}</p></div>)}</div>
  </section>
  <section className="card" aria-label="Rotas das fontes"><h3>Onde o MAX busca cada resposta</h3><p className="muted">Disponibilidade de integração e resultado da última pesquisa aparecem separados. Não há garantia de disponibilidade externa.</p>
   {routes.length?<div className="two">{routes.map((route:any)=>{
    const attempted=steps.filter((s:any)=>route.steps.includes(s.step_key));
    return <div className="banner" key={route.key}><strong>{route.question}</strong><div className="pill-row"><span className="badge neutral">{stateLabels[route.state]||route.state}</span></div>
     <div className="micro">{route.providers.map((p:any)=>p.name).join(' → ')}</div>
     {attempted.length?attempted.map((s:any)=><p key={s.id}><strong>{stepLabels[s.status]||s.status}:</strong> {s.result_summary||s.error_summary||'Sem resultado registrado.'}</p>):<p className="muted">Não consultada na última execução.</p>}
     <p><strong>Próximo passo:</strong> {route.next}</p><div className="micro">{route.limit}</div>
     {route.providers.filter((p:any)=>p.action_url&&/^https:\/\//.test(p.action_url)).map((p:any)=><div key={p.key}><a className="source-link" href={p.action_url} target="_blank" rel="noreferrer">Consultar {p.name} ↗</a></div>)}
    </div>
   })}</div>:<p className="muted">Rotas ainda não carregadas. Atualize o dossiê para consultar o plano atual.</p>}
  </section>
 </div>
}
