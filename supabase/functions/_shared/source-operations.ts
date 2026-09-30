export const normalizeCity = (v: unknown) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function selectTerritory(candidates: any[], name: string, state: string) {
  const matches = candidates.filter(c => normalizeCity(c.territory_name || c.name || c.city_name) === normalizeCity(name)
    && (!state || String(c.state_code || c.state || '').toUpperCase() === state.toUpperCase()));
  const unique = [...new Map(matches.filter(c => c.territory_id || c.id).map(c => [String(c.territory_id || c.id), c])).values()];
  return { city: unique.length === 1 ? unique[0] : null, ambiguous: unique.length > 1 };
}

// Each request has a deadline. Retry transient failures once, never authentication or invalid JSON.
export async function fetchSourceJson(url: string, valid: (value: any) => boolean, options: { fetcher?: typeof fetch; timeoutMs?: number; headers?: Record<string,string>; wait?: (ms: number) => Promise<void> } = {}) {
  const fetcher = options.fetcher || fetch;
  const wait = options.wait || ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let result: { ok: boolean; status: number | null; data: any; error: string | null } = { ok: false, status: null, data: null, error: 'NETWORK_ERROR' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, { headers: { Accept: 'application/json', ...options.headers }, signal: AbortSignal.timeout(options.timeoutMs || 8000) });
      if (response.ok) {
        let data: any;
        try { data = await response.json(); } catch { return { ok: false, status: response.status, data: null, error: 'INVALID_RESPONSE' }; }
        return valid(data) ? { ok: true, status: response.status, data, error: null } : { ok: false, status: response.status, data: null, error: 'INVALID_RESPONSE' };
      }
      result = { ok: false, status: response.status, data: null, error: 'HTTP_' + response.status };
      await response.body?.cancel();
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) return result;
      // Long rate limits belong to a later run; don't hold the caller or hammer the source.
      const retryHeader = response.headers.get('Retry-After') || '0';
      const retryAfter = /^\d+$/.test(retryHeader) ? Number(retryHeader) : Math.max(0,(Date.parse(retryHeader)-Date.now())/1000)||0;
      if (retryAfter > 2) return result;
      if (!attempt) await wait(Math.max(500, retryAfter * 1000));
    } catch (e) {
      result = { ok: false, status: null, data: null, error: e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name) ? 'TIMEOUT' : 'NETWORK_ERROR' };
      if (!attempt) await wait(500);
    }
  }
  return result;
}

export function searchOutcome(completed: number, failed: number, mentions: number) {
  if (!completed) return 'QUERY_FAILED';
  if (failed) return 'PARTIAL';
  return mentions ? 'MENTIONS_FOUND' : 'NO_MENTIONS';
}

export function advanceCoverage(previous: string, dates: { target_date: string; status: string }[]) {
  let current = previous;
  const completed = new Set(dates.filter(d => d.status === 'DONE').map(d => d.target_date));
  for (let i = 0; i < dates.length; i++) {
    const next = new Date(current + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    const day = next.toISOString().slice(0, 10);
    if (!completed.has(day)) break;
    current = day;
  }
  return current;
}

export function summarizeSourceHealth(logs: any[]) {
  const grouped = new Map<string, any[]>();
  for (const log of logs) {
    const group = grouped.get(log.source_registry_id) || [];
    group.push(log); grouped.set(log.source_registry_id, group);
  }
  return [...grouped].map(([source_id, entries]) => {
    entries.sort((a, b) => String(b.queried_at).localeCompare(String(a.queried_at)));
    const latest = entries[0];
    // Old connector conflated network failure with missing coverage. Do not present it as confirmed.
    const inconclusive = (e: any) => e.result_status === 'CITY_NOT_COVERED';
    const contextual = (e: any) => ['CITY_NOT_COVERED_CONFIRMED', 'CITY_REQUIRED', 'CITY_AMBIGUOUS', 'NO_SEARCH_TERMS'].includes(e.result_status);
    return {
      source_id, attempts: entries.length,
      failures: entries.filter(e => !e.success && !inconclusive(e) && !contextual(e)).length,
      inconclusive: entries.filter(inconclusive).length,
      latest_at: latest.queried_at, latest_result: latest.result_status,
      health: inconclusive(latest) ? 'INCONCLUSIVE' : contextual(latest) ? 'CONTEXT_REQUIRED' : latest.success ? 'RESPONDING' : 'FAILURE',
      average_ms: Math.round(entries.reduce((sum, e) => sum + Number(e.duration_ms || 0), 0) / entries.length),
    };
  });
}
