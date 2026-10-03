/**
 * Global 路由 `/api/career/live/*` 与 `/api/career/batch/*`：渲染层的"浏览器现场窗"与批量投递控制。
 *
 * - 渲染层到 Global 的普通请求走 Rust 的缓冲代理（120s 上限，不能流式），所以 `stream` 必须由渲染层
 *   用原生 fetch 直连 Global 端口；响应带 `Access-Control-Allow-Origin: *`（与 /refs/ 一致）。
 * - 这组接口免能力令牌（和 /api/career/* 数据接口同一信任级别：仅 loopback、产品自己的渲染层）。
 * - 看不等于控：画面只读；接管 / 交回改控制权并前置真实 Chrome 窗口。
 */
import type { BrowserContext } from 'playwright';
import type { Repos } from '@career/core';

import type { BrowserControl, BrowserControlState } from '../browser-host/context-registry';
import { activePage, bringToFront as bringContextToFront } from '../browser-host/page-control';
import type { BrowserChannel } from '../browser-host/runtime-settings';
import type { BatchRunner, BatchState } from '../career/batch-runner';
import { BatchRunner as BatchRunnerClass } from '../career/batch-runner';
import type { LiveHub } from '../career/live-hub';
import { ScreencastHub, fromPlaywrightPage } from '../career/screencast';

export const CAREER_LIVE_PREFIX = '/api/career/live/';
export const CAREER_BATCH_PREFIX = '/api/career/batch/';

export interface CareerLiveHost {
  hasContext(productSessionId: string): boolean;
  getControl(productSessionId: string): BrowserControlState;
  setControl(productSessionId: string, control: BrowserControl, reason?: string): BrowserControlState;
  withProductSession<T>(productSessionId: string, fn: (context: BrowserContext) => Promise<T>, options?: { allowHumanControl?: boolean; signal?: AbortSignal; create?: { workspacePath: string; hostGeneration?: number } }): Promise<T>;
  browserChannel(): BrowserChannel;
}

export interface CareerLiveDeps {
  host: CareerLiveHost;
  hub: LiveHub;
  repos: Repos;
  /** 唯一的个人助理会话 id（config.careerSessionId）；没有就说明用户还没打开过对话。 */
  productSessionId: () => string | undefined;
  runner?: BatchRunner | null;
  bringToFront?: (context: BrowserContext, channel: BrowserChannel) => Promise<unknown>;
  heartbeatMs?: number;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const ok = (data: Record<string, unknown> = {}) => json({ ok: true, ...data });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try { const parsed = await request.json(); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

export interface LiveSnapshot {
  productSessionId: string | null;
  browser: { hasBrowser: boolean; control: BrowserControl | 'none'; reason: string | null; url?: string; title?: string; channel: BrowserChannel };
  batch: BatchState | null;
  openHandoffs: number;
}

export async function liveSnapshot(deps: CareerLiveDeps): Promise<LiveSnapshot> {
  const id = deps.productSessionId();
  const hasBrowser = !!id && deps.host.hasContext(id);
  let url: string | undefined; let title: string | undefined;
  if (id && hasBrowser) {
    try {
      await deps.host.withProductSession(id, async context => { const page = await activePage(context); url = page.url(); title = await page.title().catch(() => ''); }, { allowHumanControl: true });
    } catch { /* 浏览器正在关闭等，忽略 */ }
  }
  const control = id && hasBrowser ? deps.host.getControl(id) : null;
  return {
    productSessionId: id ?? null,
    browser: { hasBrowser, control: control?.control ?? 'none', reason: control?.reason ?? null, url, title, channel: deps.host.browserChannel() },
    batch: deps.runner?.state() ?? null,
    openHandoffs: deps.repos.openHandoffs().length,
  };
}

export async function handleCareerLiveRoute(pathname: string, request: Request, deps: CareerLiveDeps): Promise<Response | null> {
  if (!pathname.startsWith(CAREER_LIVE_PREFIX) && !pathname.startsWith(CAREER_BATCH_PREFIX)) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
  const method = request.method.toUpperCase();

  if (pathname === `${CAREER_LIVE_PREFIX}state` && method === 'GET') return ok({ ...(await liveSnapshot(deps)) });

  if (pathname === `${CAREER_LIVE_PREFIX}stream` && method === 'GET') return liveStream(request, deps);

  if (pathname === `${CAREER_LIVE_PREFIX}control` && method === 'POST') {
    const body = await readBody(request);
    const control = body.control === 'human' || body.control === 'agent' ? body.control : null;
    if (!control) return fail("control 必须是 'human' | 'agent'");
    const id = deps.productSessionId();
    if (!id) return fail('还没有个人助理会话', 409);
    if (!deps.host.hasContext(id)) return fail('浏览器还没有打开', 409);
    const state = deps.host.setControl(id, control, typeof body.reason === 'string' ? body.reason : control === 'human' ? 'user_request' : undefined);
    let warning: string | undefined;
    if (control === 'human') {
      try { await deps.host.withProductSession(id, context => (deps.bringToFront ?? bringContextToFront)(context, deps.host.browserChannel()), { allowHumanControl: true }); } catch (error) { warning = error instanceof Error ? error.message : String(error); }
      deps.hub.publish('career:takeover', { sessionId: id, runId: 'live', state: 'human_active', message: '你正在操作浏览器' });
    } else {
      // 交回：关掉等用户处理的填表接管，批量运行器据此从当前页继续
      let closed = 0;
      for (const h of deps.repos.openHandoffs()) {
        const action = h.action_id ? deps.repos.getAction(h.action_id) : undefined;
        if (!action || action.kind === 'fill_form') { try { deps.repos.closeHandoff(h.id, 'live_handback'); closed++; } catch { /* ignore */ } }
      }
      deps.hub.publish('career:takeover', { sessionId: id, runId: 'live', state: 'resuming', message: closed ? `已交回，继续填写（关闭 ${closed} 个接管）` : '已交回' });
      if (closed) deps.hub.publish('career:data-changed', { sessionId: id, tables: ['handoff', 'action_queue', 'task'] });
    }
    return ok({ control: state, ...(warning ? { warning } : {}) });
  }

  if (pathname === `${CAREER_BATCH_PREFIX}state` && method === 'GET') return ok({ batch: deps.runner?.state() ?? null });
  if (pathname === `${CAREER_BATCH_PREFIX}command` && method === 'POST') {
    const body = await readBody(request);
    const cmd = body.cmd === 'start' || body.cmd === 'pause' || body.cmd === 'stop' ? body.cmd : null;
    if (!cmd) return fail("cmd 必须是 'start' | 'pause' | 'stop'");
    if (!deps.runner) { BatchRunnerClass.command(deps.repos, cmd, 'renderer'); return ok({ queued: true }); }
    const state = cmd === 'start' ? deps.runner.start() : cmd === 'pause' ? deps.runner.pause() : deps.runner.stop();
    return ok({ batch: state });
  }
  return fail(`未知接口：${method} ${pathname}`, 404);
}

/** NDJSON 长连接：snapshot → hub 事件 →（可选）截图帧 → 心跳。 */
function liveStream(request: Request, deps: CareerLiveDeps): Response {
  const url = new URL(request.url);
  const wantFrames = url.searchParams.get('frames') === '1';
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: Record<string, unknown>) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)); } catch { closed = true; }
      };
      const onAbort = () => { if (!abort.signal.aborted) abort.abort(); };
      if (request.signal.aborted) onAbort(); else request.signal.addEventListener('abort', onAbort, { once: true });

      void liveSnapshot(deps).then(snapshot => write({ type: 'snapshot', ts: Date.now(), ...snapshot })).catch(e => write({ type: 'error', error: e instanceof Error ? e.message : String(e) }));
      const unsub = deps.hub.subscribe(ev => write(ev));
      const heartbeat = setInterval(() => write({ type: 'heartbeat', ts: Date.now() }), deps.heartbeatMs ?? 10_000);

      let unsubFrames: (() => void) | null = null;
      if (wantFrames) {
        const id = deps.productSessionId();
        if (id && deps.host.hasContext(id)) {
          // 持有一个租约直到连接断开：没有租约的话 15 秒后 Context 会被回收
          void deps.host.withProductSession(id, async context => {
            const hub = new ScreencastHub(async () => fromPlaywrightPage(await activePage(context)), { quality: 55, maxWidth: 1280, maxHeight: 900, everyNthFrame: 2, log: msg => { console.warn(`[career-live] ${msg}`); if (/失败/.test(msg)) write({ type: 'frame-error', error: msg }); } });
            unsubFrames = hub.subscribe(frame => write({ type: 'frame', ...frame }));
            const onPage = () => { void hub.refresh(); };
            context.on('page', onPage);
            await new Promise<void>(resolve => { if (abort.signal.aborted) resolve(); else abort.signal.addEventListener('abort', () => resolve(), { once: true }); });
            unsubFrames?.(); unsubFrames = null;
            await hub.stop();
          }, { allowHumanControl: true, signal: abort.signal }).catch(e => write({ type: 'frame-error', error: e instanceof Error ? e.message : String(e) }));
        } else {
          write({ type: 'frame-error', error: id ? '浏览器还没有打开；助理开始填表或你开始批量投递后画面会出现' : '还没有个人助理会话' });
        }
      }

      abort.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        unsub();
        unsubFrames?.();
        request.signal.removeEventListener('abort', onAbort);
        if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } }
      }, { once: true });
    },
    cancel() { if (!abort.signal.aborted) abort.abort(); },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...CORS } });
}
