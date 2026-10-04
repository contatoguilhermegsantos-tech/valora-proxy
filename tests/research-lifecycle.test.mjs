import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickEnqueuedResearch, selectResearchJob, linkedResearchRun, researchOutcome,
  researchStepSummary, researchSourceUrl, inferResearchStrategy, researchHref,
} from '../lib/research-progress.ts';

const leadId = '10000000-0000-4000-8000-000000000001';
const otherLeadId = '10000000-0000-4000-8000-000000000002';
const jobId = '20000000-0000-4000-8000-000000000001';
const otherJobId = '20000000-0000-4000-8000-000000000002';
const runId = '30000000-0000-4000-8000-000000000001';
const orgId = '40000000-0000-4000-8000-000000000001';
const otherOrgId = '40000000-0000-4000-8000-000000000002';
const job = (changes = {}) => ({id: jobId, lead_id: leadId, organization_id: orgId,
  job_type: 'LEAD_RESEARCH', status: 'RUNNING', created_at: '2026-10-04T12:00:00Z', ...changes});
const run = (changes = {}) => ({id: runId, lead_id: leadId, organization_id: orgId,
  status: 'PARTIAL', research_steps: [], ...changes});

test('iniciar só é confirmado por um job criado ou já existente do lead solicitado', () => {
  assert.equal(pickEnqueuedResearch({ok: true, created: [job()]}, leadId).id, jobId);
  const repeated = pickEnqueuedResearch({ok: true, created: [], existing: [job()]}, leadId);
  assert.equal(repeated.id, jobId);
  assert.equal(repeated.lead_id, leadId);
  for (const response of [
    {ok: false, created: [job()]}, {ok: true, created: []},
    {ok: true, created: [job({id: 'invalid'})]},
    {ok: true, created: [job({lead_id: otherLeadId})]},
    {ok: true, existing: [job({job_type: 'COMPANY_RESEARCH'})]},
  ]) assert.throws(() => pickEnqueuedResearch(response, leadId));
});

test('seleção da execução preserva o job pedido e recusa outro lead, organização ou tipo', () => {
  const foreign = job({id: otherJobId, lead_id: otherLeadId});
  const differentOrg = job({id: otherJobId, organization_id: otherOrgId});
  const companyJob = job({id: otherJobId, job_type: 'COMPANY_RESEARCH'});
  for (const wrong of [foreign, differentOrg, companyJob]) {
    assert.equal(selectResearchJob([job(), wrong], leadId, otherJobId, orgId), null);
  }
  const completed = job({status: 'COMPLETED'});
  assert.equal(selectResearchJob([completed], leadId, jobId, orgId), completed);
  assert.equal(selectResearchJob([completed], leadId, null, orgId), null);
  assert.equal(selectResearchJob([job()], leadId, '50000000-0000-4000-8000-000000000001', orgId), null);
});

test('sem job explícito a execução ativa mais recente prevalece sem alterar a lista recebida', () => {
  const rows = [job(), job({id: otherJobId, status: 'RETRY', created_at: '2026-10-04T12:01:00Z'})];
  const original = [...rows];
  assert.equal(selectResearchJob(rows, leadId, null, orgId).id, otherJobId);
  assert.deepEqual(rows, original);
});

test('resultados exigem research_run_id explícito e correspondência de lead e organização', () => {
  const ownRun = run();
  const otherRun = run({id: '30000000-0000-4000-8000-000000000002'});
  assert.equal(linkedResearchRun(job(), [otherRun, ownRun], leadId, orgId), null);
  assert.equal(linkedResearchRun(job({progress: {research_run_id: runId}}), [ownRun], leadId, orgId), ownRun);
  assert.equal(linkedResearchRun(job({result: {research_run_id: runId}}), [ownRun], leadId, orgId), ownRun);
  assert.equal(linkedResearchRun(job({progress: {research_run_id: runId}}), [run({lead_id: otherLeadId})], leadId, orgId), null);
  assert.equal(linkedResearchRun(job({progress: {research_run_id: runId}}), [run({organization_id: otherOrgId})], leadId, orgId), null);
});

test('COMPLETED na fila não libera resultados ausentes, em andamento ou de execução errada', () => {
  const completed = job({status: 'COMPLETED', progress: {research_run_id: runId}});
  assert.equal(researchOutcome(completed, null), 'waiting_results');
  assert.equal(researchOutcome(completed, run({status: 'RUNNING'})), 'waiting_results');
  const mismatch = linkedResearchRun(completed, [run({id: otherJobId})], leadId, orgId);
  assert.equal(researchOutcome(completed, mismatch), 'waiting_results');
});

test('cobertura parcial continua parcial mesmo com processamento finalizado', () => {
  assert.equal(researchOutcome(job({status: 'COMPLETED'}), run()), 'partial');
  assert.equal(researchOutcome(job({status: 'COMPLETED', progress: {research_status: 'PARTIAL'}}), run({status: 'COMPLETED'})), 'partial');
  assert.equal(researchOutcome(job({status: 'COMPLETED', progress: {research_status: 'COMPLETED'}}), run({status: 'COMPLETED'})), 'completed');
});

test('falha e cancelamento têm saída própria; PENDING/RUNNING/RETRY continuam ativos', () => {
  assert.equal(researchOutcome(null, null), 'missing');
  assert.equal(researchOutcome(job({status: 'FAILED'}), run()), 'failed');
  assert.equal(researchOutcome(job({status: 'CANCELLED'}), run()), 'cancelled');
  assert.equal(researchOutcome(job({status: 'COMPLETED'}), run({status: 'FAILED'})), 'failed');
  for (const status of ['PENDING', 'RUNNING', 'RETRY']) assert.equal(researchOutcome(job({status}), null), 'active');
});

test('etapas bloqueadas ou parciais contam como encerradas sem fingir sucesso', () => {
  const states = ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'SKIPPED', 'PENDING', 'RUNNING'];
  const steps = states.map((status, i) => ({id: String(i), step_order: i + 1, title: 'Etapa', status}));
  assert.deepEqual(researchStepSummary(steps), {total: 7, settled: 5, completed: 1, partial: 1, blocked: 1,
    failed: 1, skipped: 1, running: 1, pending: 1});
  assert.equal(researchStepSummary([]).settled, 0);
});

test('links de fontes não executam conteúdo nem enviam credenciais embutidas', () => {
  assert.equal(researchSourceUrl('https://www.gov.br/receitafederal/'), 'https://www.gov.br/receitafederal/');
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'http://example.com', '//example.com',
    'https://user:password@example.com/', 'relative/path', null]) assert.equal(researchSourceUrl(url), null);
});

test('retomar e falhar ao enfileirar preservam o modo pesquisa e o id confirmado na URL', () => {
  const href = researchHref(leadId, jobId);
  const parsed = new URL(href, 'https://max.invalid');
  assert.equal(parsed.pathname, '/leads/' + leadId);
  assert.equal(parsed.searchParams.get('mode'), 'research');
  assert.equal(parsed.searchParams.get('job'), jobId);
  const failed = new URL(researchHref(leadId, 'invalid', true), 'https://max.invalid');
  assert.equal(failed.searchParams.get('job'), null);
  assert.equal(failed.searchParams.get('issue'), 'enqueue');
});

test('estratégia sugerida usa segmento e tipo sem atribuir identidade ou CNPJ', () => {
  assert.equal(inferResearchStrategy({kind: 'COMPANY', segment: null}), 'EMPRESARIO');
  assert.equal(inferResearchStrategy({kind: 'PERSON', segment: null}), 'GENERICO');
  assert.equal(inferResearchStrategy({kind: 'COMPANY', segment: 'Agrícola'}), 'AGRO');
  assert.equal(inferResearchStrategy({kind: 'PERSON', segment: 'Clínica médica'}), 'MEDICO');
});
