'use client'
import { useEffect,useState } from 'react'
import { SourceBacklog } from '@/components/SourceBacklog'
import { Shell } from '@/components/Shell'
import { AuthGate } from '@/components/AuthGate'
import { StatusBadge } from '@/components/StatusBadge'
import { supabaseBrowser } from '@/lib/supabase'
const healthLabels:Record<string,string>={RESPONDING:'Última consulta respondeu',FAILURE:'Falha na última consulta',CONTEXT_REQUIRED:'Limitação de cobertura ou contexto',INCONCLUSIVE:'Registro antigo inconclusivo'}
const resultLabels:Record<string,string>={TIMEOUT:'Fonte não respondeu dentro do prazo',NETWORK_ERROR:'Falha de conexão com a fonte',INVALID_RESPONSE:'Resposta da fonte não pôde ser validada',HTTP_403:'Fonte recusou a consulta',HTTP_503:'Fonte temporariamente indisponível',CITY_LOOKUP_FAILED:'Falha ao consultar municípios',CITY_NOT_COVERED:'Cobertura não confirmada pelo conector antigo',CITY_NOT_COVERED_CONFIRMED:'Município fora da cobertura consultada',CITY_REQUIRED:'Informe o município',CITY_AMBIGUOUS:'Informe a UF',NO_SEARCH_TERMS:'Termos insuficientes',QUERY_FAILED:'Pesquisa não concluída',PARTIAL:'Consulta parcial',MENTIONS_FOUND:'Menções encontradas',NO_MENTIONS:'Consulta concluída sem menções'}
const dateTime=(v:string)=>v?new Date(v).toLocaleString('pt-BR'):'—'
Object.assign(resultLabels,{FINANCIAL_FACTS_FOUND:'Valores financeiros documentados',NO_SELECTED_FINANCIAL_FACTS:'Contas selecionadas não localizadas; sem conclusão sobre finanças',REVIEW_REQUIRED:'Documento aguarda revisão'})
export default function Sources(){return <AuthGate><SourcesContent/></AuthGate>}
function SourcesContent(){
 const [data,setData]=useState<any>(null)
 const [error,setError]=useState('')
 const [loading,setLoading]=useState(true)
 const [revision,setRevision]=useState(0)
 useEffect(()=>{
  let cancelled=false
  async function load(){
   setLoading(true);setError('')
   try{
    const result=await supabaseBrowser().functions.invoke('get-source-status',{body:{}})
    if(cancelled)return
    if(result.error)throw result.error
    setData(result.data)
   }catch(e){if(!cancelled)setError(e instanceof Error?e.message:'Não foi possível carregar as fontes.')}
   finally{if(!cancelled)setLoading(false)}
  }
  void load()
  return()=>{cancelled=true}
 },[revision])
 const syncMap=new Map<string,any>((data?.sync||[]).map((s:any)=>[s.source_key,s]))
 const healthMap=new Map<string,any>((data?.health||[]).map((s:any)=>[s.source_id,s]))
 const pncpQueue=(data?.backfill||[]).filter((x:any)=>x.source_key==='pncp')
 const done=pncpQueue.filter((x:any)=>x.status==='DONE').length
 const failed=pncpQueue.filter((x:any)=>x.status==='FAILED').length
 const quality=data?.quality
 const auditUnavailable=quality?.completed===false
 const auditStale=quality&&Date.now()-Date.parse(quality.finished_at)>2*3600000
 return <Shell>
  <div className="top"><div><div className="h1">Fontes</div><div className="sub">Conexão cadastrada, consultas observadas e cobertura disponível.</div></div><button className="btn" disabled={loading} onClick={()=>setRevision(v=>v+1)}>{loading?'Atualizando…':'Atualizar status'}</button></div>
  {error&&<div className="banner bad section" role="alert">{error} {data&&'Os dados abaixo são da última atualização concluída.'}</div>}
  {data&&<div className="banner section">Consultas desta organização nas últimas 48 horas, até 500 registros recentes. Sem registro não significa fonte saudável nem ausência de informações. Atualizar status não inicia novas pesquisas.<div className="micro">Atualizado em {dateTime(data.observation?.checked_at)}{data.observation?.sample_limited?' · Amostra atingiu o limite de 500 consultas.':''}</div></div>}
  {quality&&<div className={auditUnavailable||auditStale||quality.critical_count||quality.warning_count?'banner bad section':'banner section'}>{auditUnavailable?<><strong>Autoauditoria indisponível</strong><div>A consulta não foi concluída; as verificações de confiança ainda não puderam ser avaliadas.</div></>:<><strong>Autoauditoria: {quality.status}</strong> · {quality.critical_count} violação(ões) · {quality.warning_count} alerta(s)</>}<div className="micro">{auditUnavailable?'Última tentativa':'Última execução'}: {dateTime(quality.finished_at)}{auditStale?' · Atenção: sem execução concluída há mais de duas horas.':''}</div></div>}
  {pncpQueue.length>0&&<div className={failed?'banner bad section':'banner section'}><strong>PNCP — recuperação de cobertura:</strong> {done}/{pncpQueue.length} dia(s) concluído(s), {pncpQueue.length-done} restante(s){failed?', '+failed+' com falha':''}. A data de cobertura abaixo só avança após uma consulta completa.</div>}
  <div className="card table-wrap section"><table className="table"><thead><tr><th>Fonte</th><th>Conexão cadastrada</th><th>Consultas da organização</th><th>Sincronização compartilhada</th><th>Limitações / ação</th></tr></thead><tbody>{(data?.sources||[]).map((r:any)=>{
   const s=syncMap.get(r.key),h=healthMap.get(r.id)
   const stale=r.key==='pncp'&&(!s?.last_successful_date||Date.now()-Date.parse(s.last_successful_date+'T23:59:59Z')>48*3600000)
   return <tr key={r.id}>
    <td><strong>{r.name}</strong><div className="micro">{r.domain||r.key} · {r.source_tier}</div></td>
    <td><StatusBadge value={r.connection_status}/></td>
    <td>{h?<><strong>{healthLabels[h.health]||h.health}</strong><div className="micro">{resultLabels[h.latest_result]||h.latest_result} · {dateTime(h.latest_at)}</div><div className="micro">{h.attempts} consulta(s) · {h.failures} falha(s) · média {h.average_ms} ms{h.inconclusive?' · '+h.inconclusive+' registro(s) antigo(s) inconclusivo(s)':''}</div></>:<span className="muted">Sem consulta registrada nesta janela</span>}</td>
    <td>{s?<><strong>{s.last_status==='PARTIAL'?'Atualização parcial':s.last_status==='FAILED'?'Atualização falhou':s.last_status}</strong>{s.last_successful_date&&<div className="micro">Última data concluída: {s.last_successful_date}</div>}<div className="micro">Tentativa: {dateTime(s.last_attempt_at)}</div>{stale&&<div className="micro">Atenção: cobertura desatualizada.</div>}</>:<span className="muted">Sob demanda ou manual</span>}</td>
    <td className="muted">{r.limitations||r.coverage_notes||'—'}{r.action_url&&<div><a className="source-link" href={r.action_url} target="_blank" rel="noreferrer">Abrir fonte oficial ↗</a></div>}</td>
   </tr>
  })}</tbody></table></div>
  <SourceBacklog rows={data?.backlog||[]}/>
 </Shell>
}

