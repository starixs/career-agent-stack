import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

import { humanControlError } from '../browser-host/context-registry';
import {
  collectPassiveResponses,
  defaultTelemetry,
  handleCareerBrowserRoute,
  matchesPassiveFilter,
  type ApplyEngineModule,
  type CareerBrowserHost,
  type CareerBrowserRouteDependencies,
  type PassivePageLike,
} from './career-browser';

const TOKEN = 'd'.repeat(32);
const BASE = 'http://127.0.0.1:31417';

function fakePage(): Page & EventEmitter {
  const events = new EventEmitter();
  return Object.assign(events, {
    isClosed: () => false,
    url: () => 'https://www.zhipin.com/web/geek/job',
    title: vi.fn(async () => 'Boss直聘'),
    bringToFront: vi.fn(async () => {}),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
    goto: vi.fn(async () => {}),
  }) as unknown as Page & EventEmitter;
}

function fakeHost(options: { control?: 'agent' | 'human'; open?: boolean; page?: Page } = {}) {
  const page = options.page ?? fakePage();
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  } as unknown as BrowserContext;
  let control = { control: options.control ?? 'agent', reason: null as string | null, since: 1 };
  const binding = { productSessionId: 'session-a', workspacePath: '/workspace/a', hostGeneration: 1 };
  const host: CareerBrowserHost = {
    verifyCapability: vi.fn(async (token: string) => {
      if (token !== TOKEN) { const error = new Error('bad'); error.name = 'BROWSER_CAPABILITY_INVALID'; throw error; }
      return binding;
    }),
    withContext: vi.fn(async (token: string, fn: (c: BrowserContext, b: typeof binding) => Promise<unknown>, opts?: { allowHumanControl?: boolean }) => {
      if (token !== TOKEN) { const error = new Error('bad'); error.name = 'BROWSER_CAPABILITY_INVALID'; throw error; }
      if (control.control === 'human' && !opts?.allowHumanControl) throw humanControlError();
      return fn(context, binding);
    }) as unknown as CareerBrowserHost['withContext'],
    hasContext: vi.fn(() => options.open ?? true),
    getControl: vi.fn(() => control),
    setControl: vi.fn((_: string, next: 'agent' | 'human', reason?: string) => {
      control = { control: next, reason: reason ?? null, since: 2 };
      return control;
    }),
    browserChannel: () => 'chrome' as const,
  };
  return { host, context, page };
}

function request(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Request {
  const token = init.token === undefined ? TOKEN : init.token;
  return new Request(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function ndjson(response: Response): Promise<Array<Record<string, unknown>>> {
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  const text = await response.text();
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('career browser route: auth and control', () => {
  it('ignores other paths and rejects missing or invalid capabilities', async () => {
    const { host } = fakeHost();
    const deps: CareerBrowserRouteDependencies = { host };
    expect(await handleCareerBrowserRoute('/api/career/jobs', request('/api/career/jobs'), deps)).toBeNull();
    expect(await handleCareerBrowserRoute('/api/career/browser/unknown', request('/api/career/browser/unknown'), deps)).toBeNull();

    const missing = await handleCareerBrowserRoute('/api/career/browser/state', request('/api/career/browser/state', { token: null }), deps);
    expect(missing?.status).toBe(401);
    await expect(missing!.json()).resolves.toMatchObject({ ok: false, code: 'BROWSER_CAPABILITY_REQUIRED' });

    const invalid = await handleCareerBrowserRoute('/api/career/browser/state', request('/api/career/browser/state', { token: 'e'.repeat(32) }), deps);
    expect(invalid?.status).toBe(401);
    await expect(invalid!.json()).resolves.toMatchObject({ ok: false, code: 'BROWSER_CAPABILITY_INVALID' });
    expect(host.withContext).not.toHaveBeenCalled();
  });

  it('switches to human control after bringing the window to the front', async () => {
    const { host, context } = fakeHost();
    const bringToFront = vi.fn(async () => {});
    const response = await handleCareerBrowserRoute(
      '/api/career/browser/control',
      request('/api/career/browser/control', { body: { control: 'human', reason: '验证码' } }),
      { host, bringToFront },
    );
    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({ ok: true, control: 'human', reason: '验证码' });
    expect(bringToFront).toHaveBeenCalledWith(context, 'chrome', null);
    expect(host.setControl).toHaveBeenCalledWith('session-a', 'human', '验证码');
    expect(vi.mocked(host.withContext).mock.calls[0]?.[2]).toMatchObject({ allowHumanControl: true });
    // Window focus failures must not block the takeover.
    bringToFront.mockRejectedValueOnce(new Error('no window'));
    const again = await handleCareerBrowserRoute(
      '/api/career/browser/control',
      request('/api/career/browser/control', { body: { control: 'human' } }),
      { host, bringToFront },
    );
    expect(again?.status).toBe(200);
  });

  it('hands back to the agent without launching a browser', async () => {
    const { host } = fakeHost({ control: 'human', open: false });
    const response = await handleCareerBrowserRoute(
      '/api/career/browser/control',
      request('/api/career/browser/control', { body: { control: 'agent' } }),
      { host },
    );
    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({ ok: true, control: 'agent' });
    expect(host.withContext).not.toHaveBeenCalled();

    const invalid = await handleCareerBrowserRoute(
      '/api/career/browser/control',
      request('/api/career/browser/control', { body: { control: 'robot' } }),
      { host },
    );
    expect(invalid?.status).toBe(400);
  });

  it('reports state without opening a browser and with page details when one is open', async () => {
    const closed = fakeHost({ open: false, control: 'human' });
    const idle = await handleCareerBrowserRoute('/api/career/browser/state', request('/api/career/browser/state'), { host: closed.host });
    await expect(idle!.json()).resolves.toMatchObject({ ok: true, control: 'human', open: false, url: null });
    expect(closed.host.withContext).not.toHaveBeenCalled();

    const open = fakeHost({ control: 'human' });
    const live = await handleCareerBrowserRoute('/api/career/browser/state', request('/api/career/browser/state'), { host: open.host });
    await expect(live!.json()).resolves.toMatchObject({
      ok: true, control: 'human', open: true, url: 'https://www.zhipin.com/web/geek/job', title: 'Boss直聘', pages: 1,
    });
    expect(vi.mocked(open.host.withContext).mock.calls[0]?.[2]).toMatchObject({ allowHumanControl: true });
  });
});

describe('career browser route: run', () => {
  it('refuses agent runs during human control and validates op', async () => {
    const { host } = fakeHost({ control: 'human' });
    const refused = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'screenshot' } }), { host });
    expect(refused?.status).toBe(409);
    await expect(refused!.json()).resolves.toMatchObject({ ok: false, code: 'BROWSER_CONTROL_HUMAN' });

    const agent = fakeHost();
    const badOp = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'submit' } }), { host: agent.host });
    expect(badOp?.status).toBe(400);
    const badBody = await handleCareerBrowserRoute('/api/career/browser/run', new Request(`${BASE}/api/career/browser/run`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '[1,2]',
    }), { host: agent.host });
    expect(badBody?.status).toBe(400);
  });

  it('streams a base64 screenshot as NDJSON', async () => {
    const { host, page } = fakeHost();
    const response = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'screenshot' } }), { host });
    expect(response?.status).toBe(200);
    const lines = await ndjson(response!);
    expect(lines.at(-1)).toMatchObject({
      type: 'result', op: 'screenshot', mimeType: 'image/jpeg', base64: Buffer.from([1, 2, 3]).toString('base64'), title: 'Boss直聘',
    });
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'jpeg', fullPage: false }));
    expect(vi.mocked(host.withContext).mock.calls[0]?.[2]).not.toMatchObject({ allowHumanControl: true });
  });

  it('answers 501 lines when the form engine or the LLM is unavailable, and runs diagnose when present', async () => {
    const { host, page } = fakeHost();
    const missing = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'diagnose' } }), {
      host, loadApply: async () => null,
    });
    expect((await ndjson(missing!)).at(-1)).toMatchObject({ type: 'error', status: 501 });

    const apply: ApplyEngineModule = {
      fromPlaywright: vi.fn(() => ({ goto: async () => {}, url: () => page.url() })),
      diagnosePage: vi.fn(async (_p, options) => ({ reachable: true, looksLikeForm: true, url: options?.url })),
      driveApplication: vi.fn(async () => ({ status: 'stopped_before_submit', screenshot: new Uint8Array([9]) })),
    };
    const diagnosed = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'diagnose', url: 'https://example.test/apply' } }), {
      host, loadApply: async () => apply,
    });
    expect((await ndjson(diagnosed!)).at(-1)).toMatchObject({
      type: 'result', op: 'diagnose', diagnosis: { reachable: true, url: 'https://example.test/apply' },
    });
    expect(apply.fromPlaywright).toHaveBeenCalledWith(page);

    const noLlm = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'drive', profile: { basics: {} } } }), {
      host, loadApply: async () => apply, resolveLlm: async () => null,
    });
    expect((await ndjson(noLlm!)).at(-1)).toMatchObject({ type: 'error', status: 501 });
    expect(apply.driveApplication).not.toHaveBeenCalled();

    const driven = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'drive', profile: { basics: {} }, maxPages: 2 } }), {
      host, loadApply: async () => apply, resolveLlm: async () => ({ complete: async () => ({}) }),
    });
    const lines = await ndjson(driven!);
    expect(lines.at(-1)).toMatchObject({
      type: 'result', op: 'drive', result: { status: 'stopped_before_submit' }, screenshot: { base64: Buffer.from([9]).toString('base64') },
    });
    expect(apply.driveApplication).toHaveBeenCalledWith(expect.anything(), expect.anything(), { basics: {} }, expect.objectContaining({ maxPages: 2, humanTyping: true }));
  });

  it('drive：界面只收人话进度（不广播内部日志）；运行记录目录按 actionId 传给引擎', async () => {
    const { host, page } = fakeHost();
    let seen: Record<string, unknown> = {};
    const apply: ApplyEngineModule = {
      fromPlaywright: vi.fn(() => ({ goto: async () => {}, url: () => page.url() })),
      diagnosePage: vi.fn(async () => ({})),
      driveApplication: vi.fn(async (_p, _l, _profile, options?: Record<string, unknown>) => {
        seen = options ?? {};
        (options?.onProgress as (p: { message: string; kind: string }) => void)({ message: '正在填「学历」', kind: 'field' });
        expect(options?.log).toBeUndefined();
        return { status: 'stopped_before_submit' };
      }),
    };
    const res = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'drive', actionId: 'act_t1' } }), {
      host, loadApply: async () => apply, resolveLlm: async () => ({ complete: async () => ({}) }),
      resolveDriveProfile: async () => ({ profile: { basics: {} } }),
      resolveTelemetry: async body => ({ dir: '/data/runs', runId: String(body.actionId), keep: 50 }),
    });
    const lines = await ndjson(res!);
    const progress = lines.filter(l => l.type === 'progress').map(l => l.message);
    expect(progress).toEqual(['开始填写（不会提交）', '正在填「学历」']);
    expect(seen.telemetry).toEqual({ dir: '/data/runs', runId: 'act_t1', keep: 50 });
    expect(lines.at(-1)).toMatchObject({ type: 'result', op: 'drive' });
  });

  it('defaultTelemetry：$CAREER_DATA_DIR/runs/<actionId>，测试资料 / 显式关闭时不记', async () => {
    const prev = process.env.CAREER_DATA_DIR;
    process.env.CAREER_DATA_DIR = '/tmp/career-data-test';
    try {
      expect(await defaultTelemetry({ actionId: 'act_9' })).toEqual({ dir: '/tmp/career-data-test/runs', runId: 'act_9', keep: 50 });
      expect(await defaultTelemetry({ actionId: 'act_9', profile: {} })).toBeNull();
      expect(await defaultTelemetry({ actionId: 'act_9', telemetry: false })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CAREER_DATA_DIR; else process.env.CAREER_DATA_DIR = prev;
    }
  });

  it('同一浏览器上下文同时只允许一份网申在填：第二份拿到 BROWSER_BUSY，第一份填完后释放', async () => {
    const { host, page } = fakeHost();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const apply: ApplyEngineModule = {
      fromPlaywright: vi.fn(() => ({ goto: async () => {}, url: () => page.url() })),
      diagnosePage: vi.fn(async () => ({})),
      driveApplication: vi.fn(async () => { await gate; return { status: 'stopped_before_submit' }; }),
    };
    const deps = { host, loadApply: async () => apply, resolveLlm: async () => ({ complete: async () => ({}) }) };
    const first = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'drive', actionId: 'act_a', profile: { basics: {} } } }), deps);
    const firstLines = ndjson(first!);
    await vi.waitFor(() => expect(apply.driveApplication).toHaveBeenCalledTimes(1));
    const second = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'drive', actionId: 'act_b', profile: { basics: {} } } }), deps);
    expect((await ndjson(second!)).at(-1)).toMatchObject({ type: 'error', status: 409, code: 'BROWSER_BUSY' });
    release();
    expect((await firstLines).at(-1)).toMatchObject({ type: 'result', op: 'drive' });
    const third = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'drive', actionId: 'act_b', profile: { basics: {} } } }), deps);
    expect((await ndjson(third!)).at(-1)).toMatchObject({ type: 'result', op: 'drive' });
  });

  it('surfaces errors thrown mid-run as a final NDJSON error line', async () => {
    const { host, page } = fakeHost();
    vi.mocked(page.screenshot).mockRejectedValueOnce(new Error('页面已关闭'));
    const response = await handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', { body: { op: 'screenshot' } }), { host });
    expect((await ndjson(response!)).at(-1)).toMatchObject({ type: 'error', status: 500, error: '页面已关闭' });
  });

  it('passively collects matching JSON responses from the page for the requested window', async () => {
    vi.useFakeTimers();
    try {
      const page = fakePage();
      const { host } = fakeHost({ page });
      const pending = handleCareerBrowserRoute('/api/career/browser/run', request('/api/career/browser/run', {
        body: { op: 'collect_passive', match: 'joblist.json', seconds: 5 },
      }), { host });
      const response = await pending;
      const reading = ndjson(response!);
      await vi.advanceTimersByTimeAsync(10);
      expect(page.listenerCount('response')).toBe(1);
      page.emit('response', { url: () => 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json?page=1', status: () => 200, json: async () => ({ zpData: { jobList: [1] } }) });
      page.emit('response', { url: () => 'https://www.zhipin.com/static/logo.png', status: () => 200, json: async () => { throw new Error('not json'); } });
      await vi.advanceTimersByTimeAsync(5_000);
      const lines = await reading;
      expect(lines.filter(line => line.type === 'capture')).toHaveLength(1);
      expect(lines.at(-1)).toMatchObject({
        type: 'result', op: 'collect_passive',
        captured: [{ url: expect.stringContaining('joblist.json'), status: 200, json: { zpData: { jobList: [1] } } }],
      });
      expect(page.listenerCount('response')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collectPassiveResponses', () => {
  it('matches only non-empty fragments', () => {
    expect(matchesPassiveFilter('https://a/joblist.json', ['joblist.json'])).toBe(true);
    expect(matchesPassiveFilter('https://a/joblist.json', ['', 'other'])).toBe(false);
  });

  it('stops early at max, skips non-JSON bodies and detaches the listener', async () => {
    const page = new EventEmitter() as EventEmitter & PassivePageLike;
    const onCapture = vi.fn();
    const collecting = collectPassiveResponses(page, { fragments: ['/api/'], durationMs: 60_000, max: 2, onCapture });
    const response = (url: string, body: () => Promise<unknown>) => ({ url: () => url, status: () => 200, json: body, request: () => ({ method: () => 'POST' }) });
    page.emit('response', response('https://x/api/1', async () => ({ n: 1 })));
    page.emit('response', response('https://x/api/html', async () => { throw new Error('html'); }));
    page.emit('response', response('https://x/other', async () => ({ n: 0 })));
    page.emit('response', response('https://x/api/2', async () => ({ n: 2 })));
    page.emit('response', response('https://x/api/3', async () => ({ n: 3 })));
    const captured = await collecting;
    expect(captured.map(capture => capture.json)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(captured[0]).toMatchObject({ method: 'POST', status: 200 });
    expect(onCapture).toHaveBeenCalledTimes(2);
    expect(page.listenerCount('response')).toBe(0);
  });

  it('resolves with what it has when the request is aborted', async () => {
    const page = new EventEmitter() as EventEmitter & PassivePageLike;
    const controller = new AbortController();
    const collecting = collectPassiveResponses(page, { fragments: ['x'], durationMs: 60_000, max: 10, signal: controller.signal });
    page.emit('response', { url: () => 'https://x/1', status: () => 204, json: async () => null });
    controller.abort();
    await expect(collecting).resolves.toEqual([expect.objectContaining({ status: 204, json: null })]);
    expect(page.listenerCount('response')).toBe(0);
  });
});
