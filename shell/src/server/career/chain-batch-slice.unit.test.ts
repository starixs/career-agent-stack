/**
 * 链路切面「定制好 → 批量投出」（世界模型 §6 立场 9；用户 2026-10-30「你这个框选一堆，然后你就直接确认」）。
 *
 * 从用户视角走一遍：岗位表上框选 7 行（2 家标星、1 家投过、1 家没链接）→ 一条确认（几家开始、跳过原因、用哪份简历一次问完）
 * →「开始投」后不用再去别处点「开始」，后台运行器接走 → 等你条里只有要他做的：登录一件、缺信息一件、填好的合成「一键投出」。
 * 每一步只按按钮，不在对话里打字。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Repos } from '@career/core';

import { handleCareerRoute } from '../routes/career';
import { handleCareerSessionRoute } from '../routes/career-session';
import { applyabilityOf, recordApplyability } from './applyability';
import { applyJobs, planJobs, prepareAhead } from './batch-apply';
import { setJobPrefs } from './job-board';
import { BATCH_COMMAND_KEY } from './batch-runner';
import { loadCore } from './core-module';
import { asksFor } from './delivery';
import { prepareJobs } from './job-board';
import { CareerStore } from './store';
import { setTargetJob } from './targets';
import { createMemoryRepos } from './test-db';

const core = await loadCore();
const STARS = ['美团', '京东'];
const WIDE = ['DeepSeek', '中兴通讯', '大疆'];

describe('链路 · 框选一批、确认投出', () => {
  let dir: string;
  let repos: Repos;
  let store: CareerStore;
  let deps: Parameters<typeof applyJobs>[0];
  const jobOf = (c: string) => repos.listJobs().find(j => j.company_name === c)!;
  const appOf = (c: string) => repos.listApplications().find(a => a.job_id === jobOf(c).id)!;
  const actionOf = (c: string) => repos.listActions().find(a => a.application_id === appOf(c).id && a.kind === 'fill_form')!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'career-chain-'));
    repos = createMemoryRepos();
    store = new CareerStore(repos, core);
    deps = { repos, store, exportsDir: dir, exportPdf: async id => { const p = join(dir, `${id}.pdf`); writeFileSync(p, `%PDF ${id}`); return p; } };
    for (const c of [...STARS, ...WIDE, '拼多多', '小公司']) {
      const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${c}`, title: 'AI应用开发', company_name: c, url: c === '小公司' ? null : `https://jobs.${c}.test/apply` });
      if (STARS.includes(c)) setTargetJob(repos, job.id, true);
    }
    repos.jumpTo(repos.createApplication(jobOf('拼多多').id).id, 'applied', '上周投过');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('确认前一条说清：5 家开始（2 家标星），投过的和没链接的跳过并说原因；两份主简历时只问一次用哪份', () => {
    store.createResumeMaster({ name: 'AI 方向', schema_json: { basics: {} } });
    store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } });
    const plan = planJobs(repos, store, repos.listJobs().map(j => j.id));
    expect(plan.ready).toHaveLength(5);
    expect(plan.targets).toBe(2);
    expect(plan.skipped.map(s => s.reason).sort()).toEqual(['已经投过', '没写怎么投']);
    expect(plan.needs_resume).toHaveLength(5);
    expect(plan.resumes.map(r => r.name).sort()).toEqual(['AI 方向', '通用版']);
  });

  it('「开始投」一次：5 家直接批准并交后台运行器，等你条里没有「等你说开始」；投过的那家不会再投一次', async () => {
    const [ai] = [store.createResumeMaster({ name: 'AI 方向', schema_json: { basics: {} } }), store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } })];
    const res = await applyJobs(deps, repos.listJobs().map(j => j.id), ai.id);
    expect(res.started).toHaveLength(5);
    expect(res.skipped.map(s => s.reason).sort()).toEqual(['已经投过', '没写怎么投']);
    expect(repos.listActions('approved').filter(a => a.kind === 'fill_form')).toHaveLength(5);
    expect(repos.kvGet<{ cmd: string; ids: string[] }>(BATCH_COMMAND_KEY)).toMatchObject({ cmd: 'run', ids: res.started });
    expect(asksFor(repos).map(a => a.kind)).not.toContain('start');
    expect(repos.listApplications().filter(a => a.job_id === jobOf('拼多多').id)).toHaveLength(1);
    expect(JSON.parse(actionOf('大疆').payload_json)).toMatchObject({ resume_id: ai.id });
  });

  it('后台填到一半：两家要登录合成一件；海投三家填好过检查合成「一键投出」，标星的仍一家一件', async () => {
    store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } });
    await applyJobs(deps, repos.listJobs().map(j => j.id));
    for (const c of ['美团', '京东']) repos.openHandoff('login', { actionId: actionOf(c).id });
    const review = { requiredFilled: 8, requiredTotal: 8, rows: [] };
    for (const c of WIDE) repos.enqueueAction('submit', { review }, appOf(c).id);
    const kinds = asksFor(repos).map(a => [a.kind, a.title]);
    expect(kinds).toContainEqual(['login', '2 个网站要你登录']);
    expect(kinds).toContainEqual(['review', '3 家填好了']);
    expect(kinds.filter(([k]) => k === 'start')).toEqual([]);
  });

  it('对话 / 等你条里点「都开始投」：同样交后台运行器，前端不用再叫助理逐份 apply_run', async () => {
    store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } });
    const results = await prepareJobs(deps, [jobOf('大疆').id]);
    const start = asksFor(repos).find(a => a.kind === 'start')!;
    expect(start.title).toBe('1 家等你说开始');
    const req = new Request('http://local/api/career-session/review', { method: 'POST', body: JSON.stringify({ actionIds: start.sources.map(s => s.id), decision: 'approved' }), headers: { 'Content-Type': 'application/json' } });
    await handleCareerSessionRoute('/api/career-session/review', req, { repos, broadcast: () => undefined, sessionId: () => 's1' });
    expect(repos.kvGet<{ cmd: string; ids: string[] }>(BATCH_COMMAND_KEY)).toMatchObject({ cmd: 'run', ids: [results[0].action_id] });
  });

  it('投前过目「先不投 → 这家不投了」：拒绝这次提交、申请标成跳过，等你条里这件消失，不叫助理问下一步', async () => {
    store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } });
    await applyJobs(deps, [jobOf('美团').id]);
    const submit = repos.enqueueAction('submit', { review: { requiredFilled: 8, requiredTotal: 8, rows: [] } }, appOf('美团').id);
    const req = new Request('http://local/api/career/actions/review', { method: 'POST', body: JSON.stringify({ ids: [submit.id], decision: 'rejected', drop: true }), headers: { 'Content-Type': 'application/json' } });
    await handleCareerRoute('/api/career/actions/review', req, { repos, broadcast: () => undefined, sessionId: () => 'global', llm: null });
    expect(repos.getAction(submit.id)!.status).toBe('rejected');
    expect(repos.getApplication(appOf('美团').id)!.stage).toBe('skip');
    expect(asksFor(repos).flatMap(a => a.application_ids)).not.toContain(appOf('美团').id);
  });

  it('岗位库里的岗位一律能选能投：引擎上次没找到表单的也不跳过、不打标给你看，只记下来给工程排查（用户 10-30：投不了是我们的问题）', () => {
    store.createResumeMaster({ name: '通用版', schema_json: { basics: {} } });
    const fill = (c: string) => ({ payload_json: JSON.stringify({ job_id: jobOf(c).id, url: jobOf(c).url }) });
    recordApplyability(repos, fill('DeepSeek'), { status: 'blocked', message: '页面上没有可填写的表单字段' });
    recordApplyability(repos, fill('美团'), { status: 'handoff', reason: 'login', message: '需要登录' });
    recordApplyability(repos, fill('大疆'), { status: 'stopped_before_submit', message: '已填完' });
    recordApplyability(repos, fill('京东'), { status: 'handoff', reason: 'captcha', message: '验证码' }); // 判断不了：不记
    const plan = planJobs(repos, store, ['DeepSeek', '美团', '大疆', '京东'].map(c => jobOf(c).id));
    expect(plan.ready).toHaveLength(4);
    expect(plan.skipped).toEqual([]);
    expect(['DeepSeek', '美团', '大疆', '京东'].map(c => applyabilityOf(repos, jobOf(c).id))).toEqual(['no_form', 'login', 'form', 'unknown']);
  });

  it('预准备：方向定了、简历在，他点头之后后台把对得上的几家备到提交前；没方向不备，投过的不备', async () => {
    store.createResumeMaster({ name: 'AI 方向', schema_json: { basics: {} } });
    expect(await prepareAhead(deps)).toEqual([]);
    setJobPrefs(repos, { keywords: ['AI'] });
    const started = await prepareAhead(deps, 3);
    expect(started).toHaveLength(3);
    expect(started.every(id => repos.getAction(id)!.approved_by === 'system')).toBe(true);
    expect(repos.kvGet<{ ids?: string[] }>(BATCH_COMMAND_KEY)?.ids).toEqual(started);
    const prepared = new Set(started.map(id => repos.getAction(id)!.application_id));
    expect(prepared.has(appOf('拼多多').id)).toBe(false);
    // 已经在备的算数：不会一口气越备越多
    expect(await prepareAhead(deps, 3)).toEqual([]);
  });
});
