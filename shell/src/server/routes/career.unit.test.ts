import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repos } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { handleCareerRoute, type CareerRouteDeps } from './career';

const tempDirs: string[] = [];

function makeDeps(repos: Repos): CareerRouteDeps & { events: Array<{ event: string; data: unknown }> } {
  const events: Array<{ event: string; data: unknown }> = [];
  const dir = mkdtempSync(join(tmpdir(), 'career-route-'));
  tempDirs.push(dir);
  return {
    repos,
    events,
    broadcast: (event, data) => { events.push({ event, data }); },
    sessionId: () => 'sess-1',
    exportsDir: dir,
    llm: null,
  };
}

async function call(deps: CareerRouteDeps, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request(`http://local${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  const response = await handleCareerRoute(new URL(request.url).pathname, request, deps);
  if (!response) throw new Error(`route returned null for ${method} ${path}`);
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

describe('handleCareerRoute', () => {
  let repos: Repos;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    repos = createMemoryRepos();
    deps = makeDeps(repos);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    repos.db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-career and browser paths', async () => {
    expect(await handleCareerRoute('/api/other', new Request('http://local/api/other'), deps)).toBeNull();
    expect(await handleCareerRoute('/api/career/browser/state', new Request('http://local/api/career/browser/state'), deps)).toBeNull();
  });

  it('returns 404 JSON for unknown career paths', async () => {
    const r = await call(deps, 'GET', '/api/career/nope');
    expect(r.status).toBe(404);
    expect(r.json.ok).toBe(false);
  });

  it('GET /overview returns board, tasks, handoffs and pendingReview', async () => {
    const r = await call(deps, 'GET', '/api/career/overview');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.board).toMatchObject({ due: [], blocked: [], funnel: [], pendingReview: 0 });
    expect(r.json.tasks).toEqual([]);
    expect(r.json.openHandoffs).toEqual([]);
    expect(r.json.pendingReview).toBe(0);
  });

  it('experiences / claims / evidence / confirm round-trip and broadcast data-changed', async () => {
    const bad = await call(deps, 'POST', '/api/career/experiences', { role: 'x' });
    expect(bad.status).toBe(400);

    const exp = await call(deps, 'POST', '/api/career/experiences', { title: '字节实习', role: '后端', org: '字节', start_date: '2025-06', type: 'dev' });
    expect(exp.status).toBe(200);
    const experience = exp.json.experience as { id: string; type: string };
    expect(experience.type).toBe('dev');

    const claim = await call(deps, 'POST', '/api/career/claims', { experience_id: experience.id, text: '把接口 P99 从 800ms 降到 200ms', attribution: 'self', result_metric: 'P99 -75%' });
    expect(claim.status).toBe(200);
    const claimRow = claim.json.claim as { id: string; status: string };
    expect(claimRow.status).toBe('pending');

    const ev = await call(deps, 'POST', '/api/career/evidence', { claim_id: claimRow.id, kind: 'commit', locator: 'abc123', strength: 'strong' });
    expect(ev.status).toBe(200);

    const confirmed = await call(deps, 'POST', `/api/career/claims/${claimRow.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect((confirmed.json.claim as { status: string }).status).toBe('user_confirmed');

    const missing = await call(deps, 'POST', '/api/career/claims/clm_nope/confirm');
    expect(missing.status).toBe(404);

    const tree = await call(deps, 'GET', '/api/career/experiences');
    const experiences = tree.json.experiences as Array<{ claims: Array<{ evidence: unknown[] }> }>;
    expect(experiences).toHaveLength(1);
    expect(experiences[0].claims[0].evidence).toHaveLength(1);

    const changed = deps.events.filter(e => e.event === 'career:data-changed');
    expect(changed.length).toBeGreaterThanOrEqual(4);
    expect(changed[0].data).toMatchObject({ sessionId: 'sess-1', tables: ['experience'] });
  });

  it('jobs import + applications + board + stage transition', async () => {
    const empty = await call(deps, 'POST', '/api/career/jobs/import', {});
    expect(empty.status).toBe(400);

    const imported = await call(deps, 'POST', '/api/career/jobs/import', { jd_raw: '后端开发工程师\n负责……', company_name: '某司', source_platform: 'boss' });
    expect(imported.status).toBe(200);
    const job = imported.json.job as { id: string; title: string; source_platform: string };
    expect(job.title).toBe('后端开发工程师');
    expect(job.source_platform).toBe('boss');
    expect(imported.json.jd_parsed).toBeUndefined(); // llm: null → 不解析

    const app = repos.createApplication(job.id);
    const apps = await call(deps, 'GET', '/api/career/applications');
    const rows = apps.json.applications as Array<{ id: string; title: string; company_name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: app.id, title: '后端开发工程师', company_name: '某司' });

    const illegal = await call(deps, 'POST', `/api/career/applications/${app.id}/stage`, { to: 'hired' });
    expect(illegal.status).toBe(409);
    const badStage = await call(deps, 'POST', `/api/career/applications/${app.id}/stage`, { to: 'nonsense' });
    expect(badStage.status).toBe(400);

    const moved = await call(deps, 'POST', `/api/career/applications/${app.id}/stage`, { to: 'ready', note: '评分 80' });
    expect(moved.status).toBe(200);
    expect((moved.json.application as { stage: string }).stage).toBe('ready');

    const board = await call(deps, 'GET', '/api/career/board');
    expect(board.status).toBe(200);
    expect((board.json.board as { funnel: Array<{ stage: string; n: number }> }).funnel).toEqual([{ stage: 'ready', n: 1 }]);
  });

  it('actions review approves pending items and reports n', async () => {
    const a1 = repos.enqueueAction('submit', { x: 1 });
    const a2 = repos.enqueueAction('send_greeting', { text: 'hi' });
    expect(a1.status).toBe('pending_review');

    const pending = await call(deps, 'GET', '/api/career/actions?status=pending_review');
    expect((pending.json.actions as unknown[]).length).toBe(2);

    const badDecision = await call(deps, 'POST', '/api/career/actions/review', { ids: [a1.id], decision: 'maybe' });
    expect(badDecision.status).toBe(400);

    const reviewed = await call(deps, 'POST', '/api/career/actions/review', { ids: [a1.id, a2.id, 'act_missing'], decision: 'approved' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.json.n).toBe(2);
    expect(repos.getAction(a1.id)?.status).toBe('approved');
    expect(deps.events.at(-1)).toMatchObject({ event: 'career:data-changed', data: { tables: ['action_queue'] } });
  });

  it('handoffs list + close', async () => {
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const handoff = repos.openHandoff('captcha', { taskId: task.id, message: '需要验证码' });

    const open = await call(deps, 'GET', '/api/career/handoffs');
    expect((open.json.handoffs as Array<{ id: string }>).map(h => h.id)).toEqual([handoff.id]);

    const closed = await call(deps, 'POST', `/api/career/handoffs/${handoff.id}/close`, { resumed_from_step: 'step-3' });
    expect(closed.status).toBe(200);
    expect((closed.json.handoff as { resumed_from_step: string }).resumed_from_step).toBe('step-3');
    expect(repos.getTask(task.id)?.status).toBe('running');

    const again = await call(deps, 'POST', '/api/career/handoffs/hnd_missing/close', {});
    expect(again.status).toBe(404);
  });

  it('resumes: master create, save with snapshot, export 501 when domain lib missing', async () => {
    const created = await call(deps, 'POST', '/api/career/resumes/master', { name: '母版', schema_json: { basics: { name: '张三' } } });
    expect(created.status).toBe(200);
    const master = created.json.master as { id: string };

    const saved = await call(deps, 'PUT', `/api/career/resumes/${master.id}`, { schema_json: { basics: { name: '张三', email: 'a@b.c' } } });
    expect(saved.status).toBe(200);
    expect(repos.db.all('SELECT * FROM resume_snapshot WHERE resume_id=?', [master.id])).toHaveLength(1);

    const list = await call(deps, 'GET', '/api/career/resumes');
    expect((list.json.masters as unknown[]).length).toBe(1);

    const unavailable = await call({ ...deps, resumeModule: () => Promise.reject(new (class extends Error { name = 'DomainUnavailableError'; })('x')) }, 'POST', `/api/career/resumes/${master.id}/export`, { format: 'pdf' });
    expect([500, 501]).toContain(unavailable.status);

    const badFormat = await call(deps, 'POST', `/api/career/resumes/${master.id}/export`, { format: 'txt' });
    expect(badFormat.status).toBe(400);

    const notFound = await call(deps, 'POST', '/api/career/resumes/rsm_missing/export', { format: 'pdf' });
    expect(notFound.status).toBe(404);
  });

  it('interviews / directions / offers / answer-bank basic CRUD', async () => {
    const itv = await call(deps, 'POST', '/api/career/interviews', { company_name: 'A', round: 'first', tags_json: ['算法'] });
    expect(itv.status).toBe(200);
    const interview = itv.json.interview as { id: string; tags_json: string };
    expect(JSON.parse(interview.tags_json)).toEqual(['算法']);
    const upd = await call(deps, 'PUT', `/api/career/interviews/${interview.id}`, { result: 'advanced', result_source: 'official', retro_json: { ok: 1 } });
    expect((upd.json.interview as { result: string }).result).toBe('advanced');

    const dirs = await call(deps, 'GET', '/api/career/directions');
    expect(dirs.json.directions).toEqual([]);
    const badStatus = await call(deps, 'POST', '/api/career/directions/dir_x/status', { status: 'nope' });
    expect(badStatus.status).toBe(400);

    const offer = await call(deps, 'POST', '/api/career/offers', { company_name: 'B', title: '算法', comp_json: { base: 30 } });
    const offerRow = offer.json.offer as { id: string };
    const offerUpd = await call(deps, 'PUT', `/api/career/offers/${offerRow.id}`, { location: '上海' });
    expect((offerUpd.json.offer as { location: string }).location).toBe('上海');

    const ans = await call(deps, 'POST', '/api/career/answer-bank', { question_key: 'salary', question_text: '期望薪资', answer: '面议', high_impact: true });
    expect(ans.status).toBe(200);
    const bank = await call(deps, 'GET', '/api/career/answer-bank');
    expect((bank.json.answers as Array<{ high_impact: number }>)[0].high_impact).toBe(1);
  });
});
