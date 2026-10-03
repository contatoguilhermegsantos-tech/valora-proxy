'use client'

import {useRef, useState} from 'react'
import {useRouter} from 'next/navigation'
import {supabaseBrowser} from '@/lib/supabase'

type Row = {
 id: string
 organization_id?: string
 lead_id?: string
 candidate_type?: string
 entity_type?: string
 validation_status?: string
 confidence?: string
 label?: string
 candidate_reason?: string
 created_at?: string
 updated_at?: string
 metadata?: Record<string, any>
}
type Document = {
 id: string
 organization_id?: string
 lead_id?: string
 verification_status?: string
 source_registry_id?: string
 source_url?: string
 source_label?: string
 title?: string
 retrieved_at?: string
}
type Dossier = {
 role?: string
 lead: {id: string; organization_id: string; kind: string; name?: string; city?: string; state?: string; segment?: string}
 candidates?: Row[]
 evidence?: Document[]
 graph_candidate_reviews?: {id: string; candidate_id: string; action: string; reason: string; created_at: string}[]
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const normalized = (value: unknown) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const companyId = (value: unknown) => text(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
function providerCode(value: unknown) {
 const provider = text(value).toUpperCase()
 return provider === 'BASE_EMPRESARIAL' || provider === 'MINHA_RECEITA' ? provider : ''
}
function providerLabel(provider: string) {
 return provider === 'BASE_EMPRESARIAL' ? 'Base Empresarial' : provider === 'MINHA_RECEITA' ? 'Minha Receita — consulta experimental' : ''
}
function documentProvider(document: Document | undefined, metadata: Record<string, any>) {
 const label = normalized(document?.source_label).replace(/\s/g, '')
 if (label.includes('MINHARECEITA')) return 'MINHA_RECEITA'
 if (label.includes('BASEEMPRESARIAL')) return 'BASE_EMPRESARIAL'
 return providerCode(metadata.business_provider || metadata.source_provider || metadata.search_lineage?.business_provider || metadata.search_lineage?.source_provider)
}
function sourceMonth(value: unknown) {
 const month = text(value)
 return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? `${month.slice(5)}/${month.slice(0, 4)}` : ''
}
function sourceUrl(value: unknown) {
 try {
  const url = new URL(text(value))
  return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
 } catch {return null}
}
function dateLabel(value: unknown) {
 const valueText = text(value)
 if (!valueText) return null
 const date = new Date(valueText)
 return Number.isNaN(date.getTime()) ? null : date.toLocaleString('pt-BR', {timeZone: 'America/Sao_Paulo'})
}
function statusLabel(status: string, complete: boolean, pivotRegistered: boolean) {
 if (status === 'BLOCKED') return 'Consulta bloqueada'
 if (status === 'FAILED') return 'Consulta não concluída'
 if (status === 'PARTIAL') return 'Cobertura parcial'
 if (complete) return 'Recorte consultado'
 if (['COMPLETE', 'COMPLETED'].includes(status)) return 'Execução finalizada; cobertura a verificar'
 if (['RUNNING', 'PENDING'].includes(status)) return 'Consulta em andamento'
 return pivotRegistered ? 'Pivô registrado; cobertura ainda não registrada' : 'Consulta ainda não executada'
}
const limits: Record<string, string> = {
 DEADLINE: 'A consulta atingiu o tempo disponível.',
 SCAN_LIMIT_500: 'Foi atingido o limite de 500 estabelecimentos neste recorte.',
 STATE_QUERY_FAILED: 'Não foi possível consultar a UF na fonte.',
 STATE_NOT_RESOLVED: 'A UF ainda não foi resolvida na fonte.',
 CITY_QUERY_FAILED: 'Não foi possível consultar o município na fonte.',
 CITY_NOT_UNIQUELY_RESOLVED: 'O município precisa ser resolvido sem ambiguidade.',
 COMPANY_PAGE_QUERY_FAILED: 'Uma página de empresas não pôde ser consultada.',
 PAGE_CONTINUATION_UNKNOWN: 'A fonte não confirmou se ainda existem páginas de empresas.',
 QSA_QUERY_FAILED: 'Parte dos quadros societários não pôde ser consultada.',
 QSA_COVERAGE_LIMIT: 'Parte dos quadros societários veio com cobertura limitada.',
 INVALID_COMPANY_ROW: 'Alguns cadastros vieram sem os dados necessários para comparar município e atividade.',
 INVALID_QSA_ROW: 'Alguns nomes do quadro societário vieram com dados incompletos.',
 CANDIDATE_COVERAGE_LIMIT_60: 'Esta rodada registra até 60 pistas. O resultado exige um recorte mais específico para ampliar a análise.',
 RATE_LIMIT_RETRY_AFTER: 'A fonte limitou as consultas. Aguarde a janela indicada antes de continuar.',
 MINHA_COMPANY_PAGE_QUERY_FAILED: 'Uma página da consulta experimental Minha Receita não pôde ser consultada.',
 INVALID_QSA_ROWS: 'Alguns cadastros vieram sem um quadro societário utilizável.',
 CURSOR_DID_NOT_ADVANCE: 'A fonte não avançou para uma nova página. A cobertura permanece parcial.',
 SOURCE_PROVIDER_SWITCH_RESTARTED: 'A consulta seguiu por outra fonte cadastral, preservando as pistas anteriores.',
}
async function describeError(error: any, fallback: string) {
 const status = error?.context?.status
 if (status === 401) return 'A sessão expirou. Entre novamente para continuar.'
 if (status === 403) return 'Seu acesso permite consultar este dossiê, mas não executar esta ação.'
 if (status === 404) return 'A pista ou o dossiê não está disponível neste contexto. Atualize a página.'
 if (status === 409) return 'A ação exige revisão da pista, do contexto ou do documento. Atualize o dossiê e confira a evidência.'
 try {
  const detail = await error?.context?.json()
  const message = text(detail?.error)
  // Preserve useful Portuguese source guidance without exposing internal errors.
  if (message && /[ãáàâéêíóôõúç]|Não|Pessoa|sobrenome|município|segmento|parentesco/i.test(message)) return message
 } catch {}
 return fallback
}

export function FamilyDiscovery({dossier, onUpdated}: {dossier: Dossier; onUpdated: () => Promise<void>}) {
 const router = useRouter()
 const actionInProgress = useRef(false)
 const [busy, setBusy] = useState('')
 const [message, setMessage] = useState('')
 const [hasError, setHasError] = useState(false)
 const [openedPath, setOpenedPath] = useState('')

 const lead = dossier.lead
 if (lead.kind !== 'PERSON') return null
 const readOnly = dossier.role === 'VIEWER'
 const ownRows = (dossier.candidates || []).filter(row => row.organization_id === lead.organization_id && row.lead_id === lead.id)
 function isCurrentContext(row: Row) {
  const md = row.metadata || {}, original = md.search_lineage?.original || {}, query = md.query || {}
  const rowCity = md.city || query.city || original.city
  const rowState = md.state || query.state || original.state
  const rowSegment = md.segment || query.segment || original.segment
  const rowName = original.name || md.lead_name
  return normalized(rowCity) === normalized(lead.city) && normalized(rowState) === normalized(lead.state) && normalized(rowSegment) === normalized(lead.segment)
   && (row.candidate_type === 'FAMILY_SEARCH_PIVOT' || Boolean(normalized(rowCity) && normalized(rowState) && normalized(rowSegment)))
   && Boolean(text(rowName)) && normalized(rowName) === normalized(lead.name)
 }
 const allPivots = ownRows.filter(row => row.candidate_type === 'FAMILY_SEARCH_PIVOT')
 const pivots = allPivots.filter(isCurrentContext)
 const pivot = [...pivots].sort((a, b) => text(b.updated_at || b.created_at).localeCompare(text(a.updated_at || a.created_at)))[0]
 const metadata = pivot?.metadata || {}
 const lineage = metadata.search_lineage || {}
 const businessProvider = providerCode(metadata.business_provider || lineage.business_provider || metadata.source_provider || lineage.source_provider)
 const minhaReceita = businessProvider === 'MINHA_RECEITA'
 const businessDataMonth = sourceMonth(metadata.source_data_month || lineage.source_data_month)
 const original = lineage.original || {}
 const query = metadata.query || {}
 const surname = text(metadata.surname || metadata.query_surname || query.surname || lineage.query_surname)
 const city = text(metadata.city || query.city || original.city || lead.city)
 const state = text(metadata.state || query.state || original.state || lead.state)
 const segment = text(metadata.segment || query.segment || original.segment || lead.segment)
 const searchStatus = text(metadata.search_status || metadata.status).toUpperCase()
 const complete = metadata.complete === true
 const continuation = metadata.continuation === true
 const hasActualQuery = Boolean(text(metadata.last_query_at || metadata.last_queried_at || metadata.last_attempt_at || metadata.searched_at)) || ['PARTIAL', 'FAILED', 'COMPLETE', 'COMPLETED', 'BLOCKED'].includes(searchStatus)
 const scannedCount = count(metadata.scanned_count) ?? count(metadata.state?.scanned_cnpjs?.length) ?? 0
 const historicalCandidates = ownRows.filter(row => row.candidate_type === 'FAMILY_CONTEXT_MATCH')
 const allCandidates = historicalCandidates.filter(isCurrentContext)
 const earlierContextCount = historicalCandidates.length - allCandidates.length
 const candidates = allCandidates.filter(row => row.validation_status !== 'REJECTED')
 const rejected = allCandidates.filter(row => row.validation_status === 'REJECTED')
 const allRejected = historicalCandidates.filter(row => row.validation_status === 'REJECTED')
 const candidateIds = new Set(historicalCandidates.map(row => row.id))
 const reviews = (dossier.graph_candidate_reviews || []).filter(review => candidateIds.has(review.candidate_id) && review.action === 'REJECT')
 const evidence = new Map((dossier.evidence || []).filter(document => document.organization_id === lead.organization_id && document.lead_id === lead.id).map(document => [document.id, document]))
 const foundCount = allCandidates.length
 const reportedCount = count(metadata.candidates_found)
 const lastQuery = dateLabel(metadata.last_query_at || metadata.last_queried_at || metadata.last_attempt_at || metadata.searched_at || pivot?.updated_at || pivot?.created_at)
 const noteCodes = Array.isArray(metadata.notes) ? metadata.notes.filter((note: unknown): note is string => typeof note === 'string') : []
 const knownLimits = [...new Set([...noteCodes.map((note: string) => limits[note] || (/\s/.test(note) && !/^[A-Z_ ]+$/.test(note) ? note : '')).filter(Boolean), ...(metadata.candidate_limit_reached === true ? [limits.CANDIDATE_COVERAGE_LIMIT_60] : []), ...(metadata.coverage_incomplete === true && !noteCodes.some((note: string) => ['INVALID_COMPANY_ROW', 'INVALID_QSA_ROW', 'QSA_COVERAGE_LIMIT'].includes(note)) ? ['Parte dos dados da fonte continua incompleta neste recorte.'] : [])])]
 const scanLimit = count(metadata.coverage_limits?.company_scan_limit)
 const qsaLimit = minhaReceita ? null : count(metadata.coverage_limits?.qsa_roots_per_run)
 const pagesPerQuery = count(metadata.coverage_limits?.pages_per_run)
 const companiesPerPage = count(metadata.coverage_limits?.companies_per_page)
 const contextMissing = !text(lead.name) || !text(lead.city) || !text(lead.state) || !text(lead.segment)
 const groups = new Map<string, Row[]>()
 for (const candidate of candidates) {
  const cnpj = companyId(candidate.metadata?.full_cnpj)
  const key = /^[A-Z0-9]{12}\d{2}$/.test(cnpj) ? cnpj : candidate.id
  const rows = groups.get(key) || []
  rows.push(candidate)
  groups.set(key, rows)
 }

 function documentarySupport(candidate: Row) {
  const document = evidence.get(text(candidate.metadata?.evidence_id))
  return document?.organization_id === lead.organization_id && document?.lead_id === lead.id && document.verification_status === 'VERIFIED' && Boolean(document.source_registry_id)
 }
 function canOpen(candidate: Row, entityType: 'COMPANY' | 'PERSON') {
  const md = candidate.metadata || {}
  if (candidate.validation_status !== 'UNVALIDATED' || candidate.confidence !== 'LOW' || md.kinship_confirmed !== false || !documentarySupport(candidate)) return false
  if (!['COMPANY', 'PERSON'].includes(candidate.entity_type || '')) return false
  return entityType === 'COMPANY'
   ? /^[A-Z0-9]{12}\d{2}$/.test(companyId(md.full_cnpj)) && Boolean(text(md.company_name))
   : candidate.entity_type === 'PERSON' && md.match_basis === 'QSA_PERSON' && Boolean(text(md.person_name))
 }
 function begin(action: string) {
  if (readOnly || actionInProgress.current) return false
  actionInProgress.current = true
  setBusy(action)
  setMessage('')
  setHasError(false)
  setOpenedPath('')
  return true
 }
 function finish() {
  actionInProgress.current = false
  setBusy('')
 }
 async function discover() {
  if (contextMissing || !begin('search')) return
  try {
   const restart = metadata.continuation === false && ['PARTIAL', 'FAILED', 'COMPLETE', 'COMPLETED'].includes(searchStatus)
   const {data, error} = await supabaseBrowser().functions.invoke('family-cluster-discovery', {body: {lead_id: lead.id, restart}})
   if (error) throw new Error(await describeError(error, 'Não foi possível consultar as pistas. Tente novamente.'))
   await onUpdated()
   const status = text(data?.search_status || data?.status).toUpperCase()
   if (status === 'FAILED' || status === 'BLOCKED') {
    setHasError(true)
    setMessage(status === 'BLOCKED' ? text(data?.note) || 'Consulta bloqueada. Confira o município, a UF e o segmento/CNAE do lead e os limites registrados abaixo.' : 'A consulta não foi concluída. Confira os limites registrados e tente novamente.')
   } else setMessage(data?.complete === true ? 'O recorte disponível foi consultado. As coincidências continuam sendo pistas, com parentesco não confirmado.' : 'Consulta registrada com cobertura parcial. As pistas encontradas estão preservadas; continue a busca quando houver páginas ou empresas pendentes.')
  } catch (error) {
   // A failed HTTP response can still have persisted a partial/failed pivot.
   try {await onUpdated()} catch {}
   setHasError(true)
   setMessage(error instanceof Error ? error.message : 'Não foi possível consultar as pistas.')
  } finally {finish()}
 }
 async function open(candidate: Row, entityType: 'COMPANY' | 'PERSON') {
  if (!canOpen(candidate, entityType) || !begin(`${candidate.id}:${entityType}`)) return
  try {
   const {data, error} = await supabaseBrowser().functions.invoke('open-family-candidate', {body: {candidate_id: candidate.id, entity_type: entityType}})
   if (error) throw new Error(await describeError(error, 'Não foi possível abrir a investigação separada. Atualize o dossiê e confira a pista.'))
   if (!uuid(data?.lead?.id) || data.lead.kind !== entityType || data.lead.organization_id !== lead.organization_id) throw new Error('O dossiê separado não pôde ser validado. Atualize a página antes de continuar.')
   const path = `/leads/${data.lead.id}`
   await onUpdated()
   if (data.research_error) {
    setHasError(true)
    setMessage('O dossiê separado está disponível, mas a pesquisa não pôde iniciar. Abra-o e use Nova pesquisa para continuar.')
    setOpenedPath(path)
   } else router.push(path)
  } catch (error) {
   setHasError(true)
   setMessage(error instanceof Error ? error.message : 'Não foi possível abrir a investigação separada.')
  } finally {finish()}
 }
 async function reject(candidate: Row) {
  if (readOnly || actionInProgress.current) return
  const reason = window.prompt('Por que esta pista por sobrenome deve ser descartada?')?.trim()
  if (reason == null) return
  if (reason.length < 5 || reason.length > 2000) {
   setHasError(true)
   setMessage('Informe uma justificativa entre 5 e 2.000 caracteres para registrar o descarte.')
   return
  }
  if (!begin(`${candidate.id}:REJECT`)) return
  try {
   const {error} = await supabaseBrowser().functions.invoke('review-graph-candidate', {body: {candidate_id: candidate.id, action: 'REJECT', reason}})
   if (error) throw new Error(await describeError(error, 'Não foi possível descartar a pista. Tente novamente.'))
   await onUpdated()
   setMessage('Pista descartada com justificativa e histórico preservados.')
  } catch (error) {
   setHasError(true)
   setMessage(error instanceof Error ? error.message : 'Não foi possível descartar a pista.')
  } finally {finish()}
 }

 return <section className="card section" aria-label="Pistas por sobrenome" aria-busy={Boolean(busy)}>
  <h3>Pivô familiar — pistas por sobrenome</h3>
  <p className="muted">Explore pessoas citadas em quadros societários e empresas com o sobrenome no município e na atividade pesquisados. Cada pista pode abrir uma investigação própria.</p>
  <div className="caution">Parentesco não confirmado. Sobrenome, localidade e atividade são pistas de contexto. A cidade pertence ao cadastro da empresa e não comprova residência da pessoa. Estas pistas não confirmam a identidade do lead nem um vínculo familiar.</div>
  <div className="banner section">
   <div className="pill-row"><span className="badge pending">{busy === 'search' ? 'Consultando contexto…' : statusLabel(searchStatus, complete, Boolean(pivot))}</span><span className="badge pending">Rede candidata</span></div>
   <p><strong>Sobrenome:</strong> {surname || 'Definido pela consulta'} · <strong>Município/UF:</strong> {[city, state].filter(Boolean).join('/') || 'A informar'} · <strong>Atividade:</strong> {segment || 'A informar'}</p>
   {businessProvider && <p className="micro"><strong>Fonte desta consulta:</strong> {providerLabel(businessProvider)}{businessDataMonth ? ` · Base cadastral: ${businessDataMonth}` : ''}.</p>}
   {minhaReceita && <p className="caution micro">Minha Receita oferece uma consulta experimental por páginas de dados cadastrais mensais. Sua cobertura permanece parcial, mesmo após consultar as páginas disponíveis. Ela e a Base Empresarial retransmitem dados públicos do CNPJ/RFB; a coincidência entre ambas não é uma confirmação por fonte independente.</p>}
   <div className="micro">{scannedCount} estabelecimento(s) consultado(s) · {foundCount} pista(s) registrada(s) · {candidates.length} em análise · {rejected.length} descartada(s)</div>
   {reportedCount != null && reportedCount !== candidates.length && <p className="micro">A fonte informa {reportedCount} pista(s) acumulada(s); a lista abaixo mostra somente o contexto atual.</p>}
   {lastQuery && <p className="micro">Última consulta: {lastQuery} (horário de Brasília).</p>}
   {text(lineage.coverage) && <p className="micro">{text(lineage.coverage)}</p>}
   {pivot && !complete && <p className="micro">Cobertura parcial: o resultado não representa todas as empresas ou pessoas deste contexto.{continuation ? ' Há consulta pendente que pode ser continuada.' : ' Confira os limites da fonte antes de reconsultar.'}</p>}
   {knownLimits.length > 0 && <ul className="micro">{knownLimits.map(limit => <li key={limit}>{limit}</li>)}</ul>}
   {dateLabel(metadata.retry_not_before) && <p className="micro">A fonte permite nova tentativa a partir de {dateLabel(metadata.retry_not_before)} (horário de Brasília).</p>}
   {(pagesPerQuery != null || companiesPerPage != null) && <p className="micro">Limites por consulta: {pagesPerQuery != null ? `até ${pagesPerQuery} página(s)` : 'páginas conforme disponibilidade da fonte'}{companiesPerPage != null ? `, com até ${companiesPerPage} estabelecimentos por página` : ''}{qsaLimit != null ? `; até ${qsaLimit} quadros societários` : ''}.{minhaReceita ? ' O quadro societário é lido junto com o cadastro de cada empresa.' : ''}</p>}
   {minhaReceita && continuation && <p className="micro">Há páginas pendentes. Continuar busca retoma a próxima página disponível e preserva as pistas já registradas.</p>}
   {(scanLimit != null || qsaLimit != null && pagesPerQuery == null && companiesPerPage == null) && <p className="micro">Limites deste recorte: {scanLimit != null ? `até ${scanLimit} estabelecimentos` : 'estabelecimentos conforme disponibilidade da fonte'}{qsaLimit != null && pagesPerQuery == null && companiesPerPage == null ? `; até ${qsaLimit} quadros societários por consulta` : ''}.</p>}
   {contextMissing && <p className="micro">Informe nome, município, UF e segmento/CNAE no lead para consultar este contexto.</p>}
   {(earlierContextCount > 0 || allPivots.length > pivots.length) && <p className="micro">{earlierContextCount > 0 ? `${earlierContextCount} pista(s) de recortes anteriores ou sem contexto completo` : 'Consultas de recortes anteriores'} permanecem preservadas no histórico. Elas não são apresentadas como resultados do contexto atual.</p>}
   <div className="actions"><button className="btn secondary" type="button" disabled={readOnly || Boolean(busy) || contextMissing} onClick={discover}>{busy === 'search' ? 'Consultando…' : continuation ? 'Continuar busca por contexto' : hasActualQuery ? 'Consultar novamente' : 'Buscar por contexto'}</button></div>
   {readOnly && <p className="micro">Seu acesso permite consultar as pistas e seus documentos. Ações de pesquisa e revisão exigem permissão de edição.</p>}
  </div>
  {message && <div role={hasError ? 'alert' : 'status'} className={hasError ? 'caution section' : 'banner section'}>{message}{openedPath && <p><a className="lead-link" href={openedPath}>Abrir dossiê separado →</a></p>}</div>}
  <div className="stack">
   {[...groups.entries()].map(([key, rows]) => {
    const md = rows[0].metadata || {}
    const cnpj = companyId(md.full_cnpj)
    const companyCandidate = rows.find(candidate => canOpen(candidate, 'COMPANY')) || rows[0]
    return <article className="banner" key={key}>
     <strong>{text(md.company_name) || 'Empresa a validar'}</strong>
     <p className="micro">{cnpj ? `CNPJ: ${cnpj} · ` : ''}{[text(md.city), text(md.state)].filter(Boolean).join('/') || 'Município cadastral a validar'} · {text(md.cnae_description) || text(md.segment) || 'Atividade a validar'}{text(md.cnae_code) ? ` (CNAE ${text(md.cnae_code)})` : ''}</p>
     <div className="actions"><button className="btn secondary" type="button" disabled={readOnly || Boolean(busy) || !canOpen(companyCandidate, 'COMPANY')} onClick={() => open(companyCandidate, 'COMPANY')}>{busy === `${companyCandidate.id}:COMPANY` ? 'Abrindo empresa…' : 'Investigar empresa separadamente'}</button></div>
     {rows.map(candidate => {
      const candidateMetadata = candidate.metadata || {}
      const document = evidence.get(text(candidateMetadata.evidence_id))
      const candidateProvider = documentProvider(document, candidateMetadata)
      const candidateSourceLabel = text(document?.source_label) || providerLabel(candidateProvider)
      const verified = documentarySupport(candidate)
      const url = sourceUrl(document?.source_url) || sourceUrl(candidateMetadata.source_url)
      const isPerson = candidateMetadata.match_basis === 'QSA_PERSON' && candidate.entity_type === 'PERSON' && Boolean(text(candidateMetadata.person_name))
      return <div className="section" key={candidate.id}>
       <div className="pill-row"><span className="badge pending">Pista não validada</span><span className="micro">{isPerson ? 'Sobrenome citado no quadro societário' : candidateMetadata.match_basis === 'COMPANY_NAME' ? 'Sobrenome no nome da empresa' : 'Contexto a revisar'}</span></div>
       {isPerson && <p><strong>{text(candidateMetadata.person_name)}</strong>{text(candidateMetadata.partner_role) ? ` · ${text(candidateMetadata.partner_role)}` : ''}</p>}
       {text(candidate.candidate_reason) && <p className="micro">{text(candidate.candidate_reason)}</p>}
       <details>
        <summary className="source-link">Documento e contexto da pista</summary>
        <p className="micro">{document?.title || 'Documento cadastral da empresa'} · {verified ? 'Documento verificado; parentesco permanece não confirmado.' : 'Documento pendente, indisponível ou requer revisão.'}</p>
        {candidateSourceLabel && <p className="micro">Fonte deste documento: {candidateSourceLabel}.</p>}
        {candidateProvider === 'MINHA_RECEITA' && <p className="micro">Consulta cadastral experimental, com origem nos dados públicos do CNPJ/RFB. Não equivale a uma confirmação independente de identidade ou parentesco.</p>}
        {dateLabel(document?.retrieved_at) && <p className="micro">Consultado em {dateLabel(document?.retrieved_at)} (horário de Brasília).</p>}
        <p className="micro">Critério: {candidateMetadata.match_basis === 'QSA_PERSON' ? 'sobrenome no nome de participante do QSA' : candidateMetadata.match_basis === 'COMPANY_NAME' ? 'sobrenome no nome empresarial' : 'coincidência contextual a revisar'}; município/UF e atividade do estabelecimento comparados ao recorte pesquisado.</p>
        {text(candidateMetadata.search_lineage?.coverage) && <p className="micro">{text(candidateMetadata.search_lineage.coverage)}</p>}
        {url && <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">Abrir fonte ↗</a>}
       </details>
       {!verified && <p className="micro">A investigação separada exige documento verificado neste dossiê.</p>}
       <div className="actions">{isPerson && <button className="btn secondary" type="button" disabled={readOnly || Boolean(busy) || !canOpen(candidate, 'PERSON')} onClick={() => open(candidate, 'PERSON')}>{busy === `${candidate.id}:PERSON` ? 'Abrindo pessoa…' : 'Investigar pessoa separadamente'}</button>}<button className="link-btn" type="button" disabled={readOnly || Boolean(busy)} onClick={() => reject(candidate)}>{busy === `${candidate.id}:REJECT` ? 'Descartando…' : 'Descartar pista'}</button></div>
      </div>
     })}
    </article>
   })}
   {!candidates.length && <div className="empty">{pivot ? complete ? 'Nenhuma pista em análise no recorte consultado. Isso não exclui vínculos fora deste contexto ou das fontes disponíveis.' : 'Nenhuma pista em análise até agora. A consulta tem cobertura limitada; continue ou revise o recorte.' : 'Busque por contexto para registrar pistas e seus documentos.'}</div>}
  </div>
  {allRejected.length > 0 && <p className="micro section">{allRejected.length} pista(s) descartada(s) permanecem registradas no histórico e não aparecem nesta rede candidata. {rejected.length} pertence(m) ao recorte atual.</p>}
  {reviews.length > 0 && <details className="section"><summary className="source-link">Histórico de descarte ({reviews.length})</summary>{reviews.map(review => <p className="micro" key={review.id}>{dateLabel(review.created_at) || 'Data não informada'} · {review.reason}</p>)}</details>}
 </section>
}
