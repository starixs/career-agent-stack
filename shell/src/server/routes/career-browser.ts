import type { BrowserContext, Page } from 'playwright';
import type { VerificationHandler } from '@career/apply';
import { getCaptchaPolicy } from '../career/captcha-automation';

import type { VerifiedBrowserCapability } from '../browser-host/capability-client';
import type { BrowserControl, BrowserControlState } from '../browser-host/context-registry';
import { bringToFront as bringContextToFront } from '../browser-host/page-control';
import type { BrowserChannel } from '../browser-host/runtime-settings';
import { adoptApplicationPage, lockPage, pageForApplication, releaseApplicationPage, unlockPage } from '../career/app-pages';

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
  /** 托管 Chrome 的 profile 目录：前置时按它找进程号，不按应用 ID（会碰到用户自己的 Chrome）。 */
  profileDirFor?(productSessionId: string): string | null;
  /** 让现场画面 / 输入转发切到这一页（多份网申各有页面时）。 */
  focusPage?(productSessionId: string, page: Page): void;
}

/** 只依赖 `@career/apply` 公开 API 的最小形状；包本体按需动态加载。 */
export interface ApplyEngineModule {
  fromPlaywright(page: Page): ApplyPageLike;
  /** 手机验证码登录：替他填号、勾协议、点获取验证码 / 填上他报的码点登录（旧版本的包没有就不代办）。 */
  prepareSmsLogin?: (page: ApplyPageLike, phone: string) => Promise<{ status: 'sent'; agreed: boolean } | { status: 'captcha'; evidence: string } | { status: 'no_sms'; reason: string }>;
  submitSmsCode?: (page: ApplyPageLike, code: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 邮箱验证码登录 / 注册：切掉扫码框、填邮箱（注册再填密码）、点获取验证码 / 填上码点登录或注册（旧版本的包没有就不代办）。 */
  prepareEmailRegister?: (page: ApplyPageLike, account: { email: string; password: string }) => Promise<{ status: 'sent'; agreed: boolean; withPassword: boolean } | { status: 'captcha'; evidence: string } | { status: 'image_code'; withPassword: boolean } | { status: 'no_register'; reason: string }>;
  /** 存过的账号密码登录：填上点登录；弹图形码就报 image_code，他打的字由 submitPasswordLogin 填回去再点登录。 */
  preparePasswordLogin?: (page: ApplyPageLike, cred: { username: string; password: string }) => Promise<{ status: 'submitted' } | { status: 'image_code' } | { status: 'captcha'; evidence: string } | { status: 'no_form'; reason: string }>;
  submitPasswordLogin?: (page: ApplyPageLike, imageText: string) => Promise<{ status: 'submitted' } | { status: 'image_code' } | { status: 'captcha'; evidence: string } | { status: 'no_form'; reason: string }>;
  /** 图形码：图给他看、他打的字填回去点确认（不识别、不代填）。 */
  imageCodeDataUrl?: (page: ApplyPageLike) => Promise<string | null>;
  findImageCode?: (page: ApplyPageLike) => Promise<{ input: string; image: string } | null>;
  refreshImageCode?: (page: ApplyPageLike) => Promise<string | null | undefined>;
  imageCodeGone?: (page: ApplyPageLike) => Promise<boolean>;
  answerImageCode?: (page: ApplyPageLike, text: string) => Promise<{ status: 'sent' } | { status: 'captcha'; evidence: string } | { status: 'image_code' } | { status: 'unseen' }>;
  submitRegisterCode?: (page: ApplyPageLike, code: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 收码登录后网站要「首次登录 · 设置密码」：填上生成的密码点确定（没有这个框返回 false）。 */
  setFirstPassword?: (page: ApplyPageLike, password: string) => Promise<boolean>;
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
  /** 提交词 / 入口词判断与站点适配器（自主找路的点击闸用）。 */
  isSubmitText?: (text: string) => boolean;
  isEntryText?: (text: string, adapter?: unknown) => boolean;
  pickAdapter?: (url: string) => unknown;
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
  bringToFront?: (context: BrowserContext, channel: BrowserChannel, profileDir?: string | null) => Promise<unknown>;
  loadApply?: () => Promise<ApplyEngineModule | null>;
  /** `drive` 需要模型。由后端组合层通过 {@link registerCareerBrowserLlmResolver} 接入。 */
  resolveLlm?: () => Promise<LlmLike | null>;
  /** 测试注入；实际配置只从本机 verification.json 读取，不能由模型请求覆盖。 */
  verify?: VerificationHandler;
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
  /**
   * drive 的运行记录位置（`$CAREER_DATA_DIR/runs/<actionId|runId>/`：trace.jsonl / 小截图 / 失败 DOM 片段 / summary.json）。
   * 缺省 {@link defaultTelemetry}；返回 null 不记录（测试 / body.telemetry === false）。
   */
  resolveTelemetry?: (body: Record<string, unknown>) => Promise<{ dir: string; runId: string; keep?: number } | null>;
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
      const { runWindowsOcr, windowsOcrAvailable } = await import('../career/perceivers/windows-ocr');
      // macOS 用 Vision；Windows 用系统自带的 Windows.Media.Ocr（同一输出格式，复用同一套坐标换算）
      if (appleVisionAvailable() || windowsOcrAvailable()) {
        const ocr = windowsOcrAvailable() ? new AppleVisionOcrPerceiver({ runImpl: path => runWindowsOcr(path) }) : new AppleVisionOcrPerceiver();
        // 熔断：OCR 小程序坏了（崩溃 / 超时）连续两次就先跳过，不让每页都卡到超时
        const { withBreaker } = await import('../career/perceivers/breaker');
        const perceive = withBreaker('OCR 识别', (shot: Parameters<typeof ocr.perceive>[0], ctx: Parameters<typeof ocr.perceive>[1]) => ocr.perceive(shot, ctx), { log: msg => console.warn(`[career] ${msg}`) });
        const synth = apply.synthesizeInputsFromLabels;
        const ocrId = windowsOcrAvailable() ? 'windows-ocr' : 'apple-vision-ocr';
        layers.push({ id: synth ? `${ocrId}+labels` : ocrId, perceive: async (s, c) => (synth ? synth(await perceive(s, c)) : perceive(s, c)) });
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
  const [{ getRepos }, { getVault }, { loadCore }, { CareerStore }, { educationFromMaster, educationRows, withResumeEducation }, { backfillExperienceKinds, backfillEducationExperiences }] = await Promise.all([
    import('../career/db'), import('../career/vault'), import('../career/core-module'), import('../career/store'), import('../career/resume-education'), import('../career/resume-intake'),
  ]);
  const [repos, vault, core] = await Promise.all([getRepos(), getVault(), loadCore()]);
  backfillExperienceKinds(repos);
  backfillEducationExperiences(repos);
  const resumePath = typeof body.resumePath === 'string' && body.resumePath.trim() ? body.resumePath.trim() : undefined;
  const profile = new apply.ApplyService(repos, llm, { vault }).buildProfile(resumePath);
  // 教育经历的起止时间只在主简历里：按学校补齐（resume-education.ts）
  profile.education = withResumeEducation(educationRows(profile.education), educationFromMaster(new CareerStore(repos, core).listResumeMasters()[0]));
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

/** 运行记录保留最近多少次。 */
const TELEMETRY_KEEP = 50;

/**
 * 缺省运行记录目录：`$CAREER_DATA_DIR/runs/<actionId 或 runId>/`。测试（给了 body.profile）或 body.telemetry === false 时不记。
 * 目录拿不到就不记，不影响填表。
 */
export async function defaultTelemetry(body: Record<string, unknown>): Promise<{ dir: string; runId: string; keep: number } | null> {
  if (body.telemetry === false || body.profile) return null;
  const id = typeof body.actionId === 'string' && body.actionId ? body.actionId : typeof body.runId === 'string' && body.runId ? body.runId : `run_${Date.now()}`;
  try {
    const [{ careerDataDir }, { join }] = await Promise.all([import('../career/db'), import('path')]);
    return { dir: join(careerDataDir(), 'runs'), runId: id, keep: TELEMETRY_KEEP };
  } catch {
    return null;
  }
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

export async function loadApplyModule(): Promise<ApplyEngineModule | null> {
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
  if (name === 'BROWSER_CONTROL_HUMAN' || name === 'BRIDGE_NOT_CONNECTED') return failure(409, error instanceof Error ? error.message : fallback, name);
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

export type CareerBrowserOp = 'screenshot' | 'diagnose' | 'drive' | 'collect_passive' | 'submit' | 'release' | 'browse' | 'bridge';

/**
 * HTTP 路由（能力令牌）只开放这四种；submit / release 只能由 Global 进程内的提交执行器直接调用 runOperation——
 * 提交必须先在动作队列里被批准并认领，不能被任何持有浏览器令牌的调用方绕过。
 */
const OPS: ReadonlySet<string> = new Set<CareerBrowserOp>(['screenshot', 'diagnose', 'drive', 'collect_passive', 'browse', 'bridge']);
/** 模型逐步浏览用的专用页面（和各份网申的页面分开）。 */
export const BROWSE_PAGE_KEY = '__browse__';

/** 在已借到的 Context 上执行一次操作（路由与 Global 批量运行器共用）。 */
/** 模型直发 CDP（action:'cdp'）：白名单域内直达当前浏览页的调试器会话（跨域 iframe / 坐标 / 截图）。 */
async function runBrowseCdp(body: Record<string, unknown>, page: Page, out: RunEmitter): Promise<void> {
  const { cdpMethodAllowed, sanitizeCdpResult } = await import('../career/browse-cdp');
  const method = typeof body.method === 'string' ? body.method : '';
  if (!cdpMethodAllowed(method)) {
    out.emit({ type: 'error', status: 400, code: 'CDP_METHOD_NOT_ALLOWED', error: 'CDP 只开放 Page / Input / DOM / Runtime / Emulation 域；跨域 iframe 用 Page.getFrameTree + Page.createIsolatedWorld + Runtime.evaluate' });
    return;
  }
  const proxy = page as unknown as { newCDPSession?: () => Promise<{ send(method: string, params?: Record<string, unknown>): Promise<unknown> }> };
  const session = await proxy.newCDPSession?.();
  if (!session) { out.emit({ type: 'error', status: 501, code: 'CDP_UNAVAILABLE', error: '当前浏览器没有调试器会话（扩展桥未连接）' }); return; }
  try {
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params as Record<string, unknown> : undefined;
    const data = await session.send(method, params);
    out.emit({ type: 'result', op: 'browse', action: 'cdp', cdp: { ok: true, method, data: sanitizeCdpResult(data) } });
  } catch (error) {
    out.emit({ type: 'error', status: 500, code: 'CDP_FAILED', error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 模型逐步浏览（career/browse.ts）：observe / act / read。用专用浏览页；点击开了新标签就把浏览页换成新标签；
 * 每次操作后让现场画面切到这一页。输入里的 {{vault:...}} 在这里换成明文，模型看不到。
 */
async function runBrowse(body: Record<string, unknown>, context: BrowserContext, sessionKey: string, out: RunEmitter, deps: CareerBrowserRouteDependencies): Promise<void> {
  const browse = await import('../career/browse');
  const action = typeof body.action === 'string' ? body.action : 'observe';
  let page = await pageForApplication(context, sessionKey, BROWSE_PAGE_KEY, 'start');
  deps.focusPage?.(page);
  const apply = await (deps.loadApply ?? loadApplyModule)();
  const isSubmitText = (apply as unknown as { isSubmitText?: (t: string) => boolean } | null)?.isSubmitText ?? ((t: string) => /提交|投递|立即申请|申请职位|submit|apply now/i.test(t));
  const vault = await import('../career/vault').then(m => m.getVault()).catch(() => null);
  const browseDeps = {
    isSubmitText,
    hasPlaceholder: (t: string) => /\{\{\s*vault:[^}]+\}\}/.test(t),
    resolveVault: vault ? (t: string) => vault.resolve(t, { actor: 'form_fill', purpose: '模型浏览时填写' }) : undefined,
  };
  try {
    if (action === 'act') {
      const req = (body.act ?? {}) as import('../career/browse').ActRequest;
      const receipt = await browse.act(context, page, req, browseDeps);
      if (receipt.page !== page) { adoptApplicationPage(sessionKey, BROWSE_PAGE_KEY, receipt.page); page = receipt.page; deps.focusPage?.(page); }
      const { page: _p, ...rest } = receipt;
      // 操作成功就顺带给出新观察，省一轮往返（观察编号随之更新）
      const observation = receipt.ok && body.observeAfter !== false ? await browse.observe(context, page, browseDeps).catch(() => null) : null;
      out.emit({ type: 'result', op: 'browse', action, receipt: rest, ...(observation ? { observation } : {}) });
      return;
    }
    if (action === 'cdp') {
      await runBrowseCdp(body, page, out);
      return;
    }
    if (action === 'solve_captcha') {
      await runSolveCaptcha(page, out, deps);
      return;
    }
    if (action === 'wait_user') {
      await runWaitUser(body, page, out, deps);
      return;
    }
    if (action === 'read') {
      const r = await browse.read(page, typeof body.offset === 'number' ? body.offset : 0, typeof body.length === 'number' ? Math.min(body.length, 8000) : 4000);
      out.emit({ type: 'result', op: 'browse', action, read: r });
      return;
    }
    out.emit({ type: 'result', op: 'browse', action: 'observe', observation: await browse.observe(context, page, browseDeps, { textMax: typeof body.textMax === 'number' ? body.textMax : 1500 }) });
  } catch (error) {
    out.emit({ type: 'error', status: 500, code: 'BROWSE_FAILED', error: error instanceof Error ? error.message : String(error) });
  }
}

/** LlmLike 的返回是 unknown：在边界上确认有 text 再交给解题器。 */
/** 首页 / 合集页上去找哪种岗位：按这份申请的岗位和用户的求职方向（position-target.ts）。取不到就不找。 */
async function positionTargetForBody(body: Record<string, unknown>) {
  if (typeof body.applicationId !== 'string' || !body.applicationId) return null;
  try {
    const [{ getRepos }, { getJobPrefs }, { positionTargetFor }] = await Promise.all([import('../career/db'), import('../career/job-board'), import('../career/position-target')]);
    const repos = await getRepos();
    const app = repos.getApplication(body.applicationId);
    return positionTargetFor(getJobPrefs(repos), (app && repos.getJob(app.job_id)) ?? null);
  } catch (error) {
    console.warn(`[career-browser] position target unavailable application=${body.applicationId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 内置找路走不通时的自主找路（GA 式循环，face-ga-port 已定）。引擎缺判断函数时不开。 */
async function pathfinderForBody(applicationId: string, context: BrowserContext, page: Page, apply: ApplyEngineModule, llm: LlmLike, deps: CareerBrowserRouteDependencies) {
  const { isSubmitText, isEntryText, pickAdapter } = apply;
  if (!isSubmitText || !isEntryText || !pickAdapter) return null;
  const [{ pathfinderFor }, vault] = await Promise.all([import('../career/pathfinder-host'), import('../career/vault').then(m => m.getVault()).catch(() => null)]);
  return pathfinderFor({
    context, page, applicationId, llm, isSubmitText,
    isEntryText: (text, url) => isEntryText(text, pickAdapter(url)),
    resolveVault: vault ? (t: string) => vault.resolve(t, { actor: 'form_fill', purpose: `自主找路 ${applicationId}` }) : undefined,
    focusPage: p => deps.focusPage?.(p, false),
    log: msg => console.log(`[career] ${msg}`),
  });
}

function visionLlm(llm: LlmLike): import('../career/captcha-solver').VisionLlm {
  return {
    async complete(request) {
      const res = await llm.complete(request);
      const text = res && typeof res === 'object' && 'text' in res && typeof res.text === 'string' ? res.text : null;
      if (text === null) throw new Error('视觉模型返回里没有 text');
      return { text };
    },
  };
}

/** @career/captcha 要 core 的 LLM 形状（带 usage）；把路由的 LlmLike 补齐。 */
function coreVisionLlm(llm: LlmLike): import('@career/core').LLM {
  return {
    async complete(request) {
      const res = await llm.complete(request);
      const text = res && typeof res === 'object' && 'text' in res && typeof res.text === 'string' ? res.text : '';
      return { text, usage: { input_tokens: 0, output_tokens: 0 } };
    },
    ...(llm.supportsImages ? { supportsImages: () => llm.supportsImages!() } : {}),
  };
}

/** 浏览器环境检查（Cloudflare 一类）：先试着点一下验证框（CDP 可信点击），等不到再等放行。 */
const BROWSER_CHECK_WAIT_MS = 6000;

/** 自动验证共享组合点；请求体不能覆盖本机模板或收码授权。 */
async function verificationForPage(page: Page, body: Record<string, unknown>, bundle: DriveProfileBundle, llm: LlmLike | null, signal: AbortSignal, out: RunEmitter, deps: CareerBrowserRouteDependencies): Promise<VerificationHandler | undefined> {
  if (deps.verify) return deps.verify;
  if (body.profile || !llm) return undefined;
  const { createApplyVerification } = await import('../career/apply-verification');
  return createApplyVerification({
    page, llm: coreVisionLlm(llm), profile: bundle.profile, signal, resolveValue: bundle.resolveValue,
    batch: body.caller === 'batch',
    assertActive: () => { if (deps.host.getControl(deps.productSessionId ?? 'default').control === 'human') throw new Error('BROWSER_CONTROL_HUMAN'); },
    progress: message => out.emit({ type: 'progress', phase: 'verification', message }),
  }).catch(() => {
    console.warn('[apply-verification] configuration unavailable');
    return async () => ({ status: 'needs_user' as const });
  });
}

/** 对话的显式图形验证工具；短信/邮箱收码在 drive/approved-submit 的私有钩子中完成。 */
async function runSolveCaptcha(page: Page, out: RunEmitter, deps: CareerBrowserRouteDependencies): Promise<void> {
  const browse = await import('../career/browse');
  const { hintSampleInPage } = await import('../career/browse-handoff');
  const solver = await import('../career/captcha-solver');
  const apply = await (deps.loadApply ?? loadApplyModule)();
  const blocked = async () => { const h = browse.detectHints(await browse.inPage(page, hintSampleInPage, null), []); return h.includes('captcha') || h.includes('risk'); };
  const sample = await browse.inPage(page, hintSampleInPage, null);
  const classify = (apply as unknown as { classifyCaptcha?: (s: { title: string; text: string }) => string } | null)?.classifyCaptcha;
  const kind = classify ? classify({ title: await page.title().catch(() => ''), text: sample.bodySample }) : 'unknown';
  const site = new URL(page.url()).hostname;
  const captchaPolicy = await getCaptchaPolicy();
  const finish = async (captcha: Record<string, unknown>) => {
    console.log(`[career-browser] solve-captcha kind=${kind} status=${String(captcha.status)} attempts=${String(captcha.attempts ?? 0)}`);
    const observation = await browse.observe(page.context(), page, { isSubmitText: () => false }).catch(() => null);
    out.emit({ type: 'result', op: 'browse', action: 'solve_captcha', captcha: { kind, ...captcha }, ...(observation ? { observation } : {}) });
  };
  // 站点预算：超了 / 冷却中直接请用户，不再自动试
  const gate = captchaPolicy.canAttempt(site);
  if (!gate.ok) {
    captchaPolicy.record(site, kind as never, 'gave_up');
    return finish({ status: 'needs_user', attempts: 0, steps: [gate.reason === 'cooldown' ? '这个站刚连败过，冷却 10 分钟内先请用户帮一下' : gate.reason === 'rate_limit' ? '刚验证过，等几秒再继续，避免高频重复' : '这个站今天自动过码次数用完，先请用户帮一下'] });
  }
  if (kind === 'browser_check') {
    const cap = await import('@career/captcha');
    const { captchaPageFromPlaywright } = await import('../career/captcha-page-adapter');
    const llm = await (deps.resolveLlm ?? registeredLlmResolver ?? (async () => null))();
    const steps: string[] = [];
    let attempts = 0;
    if (llm && (!llm.supportsImages || llm.supportsImages())) {
      const result = await cap.solveBrowserCheck({ page: captchaPageFromPlaywright(page), llm: coreVisionLlm(llm) });
      attempts = result.attempts;
      steps.push(result.detail);
      if (result.outcome === 'passed') {
        captchaPolicy.record(site, 'browser_check', 'passed');
        return finish({ status: 'solved', attempts, steps });
      }
    }
    await page.waitForTimeout(BROWSER_CHECK_WAIT_MS);
    const still = await blocked();
    captchaPolicy.record(site, 'browser_check', still ? 'failed' : 'passed');
    return finish({ status: still ? 'needs_user' : 'solved', attempts: attempts + 1, steps: [...steps, '点过验证框后等环境检查放行'] });
  }
  if (kind !== 'image_text' && kind !== 'image_click' && kind !== 'slider') return finish({ status: 'needs_user', attempts: 0, steps: [`${kind} 类验证要本人处理`] });
  const llm = await (deps.resolveLlm ?? registeredLlmResolver ?? (async () => null))();
  if (!llm || (llm.supportsImages && !llm.supportsImages())) return finish({ status: 'needs_user', attempts: 0, steps: ['当前模型看不了图'] });
  out.emit({ type: 'progress', phase: 'solve_captcha', message: '正在自己过验证码' });
  const { overlayMarks } = await import('../career/captcha-overlay');
  const result = await solver.solveCaptcha(page, kind, { llm: visionLlm(llm), overlay: overlayMarks }, blocked);
  captchaPolicy.record(site, kind as never, result.status === 'solved' ? 'passed' : 'failed');
  return finish(result.status === 'solved' ? result : { ...result, status: 'needs_user' });
}

/**
 * 请用户帮一下（扫码登录、短信码……），做完接着办：现场画面切到这一页，盯着挡路的东西消失或用户交还。
 * 用户此时多半在接管（control=human），所以这一个操作在接管期间也放行（见 handleCareerBrowserRoute）。
 */
async function runWaitUser(body: Record<string, unknown>, page: Page, out: RunEmitter, deps: CareerBrowserRouteDependencies): Promise<void> {
  const { waitForUser, WAIT_USER_DEFAULT_MS, WAIT_USER_MAX_MS } = await import('../career/browse-handoff');
  const browse = await import('../career/browse');
  deps.focusPage?.(page, true);
  const what = typeof body.what === 'string' ? body.what : '请在浏览器里处理一下';
  out.emit({ type: 'progress', phase: 'wait_user', message: what });
  const sessionKey = deps.productSessionId ?? 'default';
  let sawHuman = deps.host.getControl(sessionKey).control === 'human';
  const blocking = Array.isArray(body.blocking) ? body.blocking.filter((h): h is import('../career/browse').Hint => ['login', 'captcha', 'risk'].includes(String(h))) : [];
  // 等登录：数据层（新会话凭证 + 登录接口返回）和画面两路一起看（用户 2026-10-30：要看数据层，不止看画面）
  const watch = blocking.includes('login') ? await (await import('../career/login-watch')).watchLogin(page) : null;
  const outcome = await waitForUser(page, {
    blocking,
    ...(watch ? { login: () => watch.check() } : {}),
    timeoutMs: clampNumber(body.timeoutMs, WAIT_USER_DEFAULT_MS, 5_000, WAIT_USER_MAX_MS),
    handedBack: () => {
      const human = deps.host.getControl(sessionKey).control === 'human';
      if (human) sawHuman = true;
      return sawHuman && !human;
    },
  });
  watch?.stop();
  // 记下这个站的凭证名：下次登录之旅切到它之前先查，还有效就不用你再登
  if (watch?.site && outcome.credentials?.length) {
    const [{ learnLoginMarks }, { getRepos }] = await Promise.all([import('../career/login-signal'), import('../career/db')]);
    learnLoginMarks(await getRepos(), watch.site, outcome.credentials);
  }
  console.log(`[career-browser] wait-user status=${outcome.status} signal=${outcome.signal ?? '-'} waited_ms=${outcome.waited_ms} blocking=${blocking.join('|') || 'url'}`);
  const observation = outcome.status === 'page_closed' ? null : await browse.observe(page.context(), page, { isSubmitText: () => false }).catch(() => null);
  out.emit({ type: 'result', op: 'browse', action: 'wait_user', wait: outcome, ...(observation ? { observation } : {}) });
}

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
  if (op === 'browse') {
    await runBrowse(body, context, sessionKey, out, deps);
    return;
  }
  let page: Page;
  try {
    page = await pageForApplication(context, sessionKey, appKey, op === 'submit' ? 'submit' : op === 'drive' && !(typeof body.url === 'string' && body.url.trim()) ? 'continue' : 'start', {
      siteUrl: typeof body.siteUrl === 'string' && body.siteUrl.trim() ? body.siteUrl.trim() : undefined,
    });
  } catch (error) {
    out.emit({ type: 'error', status: 410, code: errorName(error) ?? 'APPLICATION_PAGE_GONE', error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (appKey) deps.focusPage?.(page);
  // 用户的 Chrome 窗口不归产品管理：只有显式「到浏览器看」才前置窗口。
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
    await runSubmit(apply, page, body, out, deps, sessionKey, appKey, context, signal);
    return;
  }

  // op === 'drive'：同一个页面同时只允许一处在操作（对话 apply_run 与后台批量可能指向同一份网申）
  // owner 带执行者前缀（chat: / batch:）：此前两边都用裸 actionId，锁对同一 owner 可重入，
  // 对话与批量撞同一份时会双引擎同时填一张表、各自入队一个提交。
  const callerPrefix = typeof body.caller === 'string' && body.caller ? `${body.caller}:` : '';
  const owner = typeof body.actionId === 'string' && body.actionId ? `${callerPrefix}${body.actionId}` : typeof body.runId === 'string' ? `${callerPrefix}${body.runId}` : 'anonymous';
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
      // 只有填表引擎没加载上才会走到这里：是产品问题，不是用户资料的问题——不让用户去别的页面补东西（立场 9）。
      // 503 让批量运行器当暂时不可用放回队列，稍后自动重试
      console.error('[career-browser] drive FAILED: apply engine unavailable (ApplyService missing)');
      out.emit({ type: 'error', status: 503, code: 'APPLY_ENGINE_UNAVAILABLE', error: '填表引擎暂时没加载上，这是产品这边的问题，稍后会自动重试；不要让用户去任何页面补资料，告诉他一句「这份稍后自动接着填」即可。' });
      return;
    }
    const redact = bundle.redact ?? (<T,>(v: T) => v);
    if (url) {
      out.emit({ type: 'progress', phase: 'navigate', message: `打开 ${url}` });
      // 慢站首次加载超时很常见：单次 goto 失败不判死（详见 browse.ts navigateWithRetry）。
      // 这里失败给模型的是"可恢复"指引而不是裸错误，避免它直接跟用户说打不开。
      try {
        const [{ navigateWithRetry }, { restoreSessionCookies }] = await Promise.all([import('../career/browse'), import('../career/session-cookies')]);
        // 重启过的话，上次登上时记下的会话 Cookie 先补回去，免得又要扫码（face-ga-port：登录态要保住）
        await restoreSessionCookies(context, url).catch(e => console.warn(`[career-browser] session-cookies restore skipped url=${url}`, e instanceof Error ? e.message : e));
        await navigateWithRetry(page, url);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        out.emit({ type: 'error', status: 504, code: 'NAVIGATION_FAILED', error: `打开 ${url} 失败：${msg}。可让用户确认链接与网络后用 apply_run / apply_prepare 重试；若用户能手动打开而助理不能，多半是站点对自动访问有限制，交用户在现场打开（ui_open live）处理到表单页再继续。` });
        return;
      }
    }
    let perceiver: PerceiverLike | undefined;
    if (body.vision !== false) {
      try { perceiver = await (deps.createPerceiver ?? defaultPerceiver)(apply, engineLikePage, llm); } catch (error) { console.warn(`[career-browser] perceiver=unavailable error=${error instanceof Error ? error.message : String(error)}`); }
    }
    // 站点映射记忆（kv，与求职库同一连接）；测试给 body.profile 时不动真实库
    let siteMemory: unknown;
    if (typeof apply.SiteMemory === 'function' && !body.profile) {
      try { const { getRepos } = await import('../career/db'); siteMemory = new apply.SiteMemory(await getRepos()); } catch { /* 数据层未就绪就不记 */ }
    }
    out.emit({ type: 'progress', phase: 'drive', message: '开始填写（不会提交）' });
    const telemetry = await (deps.resolveTelemetry ?? defaultTelemetry)(body);
    const target = body.profile ? null : await positionTargetForBody(body);
    const pathfinder = target && typeof body.applicationId === 'string' ? await pathfinderForBody(body.applicationId, context, page, apply, llm, deps) : null;
    const verify = await verificationForPage(page, body, bundle, llm, signal, out, deps);
    const result = await apply.driveApplication(engineLikePage, llm, bundle.profile, {
      ...(verify ? { verify } : {}),
      maxPages: clampNumber(body.maxPages, DRIVE_DEFAULT_MAX_PAGES, 1, 20),
      humanTyping: body.humanTyping !== false,
      ...(typeof body.settleMs === 'number' ? { settleMs: body.settleMs } : {}),
      ...(bundle.resolveValue ? { resolveValue: bundle.resolveValue } : {}),
      ...(bundle.loginFill ? { loginFill: bundle.loginFill } : {}),
      ...(perceiver ? { perceiver } : {}),
      ...(siteMemory ? { siteMemory } : {}),
      ...(target ? { target } : {}),
      ...(pathfinder ? { pathfinder } : {}),
      ...(Array.isArray(body.learnFrom) ? { learnFrom: (body.learnFrom as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
      // 内部调试日志只进运行记录（引擎写 trace.jsonl），不广播给界面；界面只收人话进度
      // kind='jd' 时带上岗位介绍正文（脱敏），批量服务据此把 JD 存回岗位，给下一次定制用；不进界面进度
      onProgress: (p: { message: string; kind?: string; label?: string; text?: string }) => out.emit({ type: 'progress', phase: 'drive', message: redact(p.message), ...(p.kind ? { kind: p.kind } : {}), ...(p.text ? { text: redact(p.text) } : {}) }),
      onPage: (record: unknown) => out.emit({ type: 'page', record: redact(record) }),
      ...(telemetry ? { telemetry } : {}),
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
async function runSubmit(apply: ApplyEngineModule, page: Page, body: Record<string, unknown>, out: RunEmitter, deps: CareerBrowserRouteDependencies, sessionKey: string, appKey: string | undefined, context: BrowserContext, signal: AbortSignal): Promise<void> {
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
    const llm = await (deps.resolveLlm ?? registeredLlmResolver ?? (async () => null))().catch(() => {
      console.warn('[apply-verification] model unavailable during approved submit');
      return null;
    });
    const verify = await verificationForPage(page, body, {
      profile: { basics: { phone: '{{vault:profile.phone}}', email: '{{vault:profile.email}}' } },
      resolveValue: vault ? v => vault.resolve(v) : undefined,
    }, llm, signal, out, deps);
    const result = await apply.submitApplication(apply.fromPlaywright(page), {
      ...(verify ? { verify } : {}),
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
            status: name === 'BROWSER_CONTROL_HUMAN' || name === 'BRIDGE_NOT_CONNECTED' ? 409 : name === 'BROWSER_CAPABILITY_INVALID' ? 401 : 500,
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
            await (deps.bringToFront ?? ((ctx, channel, profileDir) => bringContextToFront(ctx, { channel, profileDir })))(context, host.browserChannel(), host.profileDirFor?.(binding.productSessionId) ?? null);
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
  if (!op) return failure(400, "op 必须是 'screenshot' | 'diagnose' | 'drive' | 'collect_passive' | 'browse' | 'bridge'");
  let binding: VerifiedBrowserCapability;
  try {
    binding = await host.verifyCapability(token, request.signal);
  } catch (error) {
    return errorResponse(error, '浏览器凭据校验失败');
  }
  // 「等用户帮一下」本来就是在用户接管期间等，不能被接管挡掉
  const waitsForUser = op === 'browse' && body.action === 'wait_user';
  const control = host.getControl(binding.productSessionId);
  const readsBridgeTabs = op === 'bridge' && (!body.action || body.action === 'tabs');
  if (control.control === 'human' && !waitsForUser && !readsBridgeTabs) {
    return failure(409, '用户正在接管浏览器，等待交回', 'BROWSER_CONTROL_HUMAN');
  }
  // 桥操作跑在用户自己的 Chrome 里，不需要（也不该依赖）托管浏览器
  if (op === 'bridge') {
    return ndjsonStream(request, out => runBridgeOp(body, out, { ...deps, productSessionId: binding.productSessionId }));
  }
  // 聊天、批量、提交与现场共用 ExtensionBrowserHost；不能绕过宿主的控制权和生命周期。
  return ndjsonStream(request, (out, signal) => host.withContext(
    token,
    (context, b) => runOperation(op, body, context, out, signal, { ...deps, productSessionId: b.productSessionId, focusPage: page => host.focusPage?.(b.productSessionId, page) }),
    { signal, ...(waitsForUser ? { allowHumanControl: true } : {}) },
  ));
}

/**
 * 桥操作（用户日常 Chrome，career-bridge 扩展通道）：
 * - tabs：列出真实浏览器里可脚本化的标签页
 * - solve_captcha：在真实浏览器的标签页上过验证码（登录态 / 指纹全真，通过率最高）
 * - sync_cookies 已退役：直接使用 Chrome 登录态，不复制 Cookie。
 * - exec：在指定标签页主世界执行 JS（模型自由操作兜底）
 */
async function runBridgeOp(
  body: Record<string, unknown>,
  out: RunEmitter,
  deps: CareerBrowserRouteDependencies,
): Promise<void> {
  const [{ ensureExtensionBridge }, { bridgePageFor }] = await Promise.all([
    import('../browser-host/extension-bridge/bridge-host'),
    import('../browser-host/extension-bridge/bridge-driver'),
  ]);
  const bridge = await ensureExtensionBridge();
  const action = typeof body.action === 'string' ? body.action : 'tabs';
  if (!bridge || !bridge.isConnected()) {
    out.emit({ type: 'result', op: 'bridge', action, bridge: { connected: false }, error: 'career-bridge 扩展未连接：请在用户 Chrome 里加载 app/shell/src/server/browser-host/extension-bridge/extension（chrome://extensions 未打包加载）' });
    return;
  }
  if (action === 'tabs') {
    out.emit({ type: 'result', op: 'bridge', action, bridge: { connected: true, tabs: bridge.tabs() } });
    return;
  }
  if (action === 'exec') {
    const tabId = Number(body.tabId);
    const code = typeof body.code === 'string' ? body.code : '';
    if (!Number.isInteger(tabId) || !code) { out.emit({ type: 'error', status: 400, code: 'BRIDGE_BAD_REQUEST', error: 'tabId 和 code 必填' }); return }
    try {
      const result = await bridge.executeJs(tabId, code);
      out.emit({ type: 'result', op: 'bridge', action, exec: result });
    } catch (error) {
      out.emit({ type: 'error', status: 500, code: 'BRIDGE_EXEC_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (action === 'sync_cookies') {
    out.emit({ type: 'error', status: 410, code: 'BRIDGE_SYNC_RETIRED', error: '已直接使用真实 Chrome 登录态，无需复制 Cookie' });
    return;
  }
  if (action === 'solve_captcha') {
    const urlPattern = typeof body.urlPattern === 'string' ? body.urlPattern : '';
    const openUrl = typeof body.openUrl === 'string' && /^https?:\/\//.test(body.openUrl) ? body.openUrl : undefined;
    if (!urlPattern) { out.emit({ type: 'error', status: 400, code: 'BRIDGE_BAD_REQUEST', error: 'urlPattern 必填' }); return }
    const captcha = await import('@career/captcha');
    const page = await bridgePageFor(bridge, urlPattern, openUrl);
    if (!page) {
      out.emit({ type: 'result', op: 'bridge', action, captcha: { status: 'needs_user', attempts: 0, steps: [`真实浏览器里没有 URL 含 "${urlPattern}" 的标签页`] } });
      return;
    }
    const site = new URL(page.url()).hostname;
    const policy = await getCaptchaPolicy();
    const target = await captcha.detectCaptcha(page);
    if (!target) {
      out.emit({ type: 'result', op: 'bridge', action, captcha: { status: 'solved', attempts: 0, steps: ['真实浏览器这一页没有可识别的验证码'], tab: { id: page.tab.id, url: page.tab.url } } });
      return;
    }
    const gate = policy.canAttempt(site);
    if (!gate.ok) {
      policy.record(site, target.kind, 'gave_up');
      out.emit({ type: 'result', op: 'bridge', action, captcha: { status: 'needs_user', attempts: 0, steps: [gate.reason === 'cooldown' ? '这个站刚连败过，冷却中' : '这个站今天自动过码次数用完'] } });
      return;
    }
    const llm = await (deps.resolveLlm ?? registeredLlmResolver ?? (async () => null))();
    if (!llm || (llm.supportsImages && !llm.supportsImages())) {
      out.emit({ type: 'result', op: 'bridge', action, captcha: { status: 'needs_user', attempts: 0, steps: ['当前模型看不了图'] } });
      return;
    }
    out.emit({ type: 'progress', phase: 'solve_captcha', message: `在用户真实浏览器里过 ${target.kind}（${target.vendor}）` });
    const result = await captcha.solveCaptcha({ page, llm: coreVisionLlm(llm) }, target);
    policy.record(site, target.kind, result.outcome === 'passed' ? 'passed' : 'failed');
    out.emit({
      type: 'result',
      op: 'bridge',
      action,
      captcha: { kind: target.kind, vendor: target.vendor, status: result.outcome === 'passed' ? 'solved' : 'needs_user', attempts: result.attempts, steps: [result.detail] },
      tab: { id: page.tab.id, url: page.tab.url },
    });
    return;
  }
  out.emit({ type: 'error', status: 400, code: 'BRIDGE_BAD_ACTION', error: `未知 bridge action: ${action}` });
}
