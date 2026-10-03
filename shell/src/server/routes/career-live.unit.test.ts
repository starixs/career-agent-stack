import { describe, expect, it, vi } from 'vitest';
import type { Repos } from '@career/core';

import { FileChooserBroker, type FileChooserLike } from '../career/file-chooser';
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

  it('input：只有接管中才转发；坐标按帧尺寸换算到视口；type / press 走键盘', async () => {
    const repos = createMemoryRepos();
    const host = fakeHost();
    const calls: Array<[string, unknown[]]> = [];
    const page = {
      url: () => 'https://x.com/apply', title: async () => '网申', isClosed: () => false,
      viewportSize: () => ({ width: 1280, height: 900 }),
      mouse: { click: async (...a: unknown[]) => { calls.push(['click', a]); }, move: async (...a: unknown[]) => { calls.push(['move', a]); }, wheel: async (...a: unknown[]) => { calls.push(['wheel', a]); } },
      keyboard: { type: async (...a: unknown[]) => { calls.push(['type', a]); }, press: async (...a: unknown[]) => { calls.push(['press', a]); } },
    };
    host.withProductSession = async <T,>(_id: string, fn: (ctx: never) => Promise<T>) => fn({ pages: () => [page], newPage: async () => page, on: () => {} } as never);
    const d = deps(repos, host);
    const denied = await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { type: 'click', x: 10, y: 10 }), d);
    expect(denied!.status).toBe(409);
    host.control = 'human';
    const clicked = await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { type: 'click', x: 320, y: 225, frame: { width: 640, height: 450 } }), d);
    expect((await clicked!.json() as { x: number; y: number }).x).toBe(640);
    expect(calls[0]).toEqual(['click', [640, 450, { clickCount: 1 }]]);
    await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { type: 'type', text: '张三' }), d);
    await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { type: 'press', key: 'Enter' }), d);
    await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { type: 'wheel', dy: 100, frame: { width: 640, height: 450 } }), d);
    expect(calls.slice(1).map(c => c[0])).toEqual(['type', 'press', 'wheel']);
    expect(calls[1][1]).toEqual(['张三']);
    expect(calls[3][1]).toEqual([0, 200]);
    const bad = await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { type: 'nope' }), d);
    expect(bad!.status).toBe(400);
  });

  it('内嵌窗口：接管不前置真实 Chrome；放出窗口后才前置；/live/window 切换并广播', async () => {
    const repos = createMemoryRepos();
    const host = Object.assign(fakeHost(), {
      revealed: false,
      embeddedWindow: () => true,
      isWindowRevealed() { return this.revealed; },
      async setWindowVisible(_id: string, visible: boolean) { this.revealed = visible; return { revealed: visible }; },
    });
    const d = deps(repos, host);
    const events: string[] = [];
    d.hub.subscribe(ev => { events.push(String(ev.type)); });
    await handleCareerLiveRoute('/api/career/live/control', req('/api/career/live/control', { control: 'human' }), d);
    expect(host.control).toBe('human');
    expect(host.front).toBe(0);

    const state = await (await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), d))!.json() as { browser: { embedded: boolean; windowRevealed: boolean } };
    expect(state.browser).toMatchObject({ embedded: true, windowRevealed: false });

    const shown = await (await handleCareerLiveRoute('/api/career/live/window', req('/api/career/live/window', { visible: true }), d))!.json() as { revealed: boolean };
    expect(shown.revealed).toBe(true);
    expect(events).toContain('career:live-window');
    await handleCareerLiveRoute('/api/career/live/control', req('/api/career/live/control', { control: 'human' }), d);
    expect(host.front).toBe(1);

    const bad = await handleCareerLiveRoute('/api/career/live/window', req('/api/career/live/window', { visible: 'yes' }), d);
    expect(bad!.status).toBe(400);
  });

  it('产品内选文件：拦下的选文件框出现在快照里，上传后交给页面并广播 done', async () => {
    const repos = createMemoryRepos();
    const hub = new LiveHub();
    const files = new FileChooserBroker(hub);
    const d = { ...deps(repos, fakeHost(), hub), files };
    const setFiles = vi.fn(async () => {});
    const chooser: FileChooserLike = { isMultiple: () => false, element: () => ({ getAttribute: async () => '.pdf,.doc' }), page: () => ({ url: () => 'https://x.com/apply' }), setFiles };
    const events: Array<Record<string, unknown>> = [];
    hub.subscribe(ev => { events.push(ev); });
    const offered = await files.offer('sess-career', chooser);
    expect(events.at(-1)).toMatchObject({ type: 'career:live-filechooser', state: 'open', accept: '.pdf,.doc', multiple: false });

    const state = await (await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), d))!.json() as { fileChooser: { id: string } | null };
    expect(state.fileChooser?.id).toBe(offered.id);

    const two = await handleCareerLiveRoute('/api/career/live/file', req('/api/career/live/file', { id: offered.id, files: [{ name: 'a.pdf', data: 'YQ==' }, { name: 'b.pdf', data: 'Yg==' }] }), d);
    expect(two!.status).toBe(400);

    const res = await handleCareerLiveRoute('/api/career/live/file', req('/api/career/live/file', { id: offered.id, files: [{ name: '../简历.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') }] }), d);
    expect(await res!.json()).toMatchObject({ ok: true, count: 1, bytes: 8 });
    expect(setFiles).toHaveBeenCalledWith([{ name: '.._简历.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }]);
    expect(events.at(-1)).toMatchObject({ type: 'career:live-filechooser', state: 'done', count: 1 });
    expect(files.current()).toBeNull();

    const stale = await handleCareerLiveRoute('/api/career/live/file', req('/api/career/live/file', { id: offered.id, files: [{ name: 'a.pdf', data: 'YQ==' }] }), d);
    expect(stale!.status).toBe(400);
  });

  it('产品内选文件：取消与超时都会清掉待处理请求', async () => {
    vi.useFakeTimers();
    try {
      const hub = new LiveHub();
      const files = new FileChooserBroker(hub, 1000);
      const chooser: FileChooserLike = { isMultiple: () => true, element: () => ({ getAttribute: async () => null }), page: () => ({ url: () => 'u' }), setFiles: async () => {} };
      const first = await files.offer('s', chooser);
      expect(files.cancel('nope')).toBe(false);
      expect(files.cancel(first.id)).toBe(true);
      expect(files.current()).toBeNull();
      await files.offer('s', chooser);
      vi.advanceTimersByTime(1500);
      expect(files.current()).toBeNull();
      expect(hub.latest('career:live-filechooser')).toMatchObject({ state: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });
});
