'use client'
import { useCallback,useEffect,useMemo,useState } from 'react'
import { useParams } from 'next/navigation'
import { Shell } from '@/components/Shell'
import { StatusBadge } from '@/components/StatusBadge'
import { RelationshipGraph } from '@/components/RelationshipGraph'
import { EvidenceList } from '@/components/EvidenceList'
import { supabaseBrowser } from '@/lib/supabase'

type Tab='resumo'|'ecossistema'|'timeline'|'sinais'|'pesquisa'|'evidencias'|'pendencias'
const tabs:{key:Tab;label:string}[]=[
 {key:'resumo',label:'Resumo'},{key:'ecossistema',label:'Ecossistema'},{key:'timeline',label:'Linha do tempo'},
 {key:'sinais',label:'Sinais consultivos'},{key:'pesquisa',label:'Pesquisa'},{key:'evidencias',label:'Fontes & evidências'},{key:'pendencias',label:'Pendências'}
]

export default function LeadDossier(){
 const params=useParams<{id:string}>();const leadId=String(params.id)
 const [d,setD]=useState<any>(null);const [jobs,setJobs]=useState<any[]>([]);const [tab,setTab]=useState<Tab>('resumo');const [busy,setBusy]=useState(false);const [msg,setMsg]=useState('')
 const [strategy,setStrategy]=useState('EMPRESARIO');const [cnpj,setCnpj]=useState('')
 const load=useCallback(async()=>{
  const sb=supabaseBrowser();
  const [dossier,queue]=await Promise.all([
   sb.functions.invoke('get-dossier',{body:{lead_id:leadId}}),
   sb.functions.invoke('research-queue',{body:{action:'list',lead_id:leadId,limit:20}})
  ]);
  if(dossier.error)setMsg(dossier.error.message);else setD(dossier.data);
  if(!queue.error)setJobs(queue.data?.jobs||[]);
 },[leadId])
 useEffect(()=>{void load()},[load])
 useEffect(()=>{
  const active=jobs.some((j:any)=>['PENDING','RUNNING','RETRY'].includes(j.status));
  if(!active)return;
  const timer=setInterval(()=>{void load()},2500);
  return()=>clearInterval(timer);
 },[jobs,load])
 useEffect(()=>{if(!d)return;const seg=String(d.lead?.segment||'').toLowerCase();setStrategy(/agro|rural|fazenda|pecu|agric/.test(seg)?'AGRO':/medic|saude|saúde|clinic|hospital/.test(seg)?'MEDICO':d.lead?.kind==='COMPANY'?'EMPRESARIO':'GENERICO');setCnpj(d.lead?.initial_cnpj||'')},[d])
 const evidenceMap=useMemo(()=>new Map((d?.evidence||[]).map((e:any)=>[e.id,e])),[d])
 if(!d)return <Shell><div className="page-loading">{msg||'Carregando dossiê…'}</div></Shell>

 const lead=d.lead;const claims=d.claims||[];const evidence=d.evidence||[];const events=d.events||[];const rels=d.relationships||[];const signals=d.signals||[];const runs=d.research_runs||[];const questions=d.questions||[];const candidates=(d.candidates||[]).filter((x:any)=>x.candidate_type==='RFB_QSA_NAME_MATCH'&&x.validation_status!=='REJECTED');const divergences=(d.divergences||[]).filter((x:any)=>x.status==='OPEN')
 const facts=claims.filter((c:any)=>c.classification==='FACT'&&c.status==='VERIFIED')
 const identityAssessments=d.identity_assessments||[];const topIdentity=[...identityAssessments].sort((a:any,b:any)=>Number(b.score||0)-Number(a.score||0))[0]||null
 const coverage=d.coverage||{};const sourceCoverage=d.source_coverage||{}

 async function startResearch(){
  setBusy(true);setMsg('');
  const {data,error}=await supabaseBrowser().functions.invoke('research-queue',{body:{action:'enqueue',lead_id:leadId,strategy,cnpj:cnpj.replace(/\D/g,'')||undefined}});
  setMsg(error?error.message:(data?.existing?.length?'Já existe uma investigação ativa para este lead.':'Investigação iniciada em segundo plano. Você pode continuar usando o MAX enquanto as fontes são consultadas.'));
  await load();setBusy(false);setTab('pesquisa');
 }
 async function confirmCandidate(id:string){
  setBusy(true);setMsg('');
  const candidate=candidates.find((x:any)=>x.id===id);
  const {data,error}=await supabaseBrowser().functions.invoke('confirm-company-candidate',{body:{candidate_id:id}});
  if(error){setMsg(error.message);setBusy(false);return}
  const chosenCnpj=String(data?.cnpj||candidate?.metadata?.full_cnpj||'').replace(/\D/g,'');
  setMsg('Vínculo confirmado. A investigação profunda foi colocada na fila.');
  const run=await supabaseBrowser().functions.invoke('research-queue',{body:{action:'enqueue',lead_id:leadId,strategy,cnpj:chosenCnpj||undefined}});
  if(run.error)setMsg(run.error.message);else setMsg('Candidato confirmado. Pesquisa profunda rodando em segundo plano.');
  await load();setBusy(false);setTab('pesquisa');
 }
 async function resolveIdentity(){setBusy(true);setMsg('');const {data,error}=await supabaseBrowser().functions.invoke('identity-resolution',{body:{lead_id:leadId,run_discovery:true}});setMsg(error?error.message:(data?.ambiguity?'Resolução executada: há candidatos muito próximos e o MAX manteve cautela.':`Resolução executada: identidade ${data?.lead_status||'PENDING'}.`));await load();setBusy(false);setTab('resumo')}
 async function derive(){setBusy(true);const {error}=await supabaseBrowser().functions.invoke('derive-signals',{body:{lead_id:leadId}});if(error)setMsg(error.message);await load();setBusy(false);setTab('sinais')}
 async function reviewEvidence(id:string,status:string){const note=window.prompt('Justificativa da revisão:');if(!note)return;setBusy(true);const {error}=await supabaseBrowser().functions.invoke('review-evidence',{body:{evidence_id:id,status,note}});if(error)setMsg(error.message);else setMsg('Evidência revisada e dependências reavaliadas.');await load();setBusy(false)}
 async function rejectClaim(id:string){const reason=window.prompt('Motivo da rejeição:','Dado incorreto, desatualizado ou não correspondente ao lead.');if(!reason)return;setBusy(true);const {error}=await supabaseBrowser().functions.invoke('review-claim',{body:{claim_id:id,action:'REJECT',reason}});if(error)setMsg(error.message);await load();setBusy(false)}
 async function resolveDiv(id:string,action:string){const note=window.prompt('Explique a resolução da divergência:');if(!note)return;setBusy(true);const {error}=await supabaseBrowser().functions.invoke('resolve-divergence',{body:{divergence_id:id,action,note}});if(error)setMsg(error.message);else setMsg('Divergência resolvida com auditoria.');await load();setBusy(false)}

 return <Shell>
  <div className="top"><div><div className="h1">{lead.name}</div><div className="sub">{[lead.city,lead.state].filter(Boolean).join('/')||'Local não informado'} · {lead.segment||'Segmento a validar'} · <StatusBadge value={lead.identity_status}/></div></div><div className="actions">{lead.kind==='PERSON'&&<button className="btn secondary" disabled={busy} onClick={resolveIdentity}>Reavaliar identidade</button>}<button className="btn secondary" disabled={busy} onClick={derive}>Recalcular sinais</button><button className="btn" onClick={()=>setTab('pesquisa')}>Nova pesquisa</button></div></div>
  {msg&&<div className="banner section">{msg}</div>}
  <div className="grid section"><Metric label="Evidence Coverage" value={coverage.factual_coverage_pct==null?'—':coverage.factual_coverage_pct+'%'} note="Fatos verificados / fatos totais"/><Metric label="Source Coverage" value={sourceCoverage.successful_pct==null?'—':sourceCoverage.successful_pct+'%'} note={sourceCoverage.relevant_count?`${sourceCoverage.successful_count||0}/${sourceCoverage.relevant_count} fontes consultadas com resultado`:'Execute uma pesquisa para medir'}/><Metric label="Fatos verificados" value={facts.length} note={`${coverage.factual_claims_pending||0} pendente(s)`}/><Metric label="Divergências" value={divergences.length} note="Nunca resolvidas silenciosamente"/></div>
  <div className="tabs section">{tabs.map(t=><button key={t.key} className={tab===t.key?'active':''} onClick={()=>setTab(t.key)}>{t.label}</button>)}</div>

  {tab==='resumo'&&<div className="two"><div className="stack">{candidates.length>0&&<div className="card"><h3>Empresas candidatas encontradas pelo nome</h3><div className="caution">Coincidência de nome é uma pista, não confirmação de identidade. Confirme apenas a empresa que realmente pertence ao lead.</div><CandidateList rows={candidates} busy={busy} onConfirm={confirmCandidate}/></div>}<div className="card"><h3>Resumo factual</h3>{facts.length?facts.slice(0,20).map((c:any)=><div className="research-step" key={c.id}><div className="step-num">✓</div><div><strong>{c.subject_label}</strong><div>{pretty(c.predicate)}: {value(c)}</div><EvidenceRefs ids={(c.claim_evidence||[]).map((x:any)=>x.evidence_id)} map={evidenceMap}/></div><StatusBadge value={c.status}/></div>):<div className="empty">Ainda não há fatos verificados suficientes.</div>}</div></div><div className="stack"><div className="card"><h3>Resolução de identidade</h3><div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}}><div><strong>{lead.identity_status}</strong><div className="micro">{lead.identity_confirmed_by_user?'Confirmação explícita do usuário':'Resolução algorítmica; não equivale a confirmação humana'}</div></div><StatusBadge value={lead.identity_status}/></div>{topIdentity?<div className="section"><div className="metric-sm">{topIdentity.score}/100</div><div className="muted">{topIdentity.explanation||'Avaliação contextual de identidade.'}</div><div className="micro">Engine {topIdentity.engine_version} · {topIdentity.decision}</div></div>:<div className="empty">A resolução ainda não foi executada.</div>}<div className="caution" style={{marginTop:10}}>SUPPORTED significa suporte contextual. VERIFIED só é usado quando há confirmação explícita do vínculo ou fluxo equivalente documentado.</div></div><div className="card"><h3>Questões investigativas</h3>{questions.length?questions.filter((q:any)=>q.status==='OPEN').slice(0,12).map((q:any)=><div className="question" key={q.id}>{q.question}</div>):<div className="empty">Nenhuma questão aberta.</div>}</div><div className="card"><h3>Princípio de uso</h3><div className="caution">O MAX separa fato, indício e hipótese. Capital social não é patrimônio; valor de M&A não é liquidez pessoal; contrato público não prova pagamento ou margem.</div></div></div></div>}

  {tab==='ecossistema'&&<div className="stack"><div className="card"><h3>Grafo de relações</h3>{rels.length?<RelationshipGraph leadId={leadId} leadName={lead.name} relationships={rels}/>:<div className="empty">Nenhuma relação mapeada ainda. Rode uma pesquisa com CNPJ quando disponível.</div>}</div><div className="card"><h3>Relações documentadas</h3>{rels.length?rels.map((r:any)=><div className="research-step" key={r.id}><div className="step-num">↔</div><div><strong>{r.from_label} → {r.to_label}</strong><div>{pretty(r.relationship_type)}</div><div className="micro">{r.reason||'Relação registrada com rastreabilidade.'}</div><EvidenceRefs ids={(r.relationship_evidence||[]).map((x:any)=>x.evidence_id)} map={evidenceMap}/></div><StatusBadge value={r.status}/></div>):<div className="empty">Nenhuma relação.</div>}</div></div>}

  {tab==='timeline'&&<div className="card"><h3>Linha do tempo econômica</h3>{events.length?events.map((e:any)=><div className="timeline-item" key={e.id}><div className="timeline-date">{e.event_date||'Sem data'}</div><div><strong>{e.title}</strong><div>{e.description||pretty(e.event_type)}</div><div className="pill-row"><span className="badge neutral">{e.classification}</span><StatusBadge value={e.status}/></div><EvidenceRefs ids={(e.event_evidence||[]).map((x:any)=>x.evidence_id)} map={evidenceMap}/></div></div>):<div className="empty">A timeline será formada conforme as fontes produzirem eventos verificáveis.</div>}</div>}

  {tab==='sinais'&&<div className="stack">{signals.length?signals.map((s:any)=><div className="card signal" key={s.id}><div style={{display:'flex',justifyContent:'space-between',gap:12}}><div><div className="micro">{s.classification} · confiança {s.confidence}</div><h3>{s.title}</h3></div><StatusBadge value={s.status}/></div><p>{s.summary}</p>{s.commercial_theme&&<p><strong>Tema consultivo:</strong> {s.commercial_theme}</p>}{s.discovery_question&&<div className="question"><strong>Pergunta:</strong> {s.discovery_question}</div>}{s.caution&&<div className="caution" style={{marginTop:10}}>{s.caution}</div>}</div>):<div className="empty">Nenhum sinal consultivo sustentado ainda.</div>}</div>}

  {tab==='pesquisa'&&<div className="two"><div className="stack">{jobs.length>0&&<div className="card"><h3>Fila de investigação</h3>{jobs.slice(0,6).map((j:any)=><div className="research-step" key={j.id}><div className="step-num">↻</div><div><strong>{j.strategy} · {j.progress?.stage||j.status}</strong><div className="muted">{j.progress?.message||'Aguardando processamento.'}</div>{j.last_error&&<div className="micro" style={{color:'#b42318'}}>{j.last_error}</div>}<div className="micro">{new Date(j.created_at).toLocaleString('pt-BR')}</div></div><StatusBadge value={j.status}/></div>)}</div>}{runs.length?runs.map((r:any)=><div className="card" key={r.id}><div style={{display:'flex',justifyContent:'space-between'}}><div><strong>{r.strategy}</strong><div className="micro">{new Date(r.created_at).toLocaleString('pt-BR')}</div></div><StatusBadge value={r.status}/></div><div className="section">{(r.research_steps||[]).sort((a:any,b:any)=>a.step_order-b.step_order).map((s:any)=><div className="research-step" key={s.id}><div className="step-num">{s.step_order}</div><div><strong>{s.title}</strong><div className="muted">{s.result_summary||s.error_summary||'Aguardando'}</div>{s.action_url&&<a className="source-link" target="_blank" rel="noreferrer" href={s.action_url}>Abrir fonte ↗</a>}</div><StatusBadge value={s.status}/></div>)}</div></div>):<div className="empty">Nenhuma execução anterior.</div>}</div><div className="stack">{candidates.length>0&&<div className="card"><h3>Candidatos de empresa encontrados</h3><div className="caution">Selecione o vínculo correto para o MAX obter o CNPJ e liberar BNDES, PNCP, CVM e demais fontes.</div><CandidateList rows={candidates} busy={busy} onConfirm={confirmCandidate}/></div>}<div className="card"><h3>Iniciar investigação</h3><div className="form"><label className="label">Estratégia<select className="select" value={strategy} onChange={e=>setStrategy(e.target.value)}><option value="EMPRESARIO">Empresário</option><option value="AGRO">Agro</option><option value="MEDICO">Médico</option><option value="GENERICO">Genérico</option></select></label><label className="label">CNPJ inicial (opcional)<input className="input" value={cnpj} onChange={e=>setCnpj(e.target.value)} placeholder="14 dígitos"/></label><button className="btn" disabled={busy} onClick={startResearch}>{busy?'Enfileirando…':'Iniciar investigação'}</button><p className="muted">A pesquisa roda em segundo plano e o progresso aparece na fila acima. Você pode começar só pelo nome. Se o MAX localizar empresas candidatas no QSA público, ele pedirá a confirmação do vínculo antes de atribuir o CNPJ ao lead.</p></div></div></div></div>}

  {tab==='evidencias'&&<div className="card"><h3>Evidências persistidas</h3><EvidenceList rows={evidence} onReview={reviewEvidence}/></div>}

  {tab==='pendencias'&&<div className="split"><div className="card"><h3>Divergências</h3>{divergences.length?divergences.map((x:any)=><div className="banner bad" key={x.id}><strong>{x.field_key}</strong><div><b>A:</b> {x.value_a||'—'} ↔ <b>B:</b> {x.value_b||'—'}</div><div className="actions" style={{marginTop:8}}><button className="btn secondary" disabled={busy} onClick={()=>resolveDiv(x.id,'KEEP_A')}>Manter A</button><button className="btn secondary" disabled={busy} onClick={()=>resolveDiv(x.id,'KEEP_B')}>Manter B</button><button className="btn secondary" disabled={busy} onClick={()=>resolveDiv(x.id,'NOTE_ONLY')}>Resolver com nota</button></div></div>):<div className="empty">Sem divergências abertas.</div>}</div><div className="card"><h3>Claims pendentes</h3>{claims.filter((c:any)=>c.status!=='VERIFIED').slice(0,30).map((c:any)=><div className="banner" key={c.id}><div style={{display:'flex',justifyContent:'space-between'}}><strong>{c.subject_label}</strong><StatusBadge value={c.status}/></div><div>{pretty(c.predicate)}: {value(c)}</div>{c.status!=='REJECTED'&&<button className="link-btn" style={{color:'#b42318',marginTop:8}} onClick={()=>rejectClaim(c.id)}>Rejeitar / marcar incorreto</button>}</div>)}</div></div>}
 </Shell>
}

function Metric({label,value,note}:{label:string;value:string|number;note:string}){return <div className="card"><div className="muted">{label}</div><div className="metric-sm">{value}</div><div className="micro">{note}</div></div>}
function pretty(v:string){return String(v||'').replace(/_/g,' ').replace(/\b\w/g,m=>m.toUpperCase())}
function value(c:any){return c.value_text|| (c.value_json?JSON.stringify(c.value_json):'—')}
function EvidenceRefs({ids,map}:{ids:string[];map:Map<any,any>}){const rows=(ids||[]).map(id=>map.get(id)).filter(Boolean);if(!rows.length)return <div className="micro">Sem evidência vinculada</div>;return <details style={{marginTop:6}}><summary className="source-link" style={{cursor:'pointer'}}>Por que o MAX está dizendo isso? ({rows.length})</summary><div className="stack" style={{marginTop:7}}>{rows.map((e:any)=><div className="banner" key={e.id}><strong>{e.title}</strong><div className="micro">{e.source_label} · {e.verification_status}</div><div>{e.excerpt||'Sem trecho.'}</div>{e.source_url&&<a className="source-link" href={e.source_url} target="_blank" rel="noreferrer">Abrir fonte ↗</a>}</div>)}</div></details>}


function CandidateList({rows,busy,onConfirm}:{rows:any[];busy:boolean;onConfirm:(id:string)=>void}){
 return <div className="stack" style={{marginTop:12}}>{rows.map((c:any)=>{
  const m=c.metadata||{};
  return <div className="banner" key={c.id}>
   <div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'flex-start'}}>
    <div><strong>{m.company_name||c.label}</strong><div className="micro">{m.full_cnpj||m.basic_cnpj||'CNPJ a validar'} · {[m.city,m.state].filter(Boolean).join('/')||'local não informado'}</div></div>
    <StatusBadge value={c.validation_status}/>
   </div>
   <div style={{marginTop:8}}><b>Nome no QSA:</b> {m.partner_name||'—'}{m.partner_role?<> · {m.partner_role}</>:null}</div>
   {m.partnership_start_date&&<div className="micro">Entrada na sociedade: {m.partnership_start_date}</div>}
   {m.registration_status&&<div className="micro">Situação da empresa: {m.registration_status}</div>}
   {m.age_group&&<div className="micro">Faixa etária cadastral: {m.age_group}</div>}
   <div className="micro" style={{marginTop:6}}>Confiança inicial: {c.confidence}. {c.candidate_reason}</div>{m.identity_engine&&<div className="banner" style={{marginTop:8}}><strong>Identity score: {m.identity_engine.score}/100</strong><div className="micro">{m.identity_engine.decision}{m.identity_engine.ambiguous?' · AMBIGUIDADE DETECTADA':''} · {m.identity_engine.engine_version}</div></div>}
   {c.validation_status!=='CONFIRMED'&&<button className="btn secondary" style={{marginTop:10}} disabled={busy} onClick={()=>onConfirm(c.id)}>Confirmar este vínculo e investigar</button>}
   {c.validation_status==='CONFIRMED'&&<div className="badge ok" style={{marginTop:10}}>Vínculo confirmado pelo usuário</div>}
  </div>
 })}</div>
}
