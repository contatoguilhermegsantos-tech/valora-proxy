'use client'

import {useEffect, useMemo, useRef, useState} from 'react'
import {useRouter} from 'next/navigation'
import {supabaseBrowser} from '@/lib/supabase'

type Row = {
 id: string; organization_id?: string; lead_id?: string; candidate_type?: string
 entity_type?: string; validation_status?: string; confidence?: string; created_at?: string
 metadata?: Record<string, any>
}
type Document = {
 id: string; organization_id?: string; lead_id?: string; verification_status?: string
 source_registry_id?: string; source_url?: string; source_label?: string; title?: string
 excerpt?: string; retrieved_at?: string
}
type Node = {
 key: string; type: 'ROOT' | 'COMPANY' | 'PERSON_CITATION'; label: string; depth: number
 full_cnpj?: string; person_name?: string; city?: string; state?: string; cnae_code?: string
 cnae_description?: string; trade_name?: string; registration_status?: string
 candidate_id?: string; observation_key?: string; evidence_id?: string
 identity_confirmed?: false; kinship_confirmed?: false
}
type Edge = {
 id: string; from: string; to: string
 kind: 'QSA_PARTICIPATION' | 'SAME_NAME_CANDIDATE' | 'SURNAME_CONTEXT_CANDIDATE' | 'ROOT_CONTEXT_CANDIDATE'
 evidence_id?: string; evidence_ids?: string[]; observation_key?: string; candidate_id?: string
 validation_status?: string; confidence?: string; match_basis?: string
}
type Network = {
 nodes: Node[]; edges: Edge[]; revision?: number; status?: string; continuation?: boolean
 counts?: Record<string, unknown>; notes?: unknown[]; retry_not_before?: string
 [key: string]: any
}
type Dossier = {
 role?: string
 lead: {id: string; organization_id: string; kind: string; name?: string}
 candidates?: Row[]; evidence?: Document[]
 research_runs?: {id: string; organization_id?: string; lead_id?: string}[]
}
type Reply = {ok?: boolean; status?: string; continuation?: boolean; network?: Network; pivot?: Row; error?: string}

const MAX_NODES = 300, MAX_EDGES = 700, MAX_BATCHES = 12
const WRITE_ROLES = new Set(['OWNER', 'ADMIN', 'ANALYST', 'MEMBER'])
const NODE_TYPES = new Set(['ROOT', 'COMPANY', 'PERSON_CITATION'])
const EDGE_TYPES = new Set(['QSA_PARTICIPATION', 'SAME_NAME_CANDIDATE', 'SURNAME_CONTEXT_CANDIDATE', 'ROOT_CONTEXT_CANDIDATE'])
const OPEN_TYPES = new Set(['FAMILY_CONTEXT_MATCH', 'FAMILY_NETWORK_COMPANY', 'FAMILY_NETWORK_PERSON'])
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const norm = (value: unknown) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
const uuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(value))
const cnpj = (value: unknown) => text(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
const validCnpj = (value: unknown) => /^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj(value))
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
function httpsUrl(value: unknown) {
 try {const url = new URL(text(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null} catch {return null}
}
function dateLabel(value: unknown) {
 const date = new Date(text(value)); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', {timeZone: 'America/Sao_Paulo'})
}
function edgeLabel(edge: Edge, verified: boolean) {
 return edge.kind === 'QSA_PARTICIPATION' ? verified ? 'Nome documentado no QSA' : 'QSA: documento a revisar'
  : edge.kind === 'SAME_NAME_CANDIDATE' ? 'Mesmo nome · hipótese'
  : edge.kind === 'SURNAME_CONTEXT_CANDIDATE' ? 'Sobrenome · pista' : 'Contexto inicial · pista'
}
function edgeDocuments(edge: Edge) {return [...new Set([edge.evidence_id, ...(Array.isArray(edge.evidence_ids) ? edge.evidence_ids : [])].filter((id): id is string => uuid(id)))]}
const noteLabels: Record<string, string> = {
 DEADLINE: 'A rodada atingiu o tempo disponível; o progresso foi preservado.',
 RATE_LIMIT_RETRY_AFTER: 'A fonte limitou as consultas. Aguarde antes de continuar.',
 CURSOR_DID_NOT_ADVANCE: 'A fonte não avançou para outra página; a expansão foi interrompida.',
 SOURCE_CURSOR_STALLED: 'A fonte não avançou para outra página; a expansão foi interrompida.',
 NODE_LIMIT: 'O mapa atingiu o limite de nós deste recorte.',
 EDGE_LIMIT: 'O mapa atingiu o limite de conexões deste recorte.',
 DEPTH_LIMIT: 'A expansão atingiu a profundidade disponível neste recorte.',
 GRAPH_COMPANY_LIMIT_60: 'A expansão atingiu o limite de 60 empresas deste recorte.',
 GRAPH_PERSON_LIMIT_160: 'A expansão atingiu o limite de 160 ocorrências de nomes no QSA.',
 GRAPH_EDGE_LIMIT_300: 'A expansão atingiu o limite de conexões deste recorte.',
 GRAPH_DEPTH_LIMIT_3: 'A expansão atingiu três níveis de empresas neste recorte.',
 MUNICIPAL_INDEX_LIMIT: 'A consulta atingiu o limite de cadastros municipais deste recorte.',
 SOURCES_DISABLED: 'As fontes desta expansão não estão disponíveis.',
 GEOGRAPHY_NOT_UNIQUE: 'O município/UF não pôde ser resolvido sem ambiguidade.',
 NO_SEEDS: 'Busque primeiro as pistas por contexto para encontrar os CNPJs iniciais.',
 NO_ELIGIBLE_SEEDS: 'Nenhum CNPJ inicial possui documento elegível neste dossiê.',
 SOURCE_UNAVAILABLE: 'Uma fonte não está disponível. As conexões anteriores foram preservadas.',
}
async function actionError(error: any, fallback: string) {
 const status = error?.context?.status
 if (status === 401) return 'A sessão expirou. Entre novamente para continuar.'
 if (status === 403) return 'Seu acesso permite consultar o mapa, mas não executar esta ação.'
 if (status === 404) return 'O nó ou o dossiê não está disponível neste contexto. Atualize a página.'
 if (status === 409) return 'O progresso ou uma pista mudou durante a consulta. O mapa foi atualizado; confira antes de continuar.'
 if (status === 429) return 'A fonte limitou as consultas. A expansão foi pausada; aguarde antes de continuar.'
 return fallback
}

// Keys identify observations, never a person globally by their display name.
function cleanGraph(network: Network | undefined, rows: Row[], leadName: string) {
 const candidates = new Map(rows.map(row => [row.id, row]))
 const rejectedObservations = new Set(rows.filter(row => row.validation_status === 'REJECTED').flatMap(row => [row.id, text(row.metadata?.observation_key), text(row.metadata?.node_key)]).filter(Boolean))
 const nodes: Node[] = [], keys = new Set<string>()
 for (const node of Array.isArray(network?.nodes) ? network.nodes : []) {
  const key = text(node?.key)
  if (!key || key.length > 300 || keys.has(key) || !NODE_TYPES.has(node?.type) || (node.identity_confirmed as unknown) === true || (node.kinship_confirmed as unknown) === true) continue
  if (node.candidate_id && (!uuid(node.candidate_id) || !candidates.has(node.candidate_id) || candidates.get(node.candidate_id)?.validation_status === 'REJECTED')) continue
  if (rejectedObservations.has(key) || rejectedObservations.has(text(node.observation_key))) continue
  keys.add(key); nodes.push({...node, key, label: node.type === 'ROOT' ? leadName : text(node.label).slice(0, 300), depth: Math.min(number(node.depth), 8)})
  if (nodes.length === MAX_NODES) break
 }
 const edges: Edge[] = [], edgeIds = new Set<string>()
 for (const edge of Array.isArray(network?.edges) ? network.edges : []) {
  if (!text(edge?.id) || edgeIds.has(edge.id) || !keys.has(edge.from) || !keys.has(edge.to) || !EDGE_TYPES.has(edge.kind) || edge.validation_status === 'REJECTED') continue
  if (rejectedObservations.has(text(edge.observation_key)) || edge.candidate_id && (!candidates.has(edge.candidate_id) || candidates.get(edge.candidate_id)?.validation_status === 'REJECTED')) continue
  edgeIds.add(edge.id); edges.push(edge); if (edges.length === MAX_EDGES) break
 }
 return {nodes, edges, clipped: (network?.nodes?.length || 0) > MAX_NODES || (network?.edges?.length || 0) > MAX_EDGES}
}
function connectionCost(edge: Edge) {
 if (edge.kind === 'QSA_PARTICIPATION') return 1
 if (edge.kind === 'SAME_NAME_CANDIDATE') return 2
 if (edge.kind === 'ROOT_CONTEXT_CANDIDATE') {
  if (edge.match_basis === 'SEED_CNPJ_OBSERVED') return 1
  if (['QSA_EXACT_NAME', 'LEGAL_NAME_EXACT_PERSON_NAME', 'EXACT_LEAD_NAME_PENDING_IDENTITY'].includes(text(edge.match_basis))) return 2
 }
 return 10
}
function connectionPath(nodes: Node[], edges: Edge[], target: string) {
 const root = nodes.find(node => node.type === 'ROOT')
 if (!root || !target) return {nodes: [] as string[], edges: [] as string[]}
 const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
 const adjacent = new Map<string, {key: string; edge: string; cost: number}[]>()
 for (const edge of edges) {
  const cost = connectionCost(edge)
  adjacent.set(edge.from, [...(adjacent.get(edge.from) || []), {key: edge.to, edge: edge.id, cost}])
  adjacent.set(edge.to, [...(adjacent.get(edge.to) || []), {key: edge.from, edge: edge.id, cost}])
 }
 for (const neighbors of adjacent.values()) neighbors.sort((a, b) => compare(a.key, b.key) || compare(a.edge, b.edge))
 // These costs select an explanation route; they do not change confidence or identity.
 const previous = new Map<string, {key: string; edge: string}>(), distance = new Map([[root.key, 0]]), signatures = new Map([[root.key, '']])
 const queue = [{key: root.key, cost: 0, signature: ''}]
 while (queue.length) {
  queue.sort((a, b) => a.cost - b.cost || compare(a.signature, b.signature) || compare(a.key, b.key))
  const current = queue.shift()!
  if (current.cost !== distance.get(current.key) || current.signature !== signatures.get(current.key)) continue
  if (current.key === target) break
  for (const next of adjacent.get(current.key) || []) {
   const cost = current.cost + next.cost, signature = current.signature + JSON.stringify([next.edge, next.key])
   const savedCost = distance.get(next.key), savedSignature = signatures.get(next.key)
   if (savedCost !== undefined && (cost > savedCost || cost === savedCost && compare(signature, savedSignature || '') >= 0)) continue
   distance.set(next.key, cost); signatures.set(next.key, signature); previous.set(next.key, {key: current.key, edge: next.edge})
   queue.push({key: next.key, cost, signature})
  }
 }
 if (!distance.has(target)) return {nodes: [target], edges: [] as string[]}
 const pathNodes = [target], pathEdges: string[] = []; let cursor = target
 while (cursor !== root.key) {const step = previous.get(cursor); if (!step) break; pathEdges.unshift(step.edge); pathNodes.unshift(step.key); cursor = step.key}
 return {nodes: pathNodes, edges: pathEdges}
}
function progressKey(reply: Reply) {
 const graph = reply.network || reply.pivot?.metadata?.public_graph
 return JSON.stringify([graph?.revision, graph?.nodes?.length, graph?.edges?.length, graph?.counts, reply.pivot?.metadata?.revision, reply.pivot?.metadata?.scanned_count])
}
function halted(reply: Reply) {
 const metadata = reply.pivot?.metadata || {}, graph = reply.network || metadata.public_graph || {}
 const state = metadata.state || {}
 const notes = [...(Array.isArray(graph.notes) ? graph.notes : []), ...(Array.isArray(metadata.notes) ? metadata.notes : []), ...(Array.isArray(state.notes) ? state.notes : [])]
 return ['FAILED', 'BLOCKED'].includes(text(reply.status || graph.status || metadata.status || metadata.search_status).toUpperCase())
  || metadata.source_cursor_stalled === true || metadata.stalled === true || graph.stalled === true || state.source_cursor_stalled === true || state.stalled === true || state.pagination_stalled === true || graph.pagination_stalled === true
  || notes.some(note => ['CURSOR_DID_NOT_ADVANCE', 'SOURCE_CURSOR_STALLED', 'RATE_LIMIT_RETRY_AFTER'].includes(text(note)))
  || Date.parse(text(metadata.retry_not_before || graph.retry_not_before || state.retry_not_before)) > Date.now()
}

export function FamilyNetworkGraph({dossier, onUpdated}: {dossier: Dossier; onUpdated: () => Promise<void>}) {
 const router = useRouter(), latest = useRef({dossier, onUpdated})
 latest.current = {dossier, onUpdated}
 const mounted = useRef(true), generation = useRef(0), automaticStarted = useRef(false), inFlight = useRef(false)
 const [reply, setReply] = useState<Reply | null>(null), [expanding, setExpanding] = useState(false), [busy, setBusy] = useState(false)
 const [batch, setBatch] = useState(0), [message, setMessage] = useState(''), [hasError, setHasError] = useState(false)
 const [selectedKey, setSelectedKey] = useState(''), [query, setQuery] = useState(''), [openedPath, setOpenedPath] = useState('')
 const [currentTime, setCurrentTime] = useState(() => Date.now())
 const lead = dossier.lead, readOnly = !WRITE_ROLES.has(text(dossier.role))
 const ownRows = useMemo(() => (dossier.candidates || []).filter(row => row.organization_id === lead.organization_id && row.lead_id === lead.id), [dossier.candidates, lead.organization_id, lead.id])
 const evidence = useMemo(() => new Map((dossier.evidence || []).filter(document => document.organization_id === lead.organization_id && document.lead_id === lead.id).map(document => [document.id, document])), [dossier.evidence, lead.organization_id, lead.id])
 const pivots = ownRows.filter(row => row.candidate_type === 'FAMILY_NETWORK_PIVOT')
 const persistedPivot = [...pivots].sort((a, b) => number(b.metadata?.revision || b.metadata?.public_graph?.revision) - number(a.metadata?.revision || a.metadata?.public_graph?.revision) || text(b.created_at).localeCompare(text(a.created_at)))[0]
 const savedGraph: Network | undefined = persistedPivot?.metadata?.public_graph
 const currentReply: Reply = reply && number(reply.network?.revision) >= number(savedGraph?.revision) ? reply : {network: savedGraph, pivot: persistedPivot}
 const pivot = currentReply.pivot || persistedPivot, network = currentReply.network || pivot?.metadata?.public_graph
 const graph = useMemo(() => cleanGraph(network, ownRows, text(lead.name)), [network, ownRows, lead.name])
 const nodeMap = new Map(graph.nodes.map(node => [node.key, node]))
 const selected = nodeMap.get(selectedKey) || graph.nodes.find(node => node.type === 'ROOT') || graph.nodes[0]
 const path = useMemo(() => connectionPath(graph.nodes, graph.edges, selected?.key || ''), [graph.nodes, graph.edges, selected?.key])
 const pathNodes = new Set(path.nodes), pathEdges = new Set(path.edges)
 const filteredGraph = useMemo(() => {
  if (!norm(query)) return graph
  const keep = new Set(graph.nodes.filter(node => node.type === 'ROOT').map(node => node.key))
  for (const node of graph.nodes) if (norm([node.label, node.full_cnpj, node.city, node.state].filter(Boolean).join(' ')).includes(norm(query))) for (const key of connectionPath(graph.nodes, graph.edges, node.key).nodes) keep.add(key)
  if (selectedKey) for (const key of path.nodes) keep.add(key)
  return {...graph, nodes: graph.nodes.filter(node => keep.has(node.key)), edges: graph.edges.filter(edge => keep.has(edge.from) && keep.has(edge.to))}
 }, [graph, query, selectedKey, path.nodes])
 const layout = useMemo(() => {
  const columns = new Map<number, Node[]>(), positions = new Map<string, {x: number; y: number}>()
  for (const node of filteredGraph.nodes) {const column = node.type === 'ROOT' ? 0 : Math.max(0, node.depth - 1) * 2 + (node.type === 'PERSON_CITATION' ? 2 : 1); columns.set(column, [...(columns.get(column) || []), node])}
  let width = 720, height = 310
  for (const [column, nodes] of columns) {
   nodes.sort((a, b) => a.key.localeCompare(b.key)); width = Math.max(width, 270 * column + 270)
   nodes.forEach((node, index) => {const position = {x: 24 + column * 270, y: 38 + index * 142}; positions.set(node.key, position); height = Math.max(height, position.y + 148)})
  }
  return {positions, width, height}
 }, [filteredGraph.nodes])
 const continuation = currentReply.continuation ?? network?.continuation ?? pivot?.metadata?.continuation ?? pivot?.metadata?.state?.continuation ?? false
 const status = text(currentReply.status || network?.status || pivot?.metadata?.status || pivot?.metadata?.search_status || pivot?.metadata?.state?.status).toUpperCase()
 const retryAt = text(pivot?.metadata?.retry_not_before || network?.retry_not_before || pivot?.metadata?.state?.retry_not_before), cooldown = Date.parse(retryAt) > currentTime
 const pivotRejected = pivot?.validation_status === 'REJECTED' || persistedPivot?.validation_status === 'REJECTED'
 const seedsReady = ownRows.some(row => row.candidate_type === 'FAMILY_CONTEXT_MATCH' && row.validation_status === 'UNVALIDATED' && row.confidence === 'LOW' && row.metadata?.kinship_confirmed === false && validCnpj(row.metadata?.full_cnpj) && evidence.get(text(row.metadata?.evidence_id))?.verification_status === 'VERIFIED')
 const notes = [...new Set([...(Array.isArray(network?.notes) ? network.notes : []), ...(Array.isArray(pivot?.metadata?.notes) ? pivot.metadata.notes : [])].map((note: unknown) => noteLabels[text(note)] || (/\s/.test(text(note)) && !/^[A-Z_ ]+$/.test(text(note)) ? text(note).slice(0, 300) : '')).filter(Boolean))]
 const selectedCandidate = ownRows.find(row => row.id === selected?.candidate_id)
 const candidateDocument = evidence.get(text(selectedCandidate?.metadata?.evidence_id))
 const selectedType = selected?.type === 'PERSON_CITATION' ? 'PERSON' : selected?.type === 'COMPANY' ? 'COMPANY' : ''
 const canOpen = Boolean(selected && path.nodes.length > 1 && nodeMap.get(path.nodes[0])?.type === 'ROOT' && selectedCandidate && OPEN_TYPES.has(text(selectedCandidate.candidate_type)) && uuid(selectedCandidate.id) && selectedCandidate.validation_status === 'UNVALIDATED' && selectedCandidate.confidence === 'LOW'
  && selectedCandidate.metadata?.kinship_confirmed === false && candidateDocument?.verification_status === 'VERIFIED' && uuid(candidateDocument?.source_registry_id)
  && (!selected.evidence_id || evidence.get(selected.evidence_id)?.verification_status === 'VERIFIED')
  && (selectedType === 'COMPANY' ? validCnpj(selectedCandidate.metadata?.full_cnpj) && cnpj(selectedCandidate.metadata?.full_cnpj) === cnpj(selected.full_cnpj) && Boolean(text(selectedCandidate.metadata?.company_name))
   : selectedType === 'PERSON' && selectedCandidate.entity_type === 'PERSON' && Boolean(text(selectedCandidate.metadata?.person_name)) && norm(selectedCandidate.metadata?.person_name) === norm(selected.person_name || selected.label)))
 const documentIds = [...new Set([selected?.evidence_id, selectedCandidate?.metadata?.evidence_id, ...graph.edges.filter(edge => pathEdges.has(edge.id)).flatMap(edgeDocuments)].filter((id): id is string => uuid(id)))]
 const documents = documentIds.map(id => evidence.get(id)).filter((document): document is Document => Boolean(document))

 useEffect(() => {mounted.current = true; return () => {mounted.current = false; generation.current++}}, [])
 useEffect(() => {
  if (!expanding) return
  const token = ++generation.current
  void (async () => {
   let previousKey = progressKey(currentReply), completed = 0
   try {
    for (let index = 0; index < MAX_BATCHES; index++) {
     if (!mounted.current || token !== generation.current || inFlight.current || !WRITE_ROLES.has(text(latest.current.dossier.role))) break
     const current = latest.current.dossier, run = (current.research_runs || []).find(row => uuid(row.id) && row.organization_id === lead.organization_id && row.lead_id === lead.id)
     const body = {lead_id: lead.id, action: 'expand', ...(run ? {research_run_id: run.id} : {})}
     inFlight.current = true; setBusy(true); setBatch(index + 1)
     let result: Reply
     try {
      const response = await supabaseBrowser().functions.invoke('family-network-discovery', {body})
      if (response.error) throw new Error(await actionError(response.error, 'Não foi possível ampliar o mapa. O progresso anterior foi preservado.'))
      result = response.data || {}
      if (!result.network || !Array.isArray(result.network.nodes) || !Array.isArray(result.network.edges)) throw new Error('A fonte não entregou um mapa utilizável. O progresso anterior foi preservado.')
      if (result.pivot && (result.pivot.organization_id && result.pivot.organization_id !== lead.organization_id || result.pivot.lead_id && result.pivot.lead_id !== lead.id || result.pivot.candidate_type !== 'FAMILY_NETWORK_PIVOT')) throw new Error('O mapa recebido não pertence ao contexto deste dossiê.')
      if (mounted.current) setReply(result)
     } finally {inFlight.current = false; if (mounted.current) setBusy(false)}
     await latest.current.onUpdated(); completed++
     if (!mounted.current || token !== generation.current) break
     const nextKey = progressKey(result), more = result.continuation ?? result.network?.continuation ?? result.pivot?.metadata?.continuation ?? result.pivot?.metadata?.state?.continuation ?? false
     if (result.ok === false || halted(result)) {setHasError(result.ok === false); setMessage('A expansão foi pausada. Confira os limites e a disponibilidade da fonte antes de continuar.'); break}
     if (!more) {setMessage('A rodada terminou. O mapa mostra as conexões encontradas dentro da cobertura disponível.'); break}
     if (nextKey === previousKey) {setMessage('A consulta não avançou. A expansão foi pausada para evitar repetir a mesma página.'); break}
     previousKey = nextKey
     if (index === MAX_BATCHES - 1) setMessage('O progresso foi salvo após 12 etapas. Use Continuar expansão para consultar as próximas conexões.')
    }
   } catch (error) {
    if (mounted.current && token === generation.current) {setHasError(true); setMessage(error instanceof Error ? error.message : 'A expansão foi interrompida. O mapa anterior permanece disponível.')}
    await latest.current.onUpdated().catch(() => {})
   } finally {
    if (mounted.current && token === generation.current) {setExpanding(false); setBusy(false); if (!completed) setBatch(0)}
   }
  })()
  return () => {if (generation.current === token) generation.current++}
  // Dossier refreshes update latest.current without restarting this sequential loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [expanding, lead.id, lead.organization_id])
 useEffect(() => {
  if (lead.kind !== 'PERSON' || readOnly || automaticStarted.current || pivotRejected || !uuid(lead.id)) return
  const resume = Boolean(network) && continuation === true && currentReply.ok !== false && !halted(currentReply)
  const construct = !persistedPivot && !network && seedsReady
  if (!resume && !construct) return
  automaticStarted.current = true; setHasError(false); setMessage(resume ? 'Continuando o mapa a partir do progresso salvo…' : 'Construindo o mapa a partir dos CNPJs documentados…'); setExpanding(true)
 }, [lead.kind, lead.id, readOnly, Boolean(persistedPivot), Boolean(network), network?.revision, seedsReady, continuation, pivotRejected, status, retryAt, currentTime])
 useEffect(() => {
  const until = Date.parse(retryAt)
  if (!Number.isFinite(until) || until <= currentTime) return
  // One expiry update releases the action without polling the dossier or source.
  const timer = window.setTimeout(() => setCurrentTime(Date.now()), Math.min(2147483647, Math.max(0, until - Date.now() + 50)))
  return () => window.clearTimeout(timer)
 }, [retryAt, currentTime])

 function start() {if (readOnly || busy || expanding || cooldown || pivotRejected || !uuid(lead.id)) return; automaticStarted.current = true; setBatch(0); setMessage('Consultando as próximas conexões do mapa…'); setHasError(false); setOpenedPath(''); setExpanding(true)}
 function pause() {automaticStarted.current = true; generation.current++; setExpanding(false); setMessage('Expansão pausada. A consulta em andamento pode terminar; as próximas etapas aguardam sua ação.'); setHasError(false)}
 async function openSelected() {
  if (readOnly || busy || expanding || !canOpen || !selectedCandidate || !selectedType || inFlight.current) return
  inFlight.current = true; setBusy(true); setHasError(false); setMessage(''); setOpenedPath('')
  try {
   const {data, error} = await supabaseBrowser().functions.invoke('open-family-candidate', {body: {candidate_id: selectedCandidate.id, entity_type: selectedType}})
   if (error) throw new Error(await actionError(error, 'Não foi possível abrir a investigação separada. Confira o documento e a revisão do nó.'))
   if (!data?.ok || !uuid(data?.lead?.id) || data.lead.organization_id !== lead.organization_id || data.lead.kind !== selectedType) throw new Error('O dossiê independente não pôde ser validado neste contexto.')
   await onUpdated(); const destination = `/leads/${data.lead.id}`
   if (data.research_error) {setOpenedPath(destination); setMessage('O dossiê separado foi aberto, mas a pesquisa precisa ser iniciada novamente nele.'); return}
   router.push(destination)
  } catch (error) {setHasError(true); setMessage(error instanceof Error ? error.message : 'Não foi possível abrir a investigação separada.')}
  finally {inFlight.current = false; if (mounted.current) setBusy(false)}
 }

 if (lead.kind !== 'PERSON') return null
 return <section className="card section" aria-label="Mapa de conexões empresariais" aria-busy={busy}>
  <h3>Mapa de conexões empresariais</h3>
  <p className="muted">Parta dos CNPJs encontrados, consulte os nomes de seus quadros societários e descubra outras empresas onde esses nomes aparecem. As próximas conexões podem ter qualquer atividade.</p>
  <div className="caution">Um nome documentado no QSA não identifica automaticamente uma pessoa. Nomes iguais continuam separados; as linhas de contexto são hipóteses. Parentesco, residência, patrimônio e identidade individual permanecem não confirmados.</div>
  <div className="banner section" aria-live="polite">
   <div className="pill-row"><span className="badge pending">{expanding ? `Expandindo · etapa ${batch || 1}/${MAX_BATCHES}` : status === 'FAILED' ? 'Consulta interrompida' : status === 'BLOCKED' || pivotRejected ? 'Expansão bloqueada' : network ? 'Mapa com cobertura parcial' : 'Mapa ainda não construído'}</span><span className="badge neutral">{graph.nodes.filter(node => node.type === 'COMPANY').length} empresas</span><span className="badge neutral">{graph.nodes.filter(node => node.type === 'PERSON_CITATION').length} nomes no QSA</span><span className="badge neutral">{graph.edges.length} conexões</span></div>
   <p className="micro">Os filtros de município/UF e atividade definem os CNPJs iniciais. A expansão por nome completo não restringe as outras empresas ao segmento inicial.</p>
   {continuation && !expanding && <p className="micro">Há conexões pendentes; continuar retoma o progresso salvo sem substituir revisões anteriores.</p>}
   {retryAt && dateLabel(retryAt) && <p className="micro">Nova tentativa permitida a partir de {dateLabel(retryAt)} (horário de Brasília).</p>}
   {notes.length > 0 && <ul className="micro">{notes.map(note => <li key={note}>{note}</li>)}</ul>}
   {graph.clipped && <p className="micro">A visualização está limitada a {MAX_NODES} nós e {MAX_EDGES} conexões. O restante do progresso permanece registrado.</p>}
   <div className="actions">{expanding ? <button type="button" className="btn secondary" onClick={pause}>Pausar expansão</button> : <button type="button" className="btn" disabled={readOnly || busy || cooldown || pivotRejected || !seedsReady && !network} onClick={start}>{busy ? 'Aguardando consulta…' : network ? continuation ? 'Continuar expansão' : 'Consultar conexões novamente' : 'Construir mapa de conexões'}</button>}</div>
   {readOnly && <p className="micro">Seu acesso permite navegar pelo mapa e consultar documentos. A expansão e a pesquisa separada exigem permissão de edição.</p>}
  </div>
  {message && <div className={hasError ? 'caution section' : 'banner section'} role={hasError ? 'alert' : 'status'}>{message}{openedPath && <p><a className="lead-link" href={openedPath}>Abrir dossiê separado →</a></p>}</div>}
  <div className="pill-row section" aria-label="Legenda do mapa"><span className="micro"><span style={{display: 'inline-block', width: 28, borderTop: '2px solid #175cd3', marginRight: 5}}/>Nome documentado no QSA</span><span className="micro"><span style={{display: 'inline-block', width: 28, borderTop: '2px dashed #b54708', marginRight: 5}}/>Mesmo nome, sobrenome ou contexto: hipótese</span></div>
  <label className="label section">Localizar no mapa<input className="input" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nome, empresa, CNPJ ou município"/></label>
  {!graph.nodes.length ? <div className="empty section">{seedsReady ? 'Os CNPJs documentados estão disponíveis para iniciar o mapa.' : 'Encontre primeiro os CNPJs nas pistas por contexto abaixo. O mapa será construído a partir desses cadastros.'}</div> : <>
   <div className="graph-wrap section" style={{maxHeight: 650}} tabIndex={0} aria-label="Mapa navegável; use Tab para selecionar os nós e as setas para rolar">
    <div style={{position: 'relative', width: layout.width, height: layout.height}} role="group" aria-label="Nós do mapa de conexões">
     <svg width={layout.width} height={layout.height} style={{position: 'absolute', inset: 0}} aria-hidden="true" focusable="false">
      {filteredGraph.edges.map(edge => {const from = layout.positions.get(edge.from), to = layout.positions.get(edge.to); if (!from || !to) return null; const ids = edgeDocuments(edge), verified = ids.length > 0 && ids.every(id => evidence.get(id)?.verification_status === 'VERIFIED'), documented = edge.kind === 'QSA_PARTICIPATION' && verified, active = pathEdges.has(edge.id); const x1 = from.x + 110, y1 = from.y + 54, x2 = to.x + 110, y2 = to.y + 54; return <g key={edge.id}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={documented ? '#175cd3' : '#b54708'} strokeWidth={active ? 3 : 1.5} strokeDasharray={documented ? undefined : '6 5'} opacity={active || !selectedKey ? 1 : 0.38}/><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8} textAnchor="middle" fontSize={10} fill={documented ? '#175cd3' : '#93370d'}>{edgeLabel(edge, verified)}</text></g>})}
     </svg>
     {filteredGraph.nodes.map(node => {const position = layout.positions.get(node.key)!; const selectedNode = selected?.key === node.key; return <button type="button" key={node.key} aria-pressed={selectedNode} aria-label={`${node.type === 'ROOT' ? 'Lead principal' : node.type === 'COMPANY' ? 'Empresa' : 'Nome citado no QSA'}: ${node.label}. Selecionar caminho e documentos.`} onClick={() => setSelectedKey(node.key)} style={{position: 'absolute', left: position.x, top: position.y, width: 220, minHeight: 108, padding: 12, textAlign: 'left', cursor: 'pointer', border: `${selectedNode ? 3 : 1}px solid ${selectedNode ? '#175cd3' : node.type === 'ROOT' ? '#344054' : node.type === 'COMPANY' ? '#84adff' : '#b9e6fe'}`, borderRadius: 14, background: node.type === 'ROOT' ? '#101828' : '#fff', color: node.type === 'ROOT' ? '#fff' : '#101828', boxShadow: pathNodes.has(node.key) ? '0 0 0 3px #eff8ff' : '0 2px 6px #1018280d', opacity: selectedKey && !pathNodes.has(node.key) ? 0.65 : 1}}><span style={{display: 'block', fontSize: 10, marginBottom: 5}}>{node.type === 'ROOT' ? 'LEAD PRINCIPAL' : node.type === 'COMPANY' ? 'EMPRESA' : 'NOME CITADO NO QSA'}</span><strong style={{display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13, lineHeight: 1.4}}>{node.label}</strong><span style={{display: 'block', marginTop: 6, fontSize: 10}}>{node.type === 'COMPANY' ? `${node.full_cnpj || 'CNPJ a validar'}${node.city ? ` · ${node.city}/${node.state || '?'}` : ''}` : node.type === 'PERSON_CITATION' ? 'Identidade individual não confirmada' : 'Origem da investigação'}</span></button>})}
    </div>
   </div>
   {selected && <div className="banner section" aria-label="Caminho e documentos do nó selecionado">
    <h4>{selected.label}</h4>
    {selected.type === 'COMPANY' && <p className="micro">CNPJ {selected.full_cnpj || 'a validar'} · {[selected.city, selected.state].filter(Boolean).join('/') || 'Município cadastral a validar'}{selected.cnae_description || selected.cnae_code ? ` · ${selected.cnae_description || 'Atividade'}${selected.cnae_code ? ` (CNAE ${selected.cnae_code})` : ''}` : ''}{selected.registration_status ? ` · ${selected.registration_status}` : ''}</p>}
    {selected.type === 'PERSON_CITATION' && <p className="caution micro">Este nó representa uma ocorrência do nome no cadastro empresarial. Não confirma que seja o lead, a mesma pessoa de outro nó ou um familiar. Localidade e atividade descrevem a empresa.</p>}
    <p className="micro"><strong>Caminho selecionado:</strong> {path.nodes.map(key => nodeMap.get(key)?.label || '').join(' → ')}</p>
    {path.nodes.length === 1 && selected.type !== 'ROOT' && <p className="micro">Não há caminho ativo até o lead após aplicar as revisões deste dossiê.</p>}
    <div className="stack">{documents.map(document => {const url = httpsUrl(document.source_url); return <details key={document.id}><summary className="source-link">{document.title || 'Documento cadastral'} · {document.verification_status === 'VERIFIED' ? 'Documento verificado' : 'Documento exige revisão'}</summary><p className="micro">{document.source_label || 'Fonte cadastral'}{dateLabel(document.retrieved_at) ? ` · Consultado em ${dateLabel(document.retrieved_at)} (Brasília)` : ''}</p>{document.excerpt && <p style={{fontSize: 12, whiteSpace: 'pre-wrap'}}>{text(document.excerpt).slice(0, 3000)}</p>}{url && <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">Abrir fonte ↗</a>}</details>})}</div>
    {!documents.length && <p className="micro">Selecione uma empresa ou um nome citado para consultar seus documentos. A abertura separada exige documento verificado neste dossiê.</p>}
    {selectedType && <div className="actions section"><button type="button" className="btn secondary" disabled={readOnly || busy || expanding || !canOpen} onClick={() => void openSelected()}>{busy && !expanding ? 'Abrindo…' : 'Investigar separadamente'}</button></div>}
    {selectedType && !canOpen && <p className="micro">A investigação separada exige candidato ativo, nome/CNPJ compatível e documento verificado neste dossiê.</p>}
   </div>}
  </>}
 </section>
}
