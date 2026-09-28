export const normalizeCompanyId = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export function resolveCompanyCnpj(lead: {kind: string; initial_cnpj?: string}, requested: unknown, links: any[] = []) {
  const valid = (v: unknown) => /^[A-Z0-9]{12}[0-9]{2}$/.test(normalizeCompanyId(v));
  if (requested && !valid(requested)) throw new Error('Informe um CNPJ completo com 14 posições.');
  if (valid(requested)) return normalizeCompanyId(requested);
  if (valid(lead.initial_cnpj)) return normalizeCompanyId(lead.initial_cnpj);
  // Never choose one of a person's companies as their own identifier.
  if (lead.kind !== 'COMPANY') return '';
  const candidates = [...new Set(links.filter(l => l.status !== 'REJECTED').map(l => normalizeCompanyId(l.companies?.cnpj)).filter(valid))];
  if (candidates.length > 1) throw new Error('Há mais de uma empresa vinculada. Informe o CNPJ deste núcleo.');
  return candidates[0] || '';
}

export async function nodeLeadId(org: string, type: string, id: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`max-node-v1:${org}:${type}:${id}`)));
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes.slice(0,16)].map(b => b.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

