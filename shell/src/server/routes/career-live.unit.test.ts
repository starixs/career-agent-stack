import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Repos } from '@career/core';

import { adoptApplicationPage, resetApplicationPages } from '../career/app-pages';
import { FileChooserBroker, type FileChooserLike } from '../career/file-chooser';
import { LiveHub } from '../career/live-hub';
import { JOURNEY_EVENT } from '../career/login-journey';
import { beginUserWait, setLivePin } from '../career/live-pin';
import { createMemoryRepos } from '../career/test-db';
import { handleCareerLiveRoute, type CareerLiveDeps, type CareerLiveHost } from './career-live';

// 现场路由：state 快照、NDJSON 流（snapshot → hub 事件 → 心跳）、接管 / 交回（交回关闭填表接管）、批量命令。

function fakeHost(hasBrowser = true): CareerLiveHost & { control: 'agent' | 'human'; front: number } {
  const page = { url: () => 'https://x.com/apply', title: async () => '网申', isClosed: () => false, context: () => ({ newCDPSession: async () => ({ send: async () => ({}), on: () => {}, detach: async () => {} }) }), once: () => {} };
  const emitter = new EventEmitter();
  const context = Object.assign(emitter, { pages: () => [page], newPage: async () => page }) as never;
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

  it('stream：登录之旅变了（发码 / 要看图）就再推一份快照，画面先开着也能看到验证码那一格（2026-11-03 中车）', async () => {
    const repos = createMemoryRepos();
    const d = deps(repos);
    const controller = new AbortController();
    const res = await handleCareerLiveRoute('/api/career/live/stream', new Request('http://local/api/career/live/stream?frames=0', { signal: controller.signal }), d);
    const reader = res!.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readLines = async (n: number) => { while (buf.split('\n').filter(Boolean).length < n) { const { value, done } = await reader.read(); if (done) break; buf += decoder.decode(value); } return buf.split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>); };
    await readLines(1);
    d.hub.publish(JOURNEY_EVENT);
    const lines = await readLines(2);
    expect(lines.filter(l => l.type === 'snapshot')).toHaveLength(2);
    expect(lines.some(l => l.type === JOURNEY_EVENT)).toBe(false);
    controller.abort();
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

  it('state：登录之旅带上「第几家 / 共几家」；助理在等你处理时 waitingUser=true（交还时抽屉不再往对话里补一句）', async () => {
    const repos = createMemoryRepos();
    const d = deps(repos);
    const state = async () => (await (await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), d))!.json()) as { journey: unknown; waitingUser: boolean };
    expect(await state()).toMatchObject({ journey: null, waitingUser: false });
    setLivePin({ sessionKey: 's', appKey: 'app', askId: 'h1', handoffId: 'h1', index: 1, total: 3 });
    const end = beginUserWait();
    try {
      expect(await state()).toMatchObject({ journey: { index: 1, total: 3 }, waitingUser: true });
    } finally { end(); end(); setLivePin(null); }
    expect((await state()).waitingUser).toBe(false);
  });

  it('几家一起投：列出有页面开着的几家，点一家画面和操作就落在那一家（用户 2026-11-02「只能看到美团这一家」）', async () => {
    resetApplicationPages();
    const repos = createMemoryRepos();
    const appOf = (company: string) => repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: company, title: '数据分析', company_name: company }).id).id;
    const [mt, sd] = [appOf('美团'), appOf('斯达半导体')];
    const mk = (url: string) => { const frame = {}; return { url: () => url, title: async () => url, isClosed: () => false, mainFrame: () => frame, once: () => {} }; };
    const [mtPage, sdPage] = [mk('https://zhaopin.meituan.com/apply'), mk('https://v.wjx.cn/vm/x.aspx')];
    const host = { ...fakeHost(), withProductSession: async <T,>(_id: string, fn: (ctx: never) => Promise<T>) => fn({ pages: () => [mtPage, sdPage] } as never) };
    adoptApplicationPage('sess-career', mt, mtPage as never);
    adoptApplicationPage('sess-career', sd, sdPage as never);
    const d = deps(repos, host as never);
    const pages = async () => ((await (await handleCareerLiveRoute('/api/career/live/pages', req('/api/career/live/pages'), d))!.json()) as { pages: Array<{ company: string; current: boolean }> }).pages;
    expect((await pages()).map(p => p.company).sort()).toEqual(['斯达半导体', '美团']);
    const switched = await handleCareerLiveRoute('/api/career/live/view', req('/api/career/live/view', { application_id: sd }), d);
    expect(switched!.status).toBe(200);
    expect((await pages()).find(p => p.current)?.company).toBe('斯达半导体');
    const state = (await (await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), d))!.json()) as { browser: { url: string } };
    expect(state.browser.url).toBe('https://v.wjx.cn/vm/x.aspx');
    const gone = await handleCareerLiveRoute('/api/career/live/view', req('/api/career/live/view', { application_id: 'app_closed' }), d);
    expect(gone!.status).toBe(404);
    await handleCareerLiveRoute('/api/career/live/view', req('/api/career/live/view', { application_id: null }), d);
    resetApplicationPages();
  });

  it('去看一家页面已经关了的：填好过的放回重填并马上开填，作废它的投前过目；没填好过的如实回 404（2026-11-05 去看点了没反应）', async () => {
    resetApplicationPages();
    const repos = createMemoryRepos();
    const app = repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: 'mm', title: '产品', company_name: '陌陌' }).id).id;
    const fill = repos.enqueueAction('fill_form', {}, app, true);
    repos.setActionStatus(fill.id, 'done');
    const submit = repos.enqueueAction('submit', { review: { rows: [], requiredFilled: 3, requiredTotal: 3 } }, app);
    const ran: string[][] = [];
    const d = { ...deps(repos), runner: { run: (ids: string[]) => { ran.push(ids); } } as never };
    const res = await handleCareerLiveRoute('/api/career/live/view', req('/api/career/live/view', { application_id: app }), d);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ reopening: true });
    expect(ran).toEqual([[fill.id]]);
    expect(repos.getAction(fill.id)!.status).toBe('approved');
    expect(repos.getAction(submit.id)!.status).toBe('failed');
    const never = repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: 'x', title: '产品', company_name: '某司' }).id).id;
    expect((await handleCareerLiveRoute('/api/career/live/view', req('/api/career/live/view', { application_id: never }), d))!.status).toBe(404);
  });

  it('登录之旅钉着一家时，他点别家画面也跟过去；没人选过时按画面所在页标出当前这家（2026-11-05「切换画面不会跟着切换」）', async () => {
    resetApplicationPages();
    const repos = createMemoryRepos();
    const appOf = (company: string) => repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: company, title: '数据分析', company_name: company }).id).id;
    const [crrc, wjx] = [appOf('中国中车'), appOf('斯达半导体')];
    // 桥接代理：每次借用都是新的 Page 对象，只有 mainFrame 稳定
    const frames = { crrc: {}, wjx: {} };
    const proxy = (frame: object, url: string) => ({ url: () => url, title: async () => url, isClosed: () => false, mainFrame: () => frame, once: () => {} });
    const ctx = () => ({ pages: () => [proxy(frames.crrc, 'https://crrc.example/login'), proxy(frames.wjx, 'https://v.wjx.cn/vm/x.aspx')] });
    const host = { ...fakeHost(), withProductSession: async <T,>(_id: string, fn: (c: never) => Promise<T>) => fn(ctx() as never) };
    adoptApplicationPage('sess-career', crrc, proxy(frames.crrc, 'https://crrc.example/login') as never);
    adoptApplicationPage('sess-career', wjx, proxy(frames.wjx, 'https://v.wjx.cn/vm/x.aspx') as never);
    const d = deps(repos, host as never);
    const pages = async () => ((await (await handleCareerLiveRoute('/api/career/live/pages', req('/api/career/live/pages'), d))!.json()) as { pages: Array<{ company: string; current: boolean }> }).pages;
    const url = async () => ((await (await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), d))!.json()) as { browser: { url: string } }).browser.url;
    try {
      // 没人点过、也没在登录：画面在第一页（中车），列表就标中车，不再「请选择」
      expect((await pages()).find(p => p.current)?.company).toBe('中国中车');
      setLivePin({ sessionKey: 'sess-career', appKey: crrc, askId: 'a', handoffId: 'h', index: 0, total: 1 });
      expect(await url()).toBe('https://crrc.example/login');
      await handleCareerLiveRoute('/api/career/live/view', req('/api/career/live/view', { application_id: wjx }), d);
      expect(await url()).toBe('https://v.wjx.cn/vm/x.aspx');
      expect((await pages()).find(p => p.current)?.company).toBe('斯达半导体');
      // 看着别家时不出登录之旅那一栏（「这家先跳过」跳的是钉住的中车，不是眼前这家）
      const journey = async () => ((await (await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), d))!.json()) as { journey: unknown }).journey;
      expect(await journey()).toBeNull();
      // 登录之旅换到下一家：放下他刚才的选择，画面跟到要他登录的那家
      setLivePin({ sessionKey: 'sess-career', appKey: wjx, askId: 'a', handoffId: 'h2', index: 1, total: 2 });
      setLivePin({ sessionKey: 'sess-career', appKey: crrc, askId: 'a', handoffId: 'h3', index: 1, total: 2 });
      expect(await url()).toBe('https://crrc.example/login');
      expect(await journey()).toMatchObject({ index: 1, total: 2 });
    } finally { setLivePin(null); resetApplicationPages(); }
  });

  it('sms-code：只收 4–8 位数字；没有在等验证码的网站就如实说', async () => {
    const d = deps(createMemoryRepos());
    const bad = await handleCareerLiveRoute('/api/career/live/sms-code', req('/api/career/live/sms-code', { code: 'abc' }), d);
    expect(bad!.status).toBe(400);
    const none = await handleCareerLiveRoute('/api/career/live/sms-code', req('/api/career/live/sms-code', { code: '123456' }), d);
    expect(none!.status).toBe(409);
    expect(((await (await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), d))!.json()) as { sms: unknown }).sms).toBeNull();
  });

  it('state：登录之旅里状态行的网址是钉住的那一家，不是后台正在填的另一页', async () => {
    const mk = (url: string) => { const frame = {}; return { url: () => url, title: async () => url, isClosed: () => false, mainFrame: () => frame, once: () => {} }; };
    const [busy, login] = [mk('https://busy.test/apply'), mk('https://login.test/sso')];
    const host = { ...fakeHost(), withProductSession: async <T,>(_id: string, fn: (ctx: never) => Promise<T>) => fn({ pages: () => [busy, login] } as never) };
    adoptApplicationPage('s', 'app-login', login as never);
    setLivePin({ sessionKey: 's', appKey: 'app-login', askId: 'h1', handoffId: 'h1', index: 0, total: 2 });
    try {
      const res = await handleCareerLiveRoute('/api/career/live/state', req('/api/career/live/state'), deps(createMemoryRepos(), host as never));
      expect(((await res!.json()) as { browser: { url: string } }).browser.url).toBe('https://login.test/sso');
    } finally { setLivePin(null); resetApplicationPages(); }
  });

  it('登录之旅里交还：只关当前带你过的这一家，别家还没登录的和缺信息的那批不被一起当成处理完', async () => {
    const repos = createMemoryRepos();
    const host = fakeHost();
    const d = deps(repos, host);
    const open = (site: string, reason: 'login' | 'missing_info') => {
      const app = repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: site, title: 'x', url: `https://${site}/a` }).id);
      return { app, h: repos.openHandoff(reason, { actionId: repos.enqueueAction('fill_form', {}, app.id).id }) };
    };
    const a = open('a.com', 'login'); const b = open('b.com', 'login'); const c = open('c.com', 'missing_info');
    setLivePin({ sessionKey: 's', appKey: a.app.id, askId: a.h.id, handoffId: a.h.id, index: 0, total: 2 });
    try {
      await handleCareerLiveRoute('/api/career/live/control', req('/api/career/live/control', { control: 'human' }), d);
      await handleCareerLiveRoute('/api/career/live/control', req('/api/career/live/control', { control: 'agent' }), d);
      expect(repos.openHandoffs().map(h => h.id).sort()).toEqual([b.h.id, c.h.id].sort());
    } finally { setLivePin(null); }
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

  it('input：按页面真实视口换算，不信 Playwright 记的启动视口（窗口被放大后点击会落到别处）', async () => {
    const repos = createMemoryRepos();
    const host = fakeHost();
    const calls: unknown[][] = [];
    const page = {
      url: () => 'https://zhaopin.meituan.com/web/position/detail', title: async () => '职位详情', isClosed: () => false,
      viewportSize: () => ({ width: 1366, height: 768 }),
      // 真实 Chrome 桥接页报的是页面此刻的视口（livePageViewport）
      viewport: async () => ({ width: 1440, height: 1543 }),
      mouse: { click: async (...a: unknown[]) => { calls.push(a); } },
      waitForTimeout: async () => {},
    };
    host.withProductSession = async <T,>(_id: string, fn: (ctx: never) => Promise<T>) => fn({ pages: () => [page], newPage: async () => page, on: () => {} } as never);
    host.control = 'human';
    await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { type: 'click', x: 658, y: 785, frame: { width: 1440, height: 1543 } }), deps(repos, host));
    expect(calls[0]).toEqual([658, 785, { clickCount: 1 }]);
  });

  it('input：只有接管中才转发；坐标按帧尺寸换算到视口；type / press 走键盘', async () => {
    const repos = createMemoryRepos();
    const host = fakeHost();
    const calls: Array<[string, unknown[]]> = [];
    const page = {
      url: () => 'https://x.com/apply', title: async () => '网申', isClosed: () => false,
      viewportSize: () => ({ width: 1280, height: 900 }),
      evaluate: async () => null,
      mouse: { click: async (...a: unknown[]) => { calls.push(['click', a]); }, move: async (...a: unknown[]) => { calls.push(['move', a]); }, wheel: async (...a: unknown[]) => { calls.push(['wheel', a]); }, down: async () => { calls.push(['down', []]); }, up: async () => { calls.push(['up', []]); } },
      keyboard: { type: async (...a: unknown[]) => { calls.push(['type', a]); }, insertText: async (...a: unknown[]) => { calls.push(['insertText', a]); }, press: async (...a: unknown[]) => { calls.push(['press', a]); } },
      waitForTimeout: async () => {},
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
    // 他自己打的字原样写入，不走助理的拟人逐字（2026-11-05 现场窗打字卡顿）
    expect(calls.slice(1).map(c => c[0])).toEqual(['insertText', 'press', 'wheel']);
    expect(calls[1][1]).toEqual(['张三']);
    expect(calls[3][1]).toEqual([0, 200]);
    const bad = await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { type: 'nope' }), d);
    expect(bad!.status).toBe(400);
    // 拖动（滑块验证码）实时转发：按下 → 移动（带按键）→ 松开，坐标同样按帧换算
    calls.length = 0;
    const frame = { width: 640, height: 450 };
    for (const ev of [{ type: 'down', x: 10, y: 20, clickCount: 1 }, { type: 'move', x: 60, y: 22 }, { type: 'up', x: 110, y: 21 }]) {
      const res = await handleCareerLiveRoute('/api/career/live/input', req('/api/career/live/input', { ...ev, frame }), d);
      expect(res!.status).toBe(200);
    }
    expect(calls.map(c => c[0])).toEqual(['move', 'down', 'move', 'move', 'up']);
    expect(calls[0][1]).toEqual([20, 40]);
    expect(calls[3][1]).toEqual([220, 42]);
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

  it('viewport：上报画面框尺寸交给宿主按比例调整视口；参数不合法 400；宿主不支持时不报错', async () => {
    const repos = createMemoryRepos();
    const calls: Array<{ width: number; height: number }> = [];
    const host = Object.assign(fakeHost(false), { fitLiveViewport: async (_id: string, box: { width: number; height: number }) => { calls.push(box); return { viewport: { width: 1366, height: 1000 }, changed: 0 }; } });
    const d = deps(repos, host);
    const res = await handleCareerLiveRoute('/api/career/live/viewport', req('/api/career/live/viewport', { width: 640, height: 470 }), d);
    expect(await res!.json()).toMatchObject({ ok: true, viewport: { width: 1366, height: 1000 } });
    // 浏览器还没开也记下来（打开后新页面直接用）
    expect(calls).toEqual([{ width: 640, height: 470 }]);
    expect((await handleCareerLiveRoute('/api/career/live/viewport', req('/api/career/live/viewport', { width: -1, height: 3 }), d))!.status).toBe(400);
    const plain = await handleCareerLiveRoute('/api/career/live/viewport', req('/api/career/live/viewport', { width: 640, height: 470 }), deps(repos));
    expect(await plain!.json()).toMatchObject({ ok: true, supported: false });
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

  it('画面流：连上时浏览器还没开，开了之后自动接上画面（不用重开现场）', async () => {
    const repos = createMemoryRepos();
    const host = fakeHost(false);
    let open = false;
    host.hasContext = () => open;
    const borrowed = vi.fn();
    const original = host.withProductSession;
    host.withProductSession = (async (id: string, fn: (ctx: never) => Promise<unknown>, opts?: unknown) => { borrowed(id); return original(id, fn as never, opts as never); }) as typeof host.withProductSession;
    const d = { ...deps(repos, host), framesPollMs: 10 };
    const controller = new AbortController();
    const res = await handleCareerLiveRoute('/api/career/live/stream', new Request('http://local/api/career/live/stream?frames=1', { signal: controller.signal }), d);
    const reader = res!.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) { const r = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>(ok => setTimeout(() => ok({ done: false }), 20))]); if (r.value) buf += decoder.decode(r.value); } };
    await until(() => buf.includes('frame-status'));
    expect(buf).toContain('"state":"waiting"');
    expect(buf).toContain('正在打开浏览器');
    expect(buf).not.toContain('启用 career-bridge');
    expect(borrowed).not.toHaveBeenCalled();
    open = true;
    await until(() => borrowed.mock.calls.length > 0);
    expect(borrowed).toHaveBeenCalledWith('sess-career');
    controller.abort();
  });

  it('画面流：浏览器在连上之后才打开，接上画面时补推一份 snapshot（否则「控制浏览器」一直灰着）', async () => {
    const repos = createMemoryRepos();
    const host = fakeHost(false);
    let open = false;
    host.hasContext = () => open;
    const d = { ...deps(repos, host), framesPollMs: 10, heartbeatMs: 60_000 };
    const controller = new AbortController();
    const res = await handleCareerLiveRoute('/api/career/live/stream', new Request('http://local/api/career/live/stream?frames=1', { signal: controller.signal }), d);
    const reader = res!.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const snapshots = () => buf.split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; browser?: { hasBrowser: boolean } }).filter(l => l.type === 'snapshot');
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) { const r = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>(ok => setTimeout(() => ok({ done: false }), 20))]); if (r.value) buf += decoder.decode(r.value); } };
    await until(() => snapshots().length > 0 && buf.includes('"state":"waiting"'));
    expect(snapshots()[0].browser?.hasBrowser).toBe(false);
    open = true;
    await until(() => snapshots().some(s => s.browser?.hasBrowser));
    expect(snapshots().at(-1)?.browser?.hasBrowser).toBe(true);
    controller.abort();
  });

  it('画面状态：接上时推 connecting；浏览器被关掉推 closed，重新打开后自动接上', async () => {
    const repos = createMemoryRepos();
    const host = fakeHost(true);
    const contexts: EventEmitter[] = [];
    let open = true;
    host.hasContext = () => open;
    const original = host.withProductSession;
    host.withProductSession = (async (id: string, fn: (ctx: never) => Promise<unknown>, opts?: unknown) => original(id, (async (ctx: never) => { contexts.push(ctx as unknown as EventEmitter); return fn(ctx); }) as never, opts as never)) as typeof host.withProductSession;
    const d = { ...deps(repos, host), framesPollMs: 10 };
    const controller = new AbortController();
    const res = await handleCareerLiveRoute('/api/career/live/stream', new Request('http://local/api/career/live/stream?frames=1', { signal: controller.signal }), d);
    const reader = res!.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) { const r = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>(ok => setTimeout(() => ok({ done: false }), 20))]); if (r.value) buf += decoder.decode(r.value); } };
    await until(() => buf.includes('"state":"connecting"'));
    await new Promise(r => setTimeout(r, 30));
    const baseline = contexts.length; // 状态快照也会借一次，画面流再借一次
    open = false;
    contexts[contexts.length - 1].emit('close');
    await until(() => buf.includes('"state":"closed"'));
    expect(buf).toContain('浏览器连接已断开');
    open = true;
    await until(() => contexts.length > baseline);
    expect(contexts.length).toBeGreaterThan(baseline);
    controller.abort();
  });
});

