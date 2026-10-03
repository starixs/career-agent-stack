import { describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { BatchRunner, BATCH_COMMAND_KEY, type DriveRequest } from './batch-runner';
import { createMemoryRepos } from './test-db';

// 批量运行器：队列顺序、落库、接管等待交回后续跑、暂停 / 停止、每日上限、风控跳过。drive 用桩。

type Ev = Record<string, unknown>;
const result = (status: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'result', op: 'drive', result: { status, message: status, finalUrl: 'https://x.com/p', adapterId: 'generic', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'], ...extra } });

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

  it('风控锁住的平台先跳过；失败 → 投递 blocked；每日上限到了就等', async () => {
    const repos = createMemoryRepos();
    seed(repos, 1, 'locked.com'); const [free] = seed(repos, 1, 'free.com');
    const { runner, calls } = makeRunner(repos, () => [{ type: 'error', status: 501, error: '引擎未就绪' }], { riskLocked: p => p === 'locked.com', dailyCap: 1 });
    runner.start();
    for (let i = 0; i < 50 && calls.length === 0; i++) await settle();
    await settle();
    expect(calls[0].action.id).toBe(free);
    expect(repos.getAction(free)!.status).toBe('failed');
    expect(runner.state().failed).toBe(1);
    expect(runner.state().phase).toBe('daily_cap');
    runner.stop();
    for (let i = 0; i < 50 && runner.state().status === 'running'; i++) await settle();
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
        ? [result('handoff', { reason: 'login', userAction: '请登录' })]
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
});

