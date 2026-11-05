import { describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { BatchRunner, BATCH_COMMAND_KEY, type DriveRequest } from './batch-runner';
import { createMemoryRepos } from './test-db';

// 批量运行器：队列顺序、落库、接管等待交回后续跑、暂停 / 停止、每日上限、风控跳过。drive 用桩。

type Ev = Record<string, unknown>;
/** 停在提交前默认带一份全部过关的填后检查（没过门槛的情况在 submit.unit.test.ts 里测）。 */
const PASSING_REVIEW = { rows: [{ label: '姓名', required: true, status: 'ok' }], attention: 0, requiredTotal: 1, requiredFilled: 1 };
const result = (status: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'result', op: 'drive', result: { status, message: status, finalUrl: 'https://x.com/p', adapterId: 'generic', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'], ...(status === 'stopped_before_submit' ? { review: PASSING_REVIEW } : {}), ...extra } });

function seed(repos: Repos, n: number, host = 'x.com') {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j${host}${i}`, title: `岗位 ${i}`, company_name: `公司 ${i}`, url: `https://${host}/apply/${i}` });
    const app = repos.createApplication(job.id);
    repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved');
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, application_id: app.id }, app.id);
    repos.reviewActions([action.id], 'approved');
    ids.push(action.id);
  }
  return ids;
}

function makeRunner(repos: Repos, script: (req: DriveRequest) => Ev[], opts: Partial<ConstructorParameters<typeof BatchRunner>[0]> = {}) {
  const events: Array<{ event: string; data: unknown }> = [];
  const calls: DriveRequest[] = [];
  const runner = new BatchRunner({
    repos,
    drive: async (req, onEvent) => { calls.push(req); const evs = script(req); for (const e of evs) onEvent(e); return evs; },
    control: () => 'agent',
    broadcast: (event, data) => events.push({ event, data }),
    // 等待态每轮都会 idle(poll)：用真实但很短的 sleep，避免空转刷爆事件数组
    sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))), pollMs: 5, pacingMs: [0, 0], ...opts,
  });
  return { runner, events, calls };
}

const settle = () => new Promise(r => setTimeout(r, 30));

describe('BatchRunner', () => {
  it('按顺序跑完队列：每份 stopped_before_submit → submit 进待审、计数 +1、队列清空后变 idle', async () => {
    const repos = createMemoryRepos();
    const ids = seed(repos, 3);
    const { runner, calls, events } = makeRunner(repos, () => [result('stopped_before_submit', { submitButton: '提交' })]);
    runner.start();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    const s = runner.state();
    expect(s.status).toBe('idle'); expect(s.done).toBe(3); expect(s.queued).toBe(0); expect(s.todayCount).toBe(3);
    expect(calls.map(c => c.action.id)).toEqual(ids);
    expect(calls.every(c => c.mode === 'start')).toBe(true);
    expect(repos.listActions('pending_review').filter(a => a.kind === 'submit')).toHaveLength(3);
    expect(events.some(e => e.event === 'career:review')).toBe(true);
    expect(events.filter(e => e.event === 'career:batch').length).toBeGreaterThan(3);
  });

  it('岗位链接是聚合站（offerseek.ai）：不打开去填，记失败，不开「缺信息」接管（2026-11-05 上汽集团）', async () => {
    const repos = createMemoryRepos();
    const [id] = seed(repos, 1, 'offerseek.ai');
    const { runner, calls } = makeRunner(repos, () => [result('stopped_before_submit', { submitButton: '提交' })]);
    await runner.runOne(repos.getAction(id)!, 'start');
    expect(calls).toHaveLength(0);
    expect(repos.getAction(id)?.status).toBe('failed');
    expect(repos.openHandoffs()).toHaveLength(0);
  });

  it('托管浏览器起不来（扩展没连上）：不判这家失败，放回队列，整批歇一会再试（2026-11-05 实测 30 份因此判失败）', async () => {
    const repos = createMemoryRepos();
    const [id] = seed(repos, 1);
    const { runner } = makeRunner(repos, () => [{ type: 'error', status: 500, error: 'BROWSER_PREPARATION_FAILED（HTTP 500）' }]);
    const out = await runner.runOne(repos.getAction(id)!, 'start');
    expect(out.kind).toBe('transient');
    expect(repos.getAction(id)?.status).toBe('approved');
  });

  it('接管：停下等用户，交回（handoff 被关闭）后以 continue 模式从当前页续跑', async () => {
    const repos = createMemoryRepos();
    const [id] = seed(repos, 1);
    let round = 0;
    const { runner, calls, events } = makeRunner(repos, () => (round++ === 0 ? [result('handoff', { reason: 'captcha', userAction: '请拖动滑块' })] : [result('stopped_before_submit')]));
    runner.start();
    for (let i = 0; i < 50 && repos.openHandoffs().length === 0; i++) await settle();
    expect(repos.getAction(id)!.status).toBe('needs_user');
    expect(runner.state().phase).toBe('waiting_user');
    expect(events.some(e => e.event === 'career:takeover' && (e.data as { state: string }).state === 'paused')).toBe(true);
    // 用户交回：关闭 handoff
    repos.closeHandoff(repos.openHandoffs()[0].id, 'handback');
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(calls.map(c => c.mode)).toEqual(['start', 'continue']);
    expect(calls[1].payload.url).toBeDefined(); // payload 原样；url 不加到请求体由 drive 适配层决定
    expect(repos.getAction(id)!.status).toBe('done');
    expect(runner.state().handoffs).toBe(1);
    expect(repos.listTasks().filter(t => t.kind === 'apply')).toHaveLength(1);
  });

  it('暂停：当前这份填完就停；再 start 续跑；stop 立即结束', async () => {
    const repos = createMemoryRepos();
    seed(repos, 3);
    const { runner, calls } = makeRunner(repos, () => [result('stopped_before_submit')], { pacingMs: [40, 40], sleep: ms => new Promise(r => setTimeout(r, ms)) });
    runner.start();
    await settle();
    runner.pause();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(runner.state().status).toBe('paused');
    const after = calls.length;
    expect(after).toBeGreaterThanOrEqual(1);
    runner.start();
    await settle();
    runner.stop();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(runner.state().status).toBe('stopped');
    expect(calls.length).toBeGreaterThanOrEqual(after);
  });

  it('风控锁住的平台先跳过；失败 → 投递 blocked；剩下的都在锁着的平台上就等', async () => {
    const repos = createMemoryRepos();
    seed(repos, 1, 'locked.com'); const [free] = seed(repos, 1, 'free.com');
    const { runner, calls } = makeRunner(repos, () => [{ type: 'error', status: 500, error: '渲染进程崩了' }], { riskLocked: p => p === 'locked.com' });
    runner.start();
    // 失败一次会自动再试一次：等两次都跑完
    for (let i = 0; i < 50 && (calls.length < 2 || repos.getAction(free)!.status !== 'failed'); i++) await settle();
    expect(calls.map(c => c.action.id)).toEqual([free, free]);
    expect(repos.getAction(free)!.status).toBe('failed');
    expect(runner.state().failed).toBe(2);
    for (let i = 0; i < 50 && runner.state().phase !== 'rate_locked'; i++) await settle();
    expect(runner.state().phase).toBe('rate_locked');
    runner.stop();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
  });

  it('填表失败：自动再试一次；再失败不再试，进等你「1 家没填成」', async () => {
    const repos = createMemoryRepos();
    const [id] = seed(repos, 1);
    const { runner, calls } = makeRunner(repos, () => [{ type: 'error', status: 500, error: 'page.goto: Timeout 30000ms exceeded' }]);
    runner.start();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(calls.map(c => c.action.id)).toEqual([id, id]);
    expect(repos.getAction(id)!.status).toBe('failed');
    const { asksFor } = await import('./delivery');
    const failed = asksFor(repos).filter(a => a.kind === 'failed');
    expect(failed).toEqual([expect.objectContaining({ title: '1 家没填成', detail: '页面一直没打开', action_ids: [id] })]);
  });

  it('没有每日上限：今天已经投了 100 份，队列里的照样开始填（用户 2026-10-30「不要做上限」）', async () => {
    const repos = createMemoryRepos();
    const d = new Date();
    repos.kvSet(`apply:batch:count:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, 100);
    const [a] = seed(repos, 1, 'next.com');
    const { runner, calls } = makeRunner(repos, () => [{ type: 'result', status: 'stopped_before_submit', review: { rows: [], attention: 0, requiredTotal: 0, requiredFilled: 0 } }]);
    runner.start();
    for (let i = 0; i < 50 && calls.length === 0; i++) await settle();
    expect(calls[0]?.action.id).toBe(a);
    runner.stop();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
  });

  it('run（批准即填）：只填指定的那几份，其他已批准的不动；暂停的批量填完仍是暂停', async () => {
    const repos = createMemoryRepos();
    const [a, b, c] = seed(repos, 3);
    const { runner, calls } = makeRunner(repos, () => [result('stopped_before_submit')]);
    runner.start(); runner.pause();
    // pause() 立刻把状态写成 paused，但正在填的那份要填完循环才退出（退出时写"已暂停"）
    for (let i = 0; i < 50 && runner.state().message !== '已暂停'; i++) await settle();
    const before = calls.length;
    const left = [a, b, c].filter(id => repos.getAction(id)!.status === 'approved');
    expect(left.length).toBeGreaterThanOrEqual(2);
    runner.run([left[1]]);
    expect(runner.state().only).toEqual([left[1]]);
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(calls.slice(before).map(x => x.action.id)).toEqual([left[1]]);
    expect(repos.getAction(left[0])!.status).toBe('approved');
    const s = runner.state();
    expect(s.status).toBe('paused'); expect(s.only).toBeUndefined(); expect(s.queued).toBe(left.length - 1);
  });

  it('run：全量批量正在跑时不改变它；空闲时填完回到 idle', async () => {
    const repos = createMemoryRepos();
    const [a, b] = seed(repos, 2);
    const { runner, calls } = makeRunner(repos, () => [result('stopped_before_submit')]);
    runner.run([b]);
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(calls.map(x => x.action.id)).toEqual([b]);
    expect(runner.state().status).toBe('idle');
    expect(repos.getAction(a)!.status).toBe('approved');
  });

  it('run 命令合并：轮询前连续批准几份不会互相覆盖；已有全量 start 不被降级', () => {
    const repos = createMemoryRepos();
    BatchRunner.command(repos, 'run', 'approval', ['x']);
    BatchRunner.command(repos, 'run', 'approval', ['y', 'x']);
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toMatchObject({ cmd: 'run', ids: ['x', 'y'] });
    BatchRunner.command(repos, 'start', 'user');
    BatchRunner.command(repos, 'run', 'approval', ['z']);
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toMatchObject({ cmd: 'start' });
  });

  it('run 模式中途重启：只续原来那几份，不放大成全量', async () => {
    const repos = createMemoryRepos();
    const [a, b] = seed(repos, 2);
    repos.kvSet('apply:batch:state', { status: 'running', updatedAt: new Date().toISOString(), done: 0, failed: 0, handoffs: 0, queued: 0, todayCount: 0, only: [b], resumeTo: 'paused' });
    const { runner, calls } = makeRunner(repos, () => [result('stopped_before_submit')]);
    runner.resumeIfRunning();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(calls.map(x => x.action.id)).toEqual([b]);
    expect(runner.state().status).toBe('paused');
    expect(repos.getAction(a)!.status).toBe('approved');
  });

  it('kv 命令：任何进程写 apply:batch:command，运行器轮询执行', async () => {
    const repos = createMemoryRepos();
    const { runner } = makeRunner(repos, () => [result('stopped_before_submit')]);
    BatchRunner.command(repos, 'start', 'assistant');
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toMatchObject({ cmd: 'start' });
    const c = runner.pollCommand();
    expect(c?.cmd).toBe('start');
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toBeNull();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(runner.state().status).toBe('idle');
  });

  it('浏览器已关闭（App 重启 / 被回收）：等待中的接管作废，动作重新排队、从岗位网址重新打开', async () => {
    const repos = createMemoryRepos();
    const [id] = seed(repos, 1);
    let browserOpen = true;
    let round = 0;
    const { runner, calls } = makeRunner(repos, () => {
      round++;
      return round === 1
        ? [result('handoff', { reason: 'captcha', userAction: '请过一下验证' })]
        : [result('stopped_before_submit', { submitButton: '提交' })];
    }, { hasBrowser: () => browserOpen });
    runner.start();
    for (let i = 0; i < 50 && runner.state().phase !== 'waiting_user'; i++) await settle();
    expect(runner.state().phase).toBe('waiting_user');
    expect(repos.openHandoffs()).toHaveLength(1);
    // 浏览器还开着：老老实实等用户
    await settle();
    expect(calls).toHaveLength(1);

    browserOpen = false;
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ mode: 'start' });
    expect(calls[1].action.id).toBe(id);
    expect(repos.openHandoffs()).toHaveLength(0);
    expect(runner.state()).toMatchObject({ status: 'idle', done: 1 });
  });

  it('浏览器开着、但这份网申的页面被关了：接管作废、重新排队打开；缺信息的不动（它不靠页面）', async () => {
    const repos = createMemoryRepos();
    const [id] = seed(repos, 1);
    let gone = false;
    let round = 0;
    const { runner, calls } = makeRunner(repos, () => {
      round++;
      return round === 1
        ? [result('handoff', { reason: 'captcha', userAction: '请过一下验证' })]
        : [result('stopped_before_submit', { submitButton: '提交' })];
    }, { hasBrowser: () => true, pageGone: () => gone });
    runner.start();
    for (let i = 0; i < 50 && runner.state().phase !== 'waiting_user'; i++) await settle();
    await settle();
    expect(calls).toHaveLength(1);
    gone = true; // 学生关掉了窗口
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ mode: 'start' });
    expect(calls[1].action.id).toBe(id);
    expect(repos.openHandoffs()).toHaveLength(0);
  });

  it('只填那几份时，浏览器关了只放回那几份，别家页面已关的接管不动（2026-11-03）', async () => {
    const repos = createMemoryRepos();
    const [a, b] = seed(repos, 2);
    repos.setActionStatus(b, 'needs_user'); repos.openHandoff('captcha', { actionId: b });
    let browserOpen = true;
    const { runner } = makeRunner(repos, () => [result('handoff', { reason: 'captcha', userAction: '请过一下验证' })], { hasBrowser: () => browserOpen });
    runner.run([a]);
    for (let i = 0; i < 50 && runner.state().phase !== 'waiting_user'; i++) await settle();
    browserOpen = false;
    runner.requeueStaleHandoffs();
    expect(repos.openHandoffs().map(h => h.action_id)).toContain(b);
    expect(repos.getAction(b)?.status).toBe('needs_user');
    runner.stop();
  });

  it('等登录的不随重启 / 关页整批重开：接管留着，等登录之旅轮到它时自己打开（2026-11-03 每次重启几十家被重填）', async () => {
    const repos = createMemoryRepos();
    seed(repos, 1);
    let browserOpen = true;
    const { runner, calls } = makeRunner(repos, () => [result('handoff', { reason: 'login', userAction: '请登录' })], { hasBrowser: () => browserOpen, pageGone: () => true });
    runner.start();
    for (let i = 0; i < 50 && runner.state().phase !== 'waiting_user'; i++) await settle();
    browserOpen = false;
    for (let i = 0; i < 10; i++) await settle();
    expect(calls).toHaveLength(1);
    expect(repos.openHandoffs()).toHaveLength(1);
    expect(runner.state().phase).toBe('waiting_user');
    runner.stop();
  });

  it('并行：不同网站同时填，同一网站严格串行，并发数封顶', async () => {
    const repos = createMemoryRepos();
    seed(repos, 2, 'a.com'); seed(repos, 1, 'b.com'); seed(repos, 1, 'c.com');
    let active = 0; let peak = 0;
    const activeHosts = new Map<string, number>();
    let sameHostOverlap = false;
    const runner = new BatchRunner({
      repos, control: () => 'agent', broadcast: () => {}, concurrency: 2,
      sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))), pollMs: 5, pacingMs: [0, 0],
      drive: async (req, onEvent) => {
        const host = new URL(String(req.payload.url)).hostname;
        active++; peak = Math.max(peak, active);
        activeHosts.set(host, (activeHosts.get(host) ?? 0) + 1);
        if (activeHosts.get(host)! > 1) sameHostOverlap = true;
        await new Promise(r => setTimeout(r, 25));
        activeHosts.set(host, activeHosts.get(host)! - 1);
        active--;
        const evs = [result('stopped_before_submit')];
        evs.forEach(onEvent);
        return evs;
      },
    });
    runner.start();
    for (let i = 0; i < 200 && runner.state().status === 'running'; i++) await settle();
    expect(runner.state().status).toBe('idle');
    expect(runner.state().done).toBe(4);
    expect(peak).toBe(2);
    expect(sameHostOverlap).toBe(false);
  });
});

describe('BatchRunner 多任务展示数据', () => {
  it('每份进度事件带公司、岗位和真实进度，前端才能按岗位分组', async () => {
    const repos = createMemoryRepos();
    seed(repos, 1);
    const { runner, events } = makeRunner(repos, () => [
      { type: 'progress', phase: 'driving', message: '正在填写教育经历', progress: 0.4 },
      result('stopped_before_submit', { submitButton: '提交' }),
    ]);
    runner.start();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
    const progress = events.find(e => e.event === 'career:progress')?.data as Record<string, unknown>;
    expect(progress).toMatchObject({ company: '公司 0', job_title: '岗位 0', progress: 0.4, message: '正在填写教育经历' });
    expect(String(progress.runId)).toMatch(/^run_act_/);
  });
});
