import { describe, expect, it, vi } from 'vitest';
import type { Repos } from '@career/core';

import { LiveHub } from '../career/live-hub';
import { createMemoryRepos } from '../career/test-db';
import { handleCareerLiveRoute, type CareerLiveDeps, type CareerLiveHost } from './career-live';

// 现场路由：state 快照、NDJSON 流（snapshot → hub 事件 → 心跳）、接管 / 交回（交回关闭填表接管）、批量命令。

function fakeHost(hasBrowser = true): CareerLiveHost & { control: 'agent' | 'human'; front: number } {
  const page = { url: () => 'https://x.com/apply', title: async () => '网申', isClosed: () => false, context: () => ({ newCDPSession: async () => ({ send: async () => ({}), on: () => {}, detach: async () => {} }) }), once: () => {} };
  const context = { pages: () => [page], on: () => {}, newPage: async () => page } as never;
  const host = {
    control: 'agent' as 'agent' | 'human', front: 0,
    hasContext: () => hasBrowser,
    getControl: () => ({ control: host.control, reason: null, since: 0 }),
    setControl: (_id: string, c: 'agent' | 'human') => { host.control = c; return { control: c, reason: null, since: 0 }; },
    withProductSession: async <T,>(_id: string, fn: (ctx: never) => Promise<T>) => fn(context),
    browserChannel: () => 'chrome' as const,
  };
  return host;
}

function deps(repos: Repos, host = fakeHost(), hub = new LiveHub()): CareerLiveDeps & { hub: LiveHub } {
  return { host, hub, repos, productSessionId: () => 'sess-career', bringToFront: async () => { (host as unknown as { front: number }).front++; }, heartbeatMs: 20 };
}
const req = (path: string, body?: unknown) => new Request(`http://local${path}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {});

describe('career live route', () => {
  it('state：浏览器 / 控制权 / 接管数', async () => {
    const repos = createMemoryRepos();
    const d = deps(repos);
    const res = await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), d);
    const json = await res!.json() as { browser: { hasBrowser: boolean; control: string; url: string }; openHandoffs: number };
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(json.browser).toMatchObject({ hasBrowser: true, control: 'agent', url: 'https://x.com/apply' });
    expect(json.openHandoffs).toBe(0);
    expect(await handleCareerLiveRoute('/api/other', req('/api/other'), d)).toBeNull();
  });

  it('stream：先 snapshot，再转发 hub 事件与心跳；断开后停止', async () => {
    const repos = createMemoryRepos();
    const d = deps(repos);
    const controller = new AbortController();
    const res = await handleCareerLiveRoute('/api/career/live/stream', new Request('http://local/api/career/live/stream?frames=0', { signal: controller.signal }), d);
    expect(res!.headers.get('Content-Type')).toContain('ndjson');
    const reader = res!.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readLines = async (n: number) => { while (buf.split('\n').filter(Boolean).length < n) { const { value, done } = await reader.read(); if (done) break; buf += decoder.decode(value); } return buf.split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>); };
    await readLines(1);
    d.hub.publish('career:batch', { status: 'running', done: 1 });
    const lines = await readLines(3);
    expect(lines[0].type).toBe('snapshot');
    expect(lines.some(l => l.type === 'career:batch' && l.done === 1)).toBe(true);
    expect(lines.some(l => l.type === 'heartbeat')).toBe(true);
    controller.abort();
    const { done } = await reader.read().catch(() => ({ done: true }));
    expect(done).toBe(true);
    expect(d.hub.size).toBe(0);
  });

  it('control：human 前置窗口并广播；agent 关闭等待中的填表接管并广播数据变更', async () => {
    const repos = createMemoryRepos();
    const host = fakeHost();
    const d = deps(repos, host);
    const events: unknown[] = []; d.hub.subscribe(e => events.push(e));
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j1', title: 'x', url: 'https://x.com/a' });
    const app = repos.createApplication(job.id);
    const action = repos.enqueueAction('fill_form', {}, app.id);
    repos.openHandoff('captcha', { actionId: action.id, message: '滑块' });
    const take = await handleCareerLiveRoute('/api/career/live/control', req('/api/career/live/control', { control: 'human' }), d);
    expect((await take!.json() as { ok: boolean }).ok).toBe(true);
    expect(host.control).toBe('human'); expect(host.front).toBe(1);
    const back = await handleCareerLiveRoute('/api/career/live/control', req('/api/career/live/control', { control: 'agent' }), d);
    expect((await back!.json() as { ok: boolean }).ok).toBe(true);
    expect(host.control).toBe('agent');
    expect(repos.openHandoffs()).toHaveLength(0);
    expect(events.map(e => (e as { type: string }).type)).toEqual(['career:takeover', 'career:takeover', 'career:data-changed']);
    const bad = await handleCareerLiveRoute('/api/career/live/control', req('/api/career/live/control', { control: 'x' }), d);
    expect(bad!.status).toBe(400);
  });

  it('没有浏览器时 control 409；batch 命令无运行器时写 kv', async () => {
    const repos = createMemoryRepos();
    const d = deps(repos, fakeHost(false));
    expect((await handleCareerLiveRoute('/api/career/live/control', req('/api/career/live/control', { control: 'human' }), d))!.status).toBe(409);
    const res = await handleCareerLiveRoute('/api/career/batch/command', req('/api/career/batch/command', { cmd: 'start' }), d);
    expect((await res!.json() as { queued: boolean }).queued).toBe(true);
    expect(repos.kvGet('apply:batch:command')).toMatchObject({ cmd: 'start' });
    const spyRunner = { state: vi.fn(() => ({ status: 'idle' })), start: vi.fn(() => ({ status: 'running' })), pause: vi.fn(), stop: vi.fn() };
    const res2 = await handleCareerLiveRoute('/api/career/batch/command', req('/api/career/batch/command', { cmd: 'start' }), { ...d, runner: spyRunner as never });
    expect((await res2!.json() as { batch: { status: string } }).batch.status).toBe('running');
    expect(spyRunner.start).toHaveBeenCalled();
  });
});
