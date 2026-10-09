import type { BrowserContext, Page } from 'playwright';

import type { VerifiedBrowserCapability } from '../browser-host/capability-client';
import type { BrowserControl, BrowserControlState } from '../browser-host/context-registry';
import { bringToFront as bringContextToFront } from '../browser-host/page-control';
import type { BrowserChannel } from '../browser-host/runtime-settings';
import { lockPage, pageForApplication, releaseApplicationPage, unlockPage } from '../career/app-pages';

/**
 * Global 路由 `/api/career/browser/*`：接管状态锁、窗口前置、把托管 Context 的
 * Page 交给 `@career/apply` 表单引擎。鉴权沿用 `/mcp/playwright` 的 Rust 签发
 * Bearer capability；白名单登记在 sidecar-composition 由后端路由负责。
 */
export const CAREER_BROWSER_ROUTE_PREFIX = '/api/career/browser/';

const MAX_RUN_BODY_BYTES = 1024 * 1024;
const PASSIVE_DEFAULT_SECONDS = 10;
const PASSIVE_MAX_SECONDS = 120;
const PASSIVE_DEFAULT_MAX = 50;
const PASSIVE_HARD_MAX = 500;
const DRIVE_DEFAULT_MAX_PAGES = 6;

export interface CareerBrowserHost {
  verifyCapability(token: string, signal?: AbortSignal): Promise<VerifiedBrowserCapability>;
  withContext<T>(
    token: string,
    fn: (context: BrowserContext, binding: VerifiedBrowserCapability) => Promise<T>,
    options?: { allowHumanControl?: boolean; signal?: AbortSignal },
  ): Promise<T>;
  hasContext(productSessionId: string): boolean;
  getControl(productSessionId: string): BrowserControlState;
  setControl(productSessionId: string, control: BrowserControl, reason?: string): BrowserControlState;
  browserChannel(): BrowserChannel;
  /** 内嵌窗口模式：接管时不前置真实 Chrome（用户在产品画面里操作）。 */
  embeddedWindow?(): boolean;
  isWindowRevealed?(productSessionId: string): boolean;
  /** 让现场画面 / 输入转发切到这一页（多份网申各有页面时）。 */
  focusPage?(productSessionId: string, page: Page): void;
}

/** 只依赖 `@career/apply` 公开 API 的最小形状；包本体按需动态加载。 */
export interface ApplyEngineModule {
  fromPlaywright(page: Page): ApplyPageLike;
  diagnosePage(page: ApplyPageLike, options?: { url?: string }): Promise<unknown>;
  driveApplication(
    page: ApplyPageLike,
    llm: LlmLike,
    profile: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown> & { screenshot?: Uint8Array }>;
  /** 从 Repos + 私密库组装填表资料（basics 明文只在 Node 侧）。 */
  ApplyService?: new (repos: unknown, llm: LlmLike, defaults?: { vault?: unknown }) => { buildProfile(resumePath?: string): Record<string, unknown> };
  /** 站点映射记忆（kv）：别名认不出的字段按上次记录直填；读回核对通过的记下来。 */
  SiteMemory?: new (store: { kvGet<T>(key: string): T | undefined; kvSet(key: string, value: unknown): void }) => unknown;
  /** 视觉兜底层（L2）的感知器构件；旧版本的包没有这些导出时只走 DOM 层。 */
  DomBoxPerceiver?: new (page: ApplyPageLike) => PerceiverLike;
  composePerceivers?: (perceivers: PerceiverLike[], id?: string) => PerceiverLike;
  synthesizeInputsFromLabels?: (p: unknown) => unknown;
  VlmPerceiver?: new (llm: LlmLike, base?: PerceiverLike) => PerceiverLike;
  /** 提交执行器（只在 submit 动作被批准后调用）。 */
  submitApplication?: (page: ApplyPageLike, options?: Record<string, unknown>) => Promise<Record<string, unknown> & { screenshot?: Uint8Array }>;
}

export interface PerceiverLike {
  id: string;
  perceive(screenshot: Uint8Array, ctx: { viewport: { width: number; height: number }; url?: string; hint?: string }): Promise<unknown>;
}

/** `drive` 的资料包：资料本体 + 私密库三个钩子（解占位符 / 登录代填 / 回传脱敏）。 */
export interface DriveProfileBundle {
  profile: Record<string, unknown>;
  resolveValue?: (value: string) => string;
  loginFill?: (url: string) => { username?: string; password?: string } | undefined;
  redact?: <T>(value: T) => T;
}

export interface ApplyPageLike {
  goto(url: string): Promise<void>;
  url(): string;
}

export interface LlmLike {
  complete(request: unknown): Promise<unknown>;
  supportsImages?(): boolean;
}

export interface CareerBrowserRouteDependencies {
  host: CareerBrowserHost;
  bringToFront?: (context: BrowserContext, channel: BrowserChannel) => Promise<unknown>;
  loadApply?: () => Promise<ApplyEngineModule | null>;
  /** `drive` 需要模型。由后端组合层通过 {@link registerCareerBrowserLlmResolver} 接入。 */
  resolveLlm?: () => Promise<LlmLike | null>;
  /**
   * `drive` 的资料：缺省在 Node 侧从求职 SQLite + 私密库组装（见 {@link defaultDriveProfile}），
   * 调用方（模型工具）不传、也拿不到 basics 明文。请求体里的 `profile` 只作测试 / 兜底。
   */
  resolveDriveProfile?: (body: Record<string, unknown>, apply: ApplyEngineModule, llm: LlmLike) => Promise<DriveProfileBundle | null>;
  /** `drive` 的视觉兜底感知器；缺省 {@link defaultPerceiver}（DOM 盒子 + macOS OCR，可选视觉模型）。返回 undefined 则只走 DOM 层。 */
  createPerceiver?: (apply: ApplyEngineModule, page: ApplyPageLike, llm: LlmLike) => Promise<PerceiverLike | undefined>;
  /** 产品会话 id：每份网申一个页面、页面锁都按它分区（借用代理每次都是新对象，不能拿 context 当键）。 */
  productSessionId?: string;
  /** 让现场画面切到这一页（registry 的选中页）。force：遇到接管时无论如何切过去，让用户看到要处理的那一页。 */
  focusPage?: (page: Page, force?: boolean) => void;
  /** submit 的私密库钩子：把 filled 里的占位符解成明文再与页面比对、回传前脱敏。缺省用私密库单例。 */
  resolveSubmitVault?: () => Promise<{ resolve(v: string): string; redact<T>(v: T): T } | null>;
}

let registeredLlmResolver: (() => Promise<LlmLike | null>) | null = null;

/**
 * 缺省感知器：DOM 盒子（零成本）+ macOS Vision OCR（只认字，再按标签位置合成输入框）合并；
 * 设 CAREER_VISION_VLM=1 且模型支持图片时，再包一层视觉模型做分类 / 补充。任一构件缺失就降级，不报错。
 */
export async function defaultPerceiver(apply: ApplyEngineModule, page: ApplyPageLike, llm: LlmLike): Promise<PerceiverLike | undefined> {
  const layers: PerceiverLike[] = [];
  if (typeof apply.DomBoxPerceiver === 'function') layers.push(new apply.DomBoxPerceiver(page));
  if (process.env.CAREER_VISION_OCR !== '0') {
    try {
      const { AppleVisionOcrPerceiver, appleVisionAvailable } = await import('../career/perceivers/apple-vision-ocr');
      if (appleVisionAvailable()) {
        const ocr = new AppleVisionOcrPerceiver();
        const synth = apply.synthesizeInputsFromLabels;
        layers.push(synth ? { id: 'apple-vision-ocr+labels', perceive: async (s, c) => synth(await ocr.perceive(s, c)) } : ocr);
      }
    } catch (error) {
      console.warn('[career] OCR 感知器不可用：', error instanceof Error ? error.message : error);
    }
  }
  if (!layers.length) return undefined;
  const base = layers.length > 1 && typeof apply.composePerceivers === 'function' ? apply.composePerceivers(layers) : layers[0];
  if (process.env.CAREER_VISION_VLM === '1' && typeof apply.VlmPerceiver === 'function' && llm.supportsImages?.()) return new apply.VlmPerceiver(llm, base);
  return base;
}

/** 缺省资料组装：basics 来自私密库（兜底 kv:profile.basics），经历 / 答案库来自 Repos；三个钩子都绑到私密库。 */
export async function defaultDriveProfile(body: Record<string, unknown>, apply: ApplyEngineModule, llm: LlmLike): Promise<DriveProfileBundle | null> {
  if (typeof apply.ApplyService !== 'function') return null;
  const [{ getRepos }, { getVault }] = await Promise.all([import('../career/db'), import('../career/vault')]);
  const [repos, vault] = await Promise.all([getRepos(), getVault()]);
  const resumePath = typeof body.resumePath === 'string' && body.resumePath.trim() ? body.resumePath.trim() : undefined;
  const profile = new apply.ApplyService(repos, llm, { vault }).buildProfile(resumePath);
  const purpose = typeof body.applicationId === 'string' ? `网申填表 ${body.applicationId}` : '网申填表';
  return {
    profile,
    resolveValue: value => vault.resolve(value, { actor: 'form_fill', purpose }),
    loginFill: url => {
      const cred = vault.credential(url, { actor: 'login_fill', purpose: `登录页代填 ${url}` });
      return cred && cred.autofill ? { username: cred.username, password: cred.password } : undefined;
    },
    redact: value => vault.redactDeep(value),
  };
}

/** 后端组合层在启动时注册一次；未注册时 `op:'drive'` 返回 501。 */
export function registerCareerBrowserLlmResolver(resolver: (() => Promise<LlmLike | null>) | null): void {
  registeredLlmResolver = resolver;
}

function applyModuleSpecifiers(): string[] {
  const candidates = [
    process.env.CAREER_APPLY_MODULE?.trim(),
    '@career/apply',
    // 开发态：shell/src/server/routes → app/packages/apply/dist
    new URL('../../../../packages/apply/dist/index.js', import.meta.url).href,
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

let applyModulePromise: Promise<ApplyEngineModule | null> | null = null;

async function loadApplyModule(): Promise<ApplyEngineModule | null> {
  if (!applyModulePromise) {
    applyModulePromise = (async () => {
      for (const specifier of applyModuleSpecifiers()) {
        try {
          const loaded = await import(/* @vite-ignore */ specifier) as Partial<ApplyEngineModule>;
          if (
            typeof loaded.fromPlaywright === 'function'
            && typeof loaded.diagnosePage === 'function'
            && typeof loaded.driveApplication === 'function'
          ) {
            return loaded as ApplyEngineModule;
          }
        } catch {
          continue;
        }
      }
      return null;
    })();
    // A later build of the package must become loadable without a restart.
    void applyModulePromise.then(loaded => { if (!loaded) applyModulePromise = null; });
  }
  return applyModulePromise;
}

// ---------------------------------------------------------------------------
// 被动捕获：只监听当前页自己发出的响应，不注入、不重放请求。
// ---------------------------------------------------------------------------

export interface PassiveResponseLike {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
  request?(): { method(): string };
}

export interface PassivePageLike {
  on(event: 'response', listener: (response: PassiveResponseLike) => void): unknown;
  off(event: 'response', listener: (response: PassiveResponseLike) => void): unknown;
}

export interface PassiveCapture {
  url: string;
  status: number;
  method: string;
  json: unknown;
  at: number;
}

export interface PassiveCollectOptions {
  fragments: string[];
  durationMs: number;
  max: number;
  signal?: AbortSignal;
  onCapture?: (capture: PassiveCapture) => void;
  now?: () => number;
}

export function matchesPassiveFilter(url: string, fragments: readonly string[]): boolean {
  return fragments.some(fragment => fragment.length > 0 && url.includes(fragment));
}

export function collectPassiveResponses(
  page: PassivePageLike,
  options: PassiveCollectOptions,
): Promise<PassiveCapture[]> {
  const now = options.now ?? Date.now;
  const captured: PassiveCapture[] = [];
  const pendingBodies = new Set<Promise<void>>();
  let settled = false;
  return new Promise<PassiveCapture[]>(resolve => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', finish);
      page.off('response', listener);
      void Promise.allSettled([...pendingBodies]).then(() => resolve(captured));
    };
    const listener = (response: PassiveResponseLike) => {
      if (settled) return;
      const url = response.url();
      if (!matchesPassiveFilter(url, options.fragments)) return;
      if (captured.length >= options.max) return;
      // 非 JSON 响应会在解析时被丢弃，所以配额只按已落袋的捕获计算。
      const body = response.json()
        .then(json => {
          if (captured.length >= options.max) return;
          const capture: PassiveCapture = {
            url,
            status: response.status(),
            method: response.request?.().method() ?? 'GET',
            json,
            at: now(),
          };
          captured.push(capture);
          options.onCapture?.(capture);
          if (captured.length >= options.max) finish();
        })
        // 非 JSON（图片 / HTML）不是我们要的数据，跳过即可。
        .catch(() => {})
        .finally(() => pendingBodies.delete(body));
      pendingBodies.add(body);
    };
    const timer = setTimeout(finish, options.durationMs);
    timer.unref?.();
    page.on('response', listener);
    if (options.signal?.aborted) finish();
    else options.signal?.addEventListener('abort', finish, { once: true });
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function failure(status: number, error: string, code?: string): Response {
  return jsonResponse({ ok: false, error, ...(code ? { code } : {}) }, status);
}

function extractBearer(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return /^[a-f0-9]{32}$/.test(token) ? token : null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_RUN_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_RUN_BODY_BYTES) return null;
    const parsed: unknown = text.trim() ? JSON.parse(text) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name !== 'Error' ? error.name : '';
}

function errorResponse(error: unknown, fallback: string): Response {
  const name = errorName(error);
  if (name === 'BROWSER_CAPABILITY_INVALID') return failure(401, '浏览器凭据无效或已过期', name);
  if (name === 'BROWSER_CONTROL_HUMAN') return failure(409, error instanceof Error ? error.message : fallback, name);
  if (name === 'BROWSER_HOST_STOPPING') return failure(503, '浏览器服务正在停止', name);
  if (name.startsWith('BROWSER_RESOURCE_')) return failure(503, '浏览器资源尚未就绪', name);
  console.warn(`[career-browser] request=failed error=${name || 'unknown'}`);
  return failure(500, error instanceof Error && error.message ? error.message : fallback, name || undefined);
}

function parseControl(value: unknown): BrowserControl | null {
  return value === 'agent' || value === 'human' ? value : null;
}

function parseFragments(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim());
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

// ---------------------------------------------------------------------------
// NDJSON run
// ---------------------------------------------------------------------------

export type NdjsonLine = Record<string, unknown> & { type: 'progress' | 'page' | 'capture' | 'result' | 'error' };

export interface RunEmitter {
  emit(line: NdjsonLine): void;
  aborted(): boolean;
}

export type CareerBrowserOp = 'screenshot' | 'diagnose' | 'drive' | 'collect_passive' | 'submit' | 'release';

/**
 * HTTP 路由（能力令牌）只开放这四种；submit / release 只能由 Global 进程内的提交执行器直接调用 runOperation——
 * 提交必须先在动作队列里被批准并认领，不能被任何持有浏览器令牌的调用方绕过。
 */
const OPS: ReadonlySet<string> = new Set<CareerBrowserOp>(['screenshot', 'diagnose', 'drive', 'collect_passive']);

/** 在已借到的 Context 上执行一次操作（路由与 Global 批量运行器共用）。 */
export async function runOperation(
  op: CareerBrowserOp,
  body: Record<string, unknown>,
  context: BrowserContext,
  out: RunEmitter,
  signal: AbortSignal,
  deps: CareerBrowserRouteDependencies,
): Promise<void> {
  // 每份网申一个页面：带 applicationId（或 actionId）的操作落到这份网申自己的页上
  const sessionKey = deps.productSessionId ?? 'default';
  const appKey = typeof body.applicationId === 'string' && body.applicationId ? body.applicationId : typeof body.actionId === 'string' && body.actionId ? body.actionId : undefined;
  if (op === 'release') {
    if (appKey) await releaseApplicationPage(context, sessionKey, appKey);
    out.emit({ type: 'result', op, released: !!appKey });
    return;
  }
  let page: Page;
  try {
    page = await pageForApplication(context, sessionKey, appKey, op === 'submit' ? 'submit' : op === 'drive' && !(typeof body.url === 'string' && body.url.trim()) ? 'continue' : 'start');
  } catch (error) {
    out.emit({ type: 'error', status: 410, code: errorName(error) ?? 'APPLICATION_PAGE_GONE', error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (appKey) deps.focusPage?.(page);
  if (op === 'screenshot') {
    out.emit({ type: 'progress', phase: 'screenshot', message: '正在截图' });
    const bytes = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: body.fullPage === true });
    out.emit({
      type: 'result', op, mimeType: 'image/jpeg', base64: toBase64(bytes),
      url: page.url(), title: await page.title().catch(() => ''),
    });
    return;
  }
  if (op === 'collect_passive') {
    const fragments = parseFragments(body.match ?? body.urlIncludes);
    if (fragments.length === 0) {
      out.emit({ type: 'error', status: 400, error: 'collect_passive 需要 match（URL 片段或片段数组）' });
      return;
    }
    const seconds = clampNumber(body.seconds, PASSIVE_DEFAULT_SECONDS, 1, PASSIVE_MAX_SECONDS);
    const max = clampNumber(body.max, PASSIVE_DEFAULT_MAX, 1, PASSIVE_HARD_MAX);
    out.emit({ type: 'progress', phase: 'listen', message: `监听 ${seconds} 秒内匹配 ${fragments.join(' | ')} 的响应`, seconds, fragments });
    const captured = await collectPassiveResponses(page as unknown as PassivePageLike, {
      fragments,
      durationMs: seconds * 1000,
      max,
      signal,
      onCapture: capture => out.emit({ type: 'capture', url: capture.url, status: capture.status, method: capture.method }),
    });
    out.emit({ type: 'result', op, captured, url: page.url() });
    return;
  }

  const apply = await (deps.loadApply ?? loadApplyModule)();
  if (!apply) {
    out.emit({ type: 'error', status: 501, error: '表单引擎 @career/apply 尚未构建或不可加载（请先 pnpm -C packages/apply build）' });
    return;
  }
  const engineLikePage = apply.fromPlaywright(page);
  const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined;
  if (op === 'diagnose') {
    out.emit({ type: 'progress', phase: 'diagnose', message: url ? `打开 ${url} 并预检` : '预检当前页面' });
    const diagnosis = await apply.diagnosePage(engineLikePage, url ? { url } : {});
    out.emit({ type: 'result', op, diagnosis, url: page.url() });
    return;
  }

  if (op === 'submit') {
    await runSubmit(apply, page, body, out, deps, sessionKey, appKey, context);
    return;
  }

  // op === 'drive'：同一个页面同时只允许一处在操作（对话 apply_run 与后台批量可能指向同一份网申）
  const owner = typeof body.actionId === 'string' && body.actionId ? body.actionId : typeof body.runId === 'string' ? body.runId : 'anonymous';
  const holder = lockPage(page, owner);
  if (holder) {
    out.emit({ type: 'error', status: 409, code: 'BROWSER_BUSY', error: `这份网申的页面正在被另一处操作（${holder}），等它结束或先暂停后台批量投递` });
    return;
  }
  try {
    const llm = await (deps.resolveLlm ?? registeredLlmResolver ?? (async () => null))();
    if (!llm) {
      out.emit({ type: 'error', status: 501, error: 'drive 需要模型实例，产品组合层尚未注册 LLM' });
      return;
    }
    // 资料在 Node 侧组装：basics 明文来自私密库，不经过模型；请求体 profile 只作测试 / 兜底
    let bundle: DriveProfileBundle | null = null;
    if (body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)) {
      bundle = { profile: body.profile as Record<string, unknown> };
    } else {
      try {
        bundle = await (deps.resolveDriveProfile ?? defaultDriveProfile)(body, apply, llm);
      } catch (error) {
        out.emit({ type: 'error', status: 503, error: `组装填表资料失败：${error instanceof Error ? error.message : String(error)}` });
        return;
      }
    }
    if (!bundle) {
      out.emit({ type: 'error', status: 400, error: 'drive 需要填表资料：请在「私密信息」页填写基本信息，或传 profile 对象（basics / experiences / answerBank）' });
      return;
    }
    const redact = bundle.redact ?? (<T,>(v: T) => v);
    if (url) {
      out.emit({ type: 'progress', phase: 'navigate', message: `打开 ${url}` });
      await engineLikePage.goto(url);
    }
    let perceiver: PerceiverLike | undefined;
    if (body.vision !== false) {
      try { perceiver = await (deps.createPerceiver ?? defaultPerceiver)(apply, engineLikePage, llm); } catch (error) { out.emit({ type: 'progress', phase: 'drive', message: `视觉兜底层不可用：${error instanceof Error ? error.message : String(error)}` }); }
    }
    // 站点映射记忆（kv，与求职库同一连接）；测试给 body.profile 时不动真实库
    let siteMemory: unknown;
    if (typeof apply.SiteMemory === 'function' && !body.profile) {
      try { const { getRepos } = await import('../career/db'); siteMemory = new apply.SiteMemory(await getRepos()); } catch { /* 数据层未就绪就不记 */ }
    }
    out.emit({ type: 'progress', phase: 'drive', message: `开始填写（不提交）${perceiver ? `，视觉兜底：${perceiver.id}` : ''}` });
    const result = await apply.driveApplication(engineLikePage, llm, bundle.profile, {
      maxPages: clampNumber(body.maxPages, DRIVE_DEFAULT_MAX_PAGES, 1, 20),
      humanTyping: body.humanTyping !== false,
      ...(typeof body.settleMs === 'number' ? { settleMs: body.settleMs } : {}),
      ...(bundle.resolveValue ? { resolveValue: bundle.resolveValue } : {}),
      ...(bundle.loginFill ? { loginFill: bundle.loginFill } : {}),
      ...(perceiver ? { perceiver } : {}),
      ...(siteMemory ? { siteMemory } : {}),
      ...(Array.isArray(body.learnFrom) ? { learnFrom: (body.learnFrom as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
      log: (message: string) => out.emit({ type: 'progress', phase: 'drive', message: redact(message) }),
      onPage: (record: unknown) => out.emit({ type: 'page', record: redact(record) }),
    });
    const { screenshot, ...rest } = result;
    if (rest.status === 'handoff') deps.focusPage?.(page, true);
    out.emit({
      type: 'result', op,
      result: redact(rest),
      ...(screenshot ? { screenshot: { mimeType: 'image/jpeg', base64: toBase64(screenshot) } } : {}),
      url: page.url(),
    });
  } finally {
    unlockPage(page, owner);
  }
}

/**
 * 提交：只由提交执行器在 submit 动作被认领（approved → executing）之后调用。
 * filled 里的私密库占位符先解成明文再与页面比对（否则会被误判成"用户改过"）；回传前统一脱敏。
 * 提交成功后关掉这份网申的页面。
 */
async function runSubmit(apply: ApplyEngineModule, page: Page, body: Record<string, unknown>, out: RunEmitter, deps: CareerBrowserRouteDependencies, sessionKey: string, appKey: string | undefined, context: BrowserContext): Promise<void> {
  if (typeof apply.submitApplication !== 'function') {
    out.emit({ type: 'error', status: 501, error: '表单引擎版本过旧，没有提交执行器（请重新构建 @career/apply）' });
    return;
  }
  const owner = `submit:${typeof body.actionId === 'string' ? body.actionId : appKey ?? 'anonymous'}`;
  const holder = lockPage(page, owner);
  if (holder) { out.emit({ type: 'error', status: 409, code: 'BROWSER_BUSY', error: `这份网申的页面正在被另一处操作（${holder}）` }); return; }
  try {
    const vault = body.profile ? null : await (deps.resolveSubmitVault ?? defaultSubmitVault)().catch(() => null);
    const filled = Array.isArray(body.filled) ? (body.filled as Array<Record<string, unknown>>).map(f => ({ ...f, value: vault && typeof f.value === 'string' ? vault.resolve(f.value) : f.value })) : undefined;
    out.emit({ type: 'progress', phase: 'submit', message: `正在提交${typeof body.submitButton === 'string' ? `（「${body.submitButton}」）` : ''}` });
    const result = await apply.submitApplication(apply.fromPlaywright(page), {
      ...(typeof body.submitButton === 'string' ? { expectedButton: body.submitButton } : {}),
      ...(filled ? { filled } : {}),
      ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
      ...(typeof body.pollMs === 'number' ? { pollMs: body.pollMs } : {}),
      log: (message: string) => out.emit({ type: 'progress', phase: 'submit', message }),
    });
    const { screenshot, ...rest } = result;
    out.emit({ type: 'result', op: 'submit', result: vault ? vault.redact(rest) : rest, ...(screenshot ? { screenshot: { mimeType: 'image/jpeg', base64: toBase64(screenshot) } } : {}), url: page.url() });
    if (rest.status === 'submitted' && appKey) await releaseApplicationPage(context, sessionKey, appKey);
  } finally {
    unlockPage(page, owner);
  }
}

async function defaultSubmitVault(): Promise<{ resolve(v: string): string; redact<T>(v: T): T }> {
  const { getVault } = await import('../career/vault');
  const vault = await getVault();
  return { resolve: v => vault.resolve(v, { actor: 'form_fill', purpose: '提交前核对页面值' }), redact: v => vault.redactDeep(v) };
}

function ndjsonStream(
  request: Request,
  work: (out: RunEmitter, signal: AbortSignal) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const out: RunEmitter = {
        emit: line => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            closed = true;
          }
        },
        aborted: () => abort.signal.aborted,
      };
      const onRequestAbort = () => abort.abort();
      if (request.signal.aborted) onRequestAbort();
      else request.signal.addEventListener('abort', onRequestAbort, { once: true });
      void work(out, abort.signal)
        .catch(error => {
          const name = errorName(error);
          out.emit({
            type: 'error',
            status: name === 'BROWSER_CONTROL_HUMAN' ? 409 : name === 'BROWSER_CAPABILITY_INVALID' ? 401 : 500,
            error: error instanceof Error && error.message ? error.message : '浏览器操作失败',
            ...(name ? { code: name } : {}),
          });
        })
        .finally(() => {
          request.signal.removeEventListener('abort', onRequestAbort);
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* already closed by the consumer */ }
          }
        });
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleCareerBrowserRoute(
  pathname: string,
  request: Request,
  deps: CareerBrowserRouteDependencies,
): Promise<Response | null> {
  if (!pathname.startsWith(CAREER_BROWSER_ROUTE_PREFIX)) return null;
  const action = pathname.slice(CAREER_BROWSER_ROUTE_PREFIX.length);
  if (!['control', 'state', 'run'].includes(action)) return null;
  const { host } = deps;
  const token = extractBearer(request);
  if (!token) return failure(401, '需要浏览器凭据（Bearer capability token）', 'BROWSER_CAPABILITY_REQUIRED');

  if (action === 'state') {
    if (request.method !== 'GET') return failure(405, 'Method not allowed');
    try {
      const binding = await host.verifyCapability(token, request.signal);
      const control = host.getControl(binding.productSessionId);
      if (!host.hasContext(binding.productSessionId)) {
        return jsonResponse({ ok: true, ...control, open: false, url: null, title: null });
      }
      const pageState = await host.withContext(token, async context => {
        const page = context.pages().find(candidate => !candidate.isClosed());
        if (!page) return { url: null, title: null, pages: 0 };
        return { url: page.url(), title: await page.title().catch(() => ''), pages: context.pages().length };
      }, { allowHumanControl: true, signal: request.signal });
      return jsonResponse({ ok: true, ...control, open: true, ...pageState });
    } catch (error) {
      return errorResponse(error, '读取浏览器状态失败');
    }
  }

  if (request.method !== 'POST') return failure(405, 'Method not allowed');
  const body = await readJsonBody(request);
  if (!body) return failure(400, '请求体必须是 JSON 对象');

  if (action === 'control') {
    const control = parseControl(body.control);
    if (!control) return failure(400, "control 必须是 'agent' 或 'human'");
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    try {
      if (control === 'agent') {
        // Handing back never launches a browser the user may have closed.
        const binding = await host.verifyCapability(token, request.signal);
        return jsonResponse({ ok: true, ...host.setControl(binding.productSessionId, 'agent', reason) });
      }
      const state = await host.withContext(token, async (context, binding) => {
        const embedded = (host.embeddedWindow?.() ?? false) && !(host.isWindowRevealed?.(binding.productSessionId) ?? false);
        if (!embedded) {
          try {
            await (deps.bringToFront ?? ((ctx, channel) => bringContextToFront(ctx, { channel })))(context, host.browserChannel());
          } catch (error) {
            console.warn(`[career-browser] bring-to-front=failed error=${errorName(error) || 'unknown'}`);
          }
        }
        return host.setControl(binding.productSessionId, 'human', reason);
      }, { allowHumanControl: true, signal: request.signal });
      return jsonResponse({ ok: true, ...state });
    } catch (error) {
      return errorResponse(error, '切换浏览器控制权失败');
    }
  }

  // action === 'run'
  const op = typeof body.op === 'string' && OPS.has(body.op) ? body.op as CareerBrowserOp : null;
  if (!op) return failure(400, "op 必须是 'screenshot' | 'diagnose' | 'drive' | 'collect_passive'");
  let binding: VerifiedBrowserCapability;
  try {
    binding = await host.verifyCapability(token, request.signal);
  } catch (error) {
    return errorResponse(error, '浏览器凭据校验失败');
  }
  const control = host.getControl(binding.productSessionId);
  if (control.control === 'human') {
    return failure(409, '用户正在接管浏览器，等待交回', 'BROWSER_CONTROL_HUMAN');
  }
  return ndjsonStream(request, (out, signal) => host.withContext(
    token,
    (context, b) => runOperation(op, body, context, out, signal, { ...deps, productSessionId: b.productSessionId, focusPage: page => host.focusPage?.(b.productSessionId, page) }),
    { signal },
  ));
}
