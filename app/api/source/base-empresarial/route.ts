import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SOURCE = 'https://app.baseempresarial.com.br/api/v1'
const DEFAULT_URL = 'https://dczropngwfoxybdmybgw.supabase.co'
const DEFAULT_KEY = 'sb_publishable_Y65sof58bUDmppRbUwwV4g_yraQyqy3'
const WRITE_ROLES = new Set(['OWNER', 'ADMIN', 'ANALYST', 'MEMBER'])

function result(body: unknown, status: number, retryAfter?: string) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
  if (retryAfter) headers['Retry-After'] = retryAfter
  return Response.json(body, { status, headers })
}

async function limitedJson(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new Error('INVALID_RESPONSE')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('RESPONSE_TOO_LARGE')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

export async function POST(req: Request) {
  const authorization = req.headers.get('authorization') || ''
  if (!/^Bearer \S+$/i.test(authorization)) return result({ ok: false, error: 'UNAUTHORIZED' }, 401)
  const token = authorization.slice(7)
  try {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_URL,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY, {
        global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    const { data: auth, error: authError } = await db.auth.getUser(token)
    if (authError || !auth.user) return result({ ok: false, error: 'UNAUTHORIZED' }, 401)
    const { data: profile, error: profileError } = await db.from('profiles').select('active_organization_id').eq('id', auth.user.id).maybeSingle()
    if (profileError) return result({ ok: false, error: 'AUTH_CHECK_FAILED' }, 503)
    if (!profile?.active_organization_id) return result({ ok: false, error: 'FORBIDDEN' }, 403)
    const { data: member, error: memberError } = await db.from('organization_members').select('role,status')
      .eq('organization_id', profile.active_organization_id).eq('user_id', auth.user.id).maybeSingle()
    if (memberError) return result({ ok: false, error: 'AUTH_CHECK_FAILED' }, 503)
    if (member?.status !== 'ACTIVE' || !WRITE_ROLES.has(member.role)) return result({ ok: false, error: 'FORBIDDEN' }, 403)
  } catch {
    return result({ ok: false, error: 'AUTH_CHECK_FAILED' }, 503)
  }

  let body: Record<string, unknown>
  try {
    body = await limitedJson(req.body, 2048)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_REQUEST')
  } catch { return result({ ok: false, error: 'INVALID_REQUEST' }, 400) }
  let path: string
  const timeout = body.timeout_ms === undefined ? 15000 : body.timeout_ms
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000 || timeout > 15000) return result({ ok: false, error: 'INVALID_TIMEOUT' }, 400)
  if (body.operation === 'companies_search') {
    if (Object.keys(body).some(key => !['operation', 'city_id', 'page', 'timeout_ms'].includes(key)) ||
      typeof body.city_id !== 'string' || !/^\d{7}$/.test(body.city_id) ||
      typeof body.page !== 'number' || !Number.isInteger(body.page) || body.page < 1 || body.page > 10000) return result({ ok: false, error: 'INVALID_REQUEST' }, 400)
    path = `/companies/search?city_id=${body.city_id}&per_page=100&sort=id&page=${body.page}`
  } else if (body.operation === 'company_detail') {
    if (Object.keys(body).some(key => !['operation', 'basic_cnpj', 'timeout_ms'].includes(key)) ||
      typeof body.basic_cnpj !== 'string' || !/^[A-Z0-9]{8}$/.test(body.basic_cnpj)) return result({ ok: false, error: 'INVALID_REQUEST' }, 400)
    path = `/companies/${body.basic_cnpj}`
  } else return result({ ok: false, error: 'INVALID_OPERATION' }, 400)

  try {
    const source = await fetch(SOURCE + path, { headers: { Accept: 'application/json', 'User-Agent': 'MAX-Intelligence/1.0' },
      signal: AbortSignal.timeout(timeout), redirect: 'error', cache: 'no-store' })
    if (!source.ok) {
      const rawRetry = source.headers.get('retry-after') || ''
      const retryAfter = rawRetry.length <= 100 && (/^\d{1,8}$/.test(rawRetry) || Number.isFinite(Date.parse(rawRetry))) ? rawRetry : undefined
      await source.body?.cancel().catch(() => {})
      return result({ ok: false, error: `SOURCE_HTTP_${source.status}` }, source.status >= 400 ? source.status : 502, retryAfter)
    }
    const data = await limitedJson(source.body, 1024 * 1024)
    const valid = body.operation === 'companies_search' ? Array.isArray(data?.data) : data?.data && typeof data.data === 'object' && !Array.isArray(data.data)
    if (!valid) return result({ ok: false, error: 'INVALID_SOURCE_RESPONSE' }, 502)
    return result(data, 200)
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    return result({ ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE' }, name === 'TimeoutError' || name === 'AbortError' ? 504 : 502)
  }
}
