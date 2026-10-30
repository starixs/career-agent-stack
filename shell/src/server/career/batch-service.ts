/**
 * 批量投递运行器的 Global 单例装配：浏览器宿主（免令牌借用）+ 表单引擎 + 私密库资料 + 视觉感知器。
 * 侧车重启后由 bootstrap 的 global 步骤调用 resumeBatchIfRunning() 续跑（队列与进度都在 SQLite / kv 里）。
 */
import { homedir } from 'os';
import { join } from 'path';


import type { PlaywrightBrowserHost } from '../browser-host';
import { BatchRunner } from './batch-runner';
import { careerExportsDir, getRepos } from './db';
import { FileChooserBroker } from './file-chooser';
import { liveHub } from './live-hub';
import { careerProductSessionId } from './product-session';
import { loginJourneyActive } from './live-pin';
import { packetResumeFile } from './packets';
import { SubmitExecutor } from './submit-executor';
import type { CareerBrowserHost, RunEmitter } from '../routes/career-browser';
import { openApplicationKeys } from './app-pages';

type HostResolver = () => Promise<PlaywrightBrowserHost>;
let hostResolver: HostResolver | null = null;
let runnerPromise: Promise<BatchRunner> | null = null;

/** index.ts 在创建 ensureBrowserHost 后注册一次。 */
export function registerBatchBrowserHost(resolver: HostResolver | null): void { hostResolver = resolver; }

export { careerProductSessionId };
export function careerWorkspacePath(): string { return join(homedir(), '.keystone', 'projects', 'career'); }

export { liveHub };
/** 产品内选文件（内嵌窗口模式下拦截的系统选文件框）。 */
export const fileChooserBroker = new FileChooserBroker(liveHub);

let orphanSweepDone = false;
/**
 * 启动清扫：侧车进程死在半路时留下的 executing 动作，对话和批量都不会再认领（apply_run 只收 approved、
 * 批量队列只看 approved / 带 resumed_at 的 needs_user）——不扫就永远卡死。
 *  - fill_form：放回 approved 重跑（原批准仍有效，填写不提交，重跑安全）；
 *  - submit：不能自动重跑（可能已经投出去了），转 needs_user 开接管，让用户到页面确认后收尾。
 * 幂等（状态翻转后不再命中）；5 分钟新鲜度保护 lazy 初始化时可能正在跑的合法动作。
 */
export async function sweepOrphanedActions(repos: Awaited<ReturnType<typeof getRepos>>): Promise<void> {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  try {
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    const stale = repos.db.all<{ id: string; kind: string; application_id: string | null }>(
      `SELECT id, kind, application_id FROM action_queue WHERE status='executing' AND updated_at < ?`, [staleBefore],
    );
    if (!stale.length) return;
    const withHandoff = new Set(repos.openHandoffs().map(h => h.action_id));
    for (const a of stale) {
      if (withHandoff.has(a.id)) continue;
      if (a.kind === 'fill_form') {
        if (repos.requeueAction(a.id)) console.log(`[career] sweep: 中断的填表 ${a.id} 已放回队列`);
      } else if (a.kind === 'submit') {
        try {
          repos.setActionStatus(a.id, 'needs_user', { status: 'uncertain', message: '提交时进程中断，请到页面确认是否已投出' });
          repos.openHandoff('user_request' as never, { actionId: a.id, message: '提交时进程中断：请到页面确认是否已经投出，再用确认按钮收尾' });
          console.log(`[career] sweep: 中断的提交 ${a.id} 已转为等用户确认（不自动重试，避免重复投递）`);
        } catch { /* ignore */ }
      }
    }
  } catch (error) {
    orphanSweepDone = false; // 清扫失败不挡启动，下次初始化再试
    console.warn('[career] sweep: 孤儿动作清扫失败：', error instanceof Error ? error.message : error);
  }
}

export async function getBatchRunner(): Promise<BatchRunner> {
  if (!runnerPromise) {
    runnerPromise = (async () => {
      const repos = await getRepos();
      await sweepOrphanedActions(repos);
      const sessionId = () => careerProductSessionId() ?? 'global';
      const riskLocked = (platform: string) => {
        const lock = repos.kvGet<{ until: string }>(`apply:risk_lock:${platform}`);
        return !!lock && new Date(lock.until).getTime() > Date.now();
      };
      return new BatchRunner({
        repos,
        broadcast: (event, data) => { liveHub.publish(event, data as Record<string, unknown>); },
        sessionId,
        riskLocked,
        // 同时填几份（不同网站）；同一网站永远串行。CAREER_BATCH_CONCURRENCY=1 退回逐份执行。
        concurrency: Math.min(4, Math.max(1, Number(process.env.CAREER_BATCH_CONCURRENCY) || 2)),
        control: () => {
          // 登录之旅里你只在钉住的那一页上操作，后台其余几家照样填（用户 2026-10-30 定：后台照样并行）
          if (loginJourneyActive()) return 'agent';
          const id = careerProductSessionId();
          if (!id || !hostCache) return 'agent';
          try { return hostCache.hasContext(id) ? hostCache.getControl(id).control : 'agent'; } catch { return 'agent'; }
        },
        hasBrowser: () => {
          const id = careerProductSessionId();
          if (!id || !hostCache) return false;
          try { return hostCache.hasContext(id); } catch { return false; }
        },
        // 浏览器开着但这份网申的页面被关了（学生关掉了窗口 / 标签）：交给运行器重新打开
        pageGone: action => {
          const id = careerProductSessionId();
          return !!id && !openApplicationKeys(id).includes(action.application_id ?? action.id);
        },
        // 上传文件名用简历上的姓名（占位符在 Node 侧解开，只进文件名，不回传模型）
        resumeFileFor: async payload => {
          const vault = await import('./vault').then(m => m.getVault()).catch(() => null);
          return packetResumeFile(repos, payload, legacyResumeFile, vault ? { resolveText: text => vault.resolve(text, { actor: 'resume_export', purpose: '简历附件文件名' }) } : {});
        },
        drive: async (req, onEvent) => {
          if (!hostResolver) throw new Error('浏览器宿主尚未就绪（批量运行器只能在 Global 侧车运行）');
          const host = await hostResolver();
          hostCache = host;
          const id = careerProductSessionId();
          if (!id) throw new Error('还没有个人助理会话：请先打开一次对话');
          const { runOperation } = await import('../routes/career-browser');
          const events: Record<string, unknown>[] = [];
          const out: RunEmitter = { emit: line => { events.push(line); onEvent(line); }, aborted: () => false };
          const body: Record<string, unknown> = {
            op: 'drive',
            // 执行者标记：页面锁 owner 的前缀。对话（chat:）和批量（batch:）撞上同一份时，后到的一方
            // 会收到 BROWSER_BUSY——此前两边 owner 相同、锁可重入，会出现双引擎同时填一份表、各排一个提交。
            caller: 'batch',
            actionId: req.action.id, applicationId: req.action.application_id, payload: req.payload,
            ...(req.mode === 'start' && typeof req.payload.url === 'string' ? { url: req.payload.url } : {}),
            // 续跑不重开链接，但要带上网申所在网站：交还后页面不在这个网站上就停下问用户（app-pages 核对）
            ...(req.mode === 'continue' && typeof req.payload.url === 'string' ? { siteUrl: req.payload.url } : {}),
            ...(req.resumePath ? { resumePath: req.resumePath } : {}),
            ...(req.learnFrom?.length ? { learnFrom: req.learnFrom } : {}),
          };
          // 并行时：有等用户处理的接管就不把画面切到新开的网申上（接管那一页由 force 切过去）
          // 登录之旅进行中：画面钉在带你过的那一家，后台新开的网申一律不切过去
          const focusPage = (page: Parameters<typeof host.focusPage>[1], force?: boolean) => { if (!loginJourneyActive() && (force || repos.openHandoffs().length === 0)) host.focusPage(id, page); };
          await host.withProductSession(id, context => runOperation('drive', body, context, out, new AbortController().signal, { host: host as unknown as CareerBrowserHost, productSessionId: id, focusPage }), { create: { workspacePath: careerWorkspacePath() } });
          return events;
        },
        log: msg => console.log(`[career] ${msg}`),
      });
    })();
  }
  return runnerPromise;
}
let hostCache: PlaywrightBrowserHost | null = null;

/** 产品会话的浏览器宿主（Global 侧车）：登录之旅用。没就绪时显式报错。 */
export async function careerBrowserHost(): Promise<{ host: PlaywrightBrowserHost; productSessionId: string }> {
  if (!hostResolver) throw new Error('浏览器宿主尚未就绪（只能在 Global 侧车执行）');
  const host = await hostResolver();
  hostCache = host;
  const productSessionId = careerProductSessionId();
  if (!productSessionId) throw new Error('还没有个人助理会话');
  return { host, productSessionId };
}

/** 没有材料包的旧动作：按 resume_id 现导（主简历与定制简历都导，渲染前解私密库占位符）。 */
async function legacyResumeFile(resumeId: unknown): Promise<string | undefined> {
  if (typeof resumeId !== 'string' || !resumeId) return undefined;
  try {
    // 动态加载：导出链路会拉起 react-pdf 模板，不能拖慢侧车冷启动
    const [{ loadCore }, { getVault }, { CareerStore }, { exportResumeFile }] = await Promise.all([import('./core-module'), import('./vault'), import('./store'), import('./export')]);
    const [core, repos, vault] = await Promise.all([loadCore(), getRepos(), getVault()]);
    const store = new CareerStore(repos, core);
    if (!store.getResume(resumeId)) return undefined;
    return await exportResumeFile(store, resumeId, 'pdf', careerExportsDir(), undefined, schema => vault.resolveDeep(schema, { actor: 'resume_export', purpose: `批量投递导出简历 ${resumeId}` }), { repos });
  } catch (error) {
    console.warn('[career] 批量投递导出简历失败：', error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** 在产品会话的浏览器上跑一次操作（submit / release），收集 NDJSON 事件。浏览器不在时不会新开。 */
async function runOnProductBrowser(body: Record<string, unknown>, onEvent: (ev: Record<string, unknown>) => void): Promise<Array<Record<string, unknown>>> {
  if (!hostResolver) throw new Error('浏览器宿主尚未就绪（只能在 Global 侧车执行）');
  const host = await hostResolver();
  hostCache = host;
  const id = careerProductSessionId();
  if (!id) throw new Error('还没有个人助理会话');
  if (!host.hasContext(id)) throw Object.assign(new Error('浏览器已经关闭，填好的页面不在了，需要重新填写这份网申'), { name: 'APPLICATION_PAGE_GONE' });
  const { runOperation } = await import('../routes/career-browser');
  const events: Array<Record<string, unknown>> = [];
  const out: RunEmitter = { emit: line => { events.push(line); onEvent(line); }, aborted: () => false };
  const op = body.op === 'release' ? 'release' : 'submit';
  await host.withProductSession(id, context => runOperation(op, body, context, out, new AbortController().signal, { host: host as unknown as CareerBrowserHost, productSessionId: id, focusPage: page => host.focusPage(id, page) }));
  return events;
}

let submitExecutorPromise: Promise<SubmitExecutor> | null = null;
export async function getSubmitExecutor(): Promise<SubmitExecutor> {
  if (!submitExecutorPromise) {
    submitExecutorPromise = (async () => {
      const repos = await getRepos();
      await sweepOrphanedActions(repos);
      return new SubmitExecutor({
        repos,
        run: runOnProductBrowser,
        broadcast: (event, data) => { liveHub.publish(event, data as Record<string, unknown>); },
        sessionId: () => careerProductSessionId() ?? 'global',
        log: msg => console.log(`[career] ${msg}`),
      });
    })();
  }
  return submitExecutorPromise;
}
/** 审批路由批准 submit 后立即执行一轮（不等轮询）。 */
export async function kickSubmitExecutor(): Promise<void> {
  try { await (await getSubmitExecutor()).tick(); } catch (error) { console.warn('[career] 提交执行失败：', error instanceof Error ? error.message : error); }
}
/** 网申放弃 / 提交被拒：关掉它的页面。 */
export async function releaseApplicationPageFor(applicationId: string): Promise<void> {
  try { await runOnProductBrowser({ op: 'release', applicationId }, () => {}); } catch { /* 浏览器不在就无需释放 */ }
}

/**
 * 答案改动回传：配置了服务端才上传（每 10 分钟一批）；没配置就在本地累积，配好后补传。
 * 上行内容见 server-api.uploadAnswerEvents（不带本地 id，个人信息不带值，excluded 从不入队）。
 */
let answerSyncTimer: ReturnType<typeof setInterval> | null = null;
export function startAnswerSync(intervalMs = 10 * 60_000): void {
  if (answerSyncTimer) return;
  const tick = async () => {
    try {
      const repos = await getRepos();
      const { serverConfig, uploadAnswerEvents } = await import('./server-api');
      const cfg = serverConfig(repos);
      if (!cfg) return;
      const res = await uploadAnswerEvents(repos, cfg);
      if (res.error) console.warn(`[career] 答案改动上传失败：${res.error}`);
    } catch { /* 下一轮再试 */ }
  };
  answerSyncTimer = setInterval(() => { void tick(); }, intervalMs);
  answerSyncTimer.unref?.();
}

/** bootstrap（global）：上次还在跑就续上；同时启动接管守护、提交执行器与答案回传。 */
export async function resumeBatchIfRunning(): Promise<void> {
  void import('./legacy-memory-cleanup').then(m => m.removePristineLegacyMemoryRules(careerWorkspacePath()))
    .then(removed => { if (removed.length) console.log(`[career] 已撤掉基座记忆的默认规则文件：${removed.join('、')}`); })
    .catch(() => { /* 下次启动再试 */ });
  startHandoffKeeper();
  startAnswerSync();
  try { (await getSubmitExecutor()).start(); } catch (error) { console.warn('[career] 提交执行器启动失败：', error instanceof Error ? error.message : error); }
  try { (await getBatchRunner()).resumeIfRunning(); } catch (error) { console.warn('[career] 批量运行器恢复失败：', error instanceof Error ? error.message : error); }
  startBatchCommandPoll();
}

/**
 * 批量命令轮询：命令写在 kv（对话审批卡片 / apply_batch 工具都在 Session 进程，只能写 kv），
 * 运行器自己的循环只在跑的时候读命令；空闲时由这里读，否则"批准即填写"永远没人接。
 */
let commandTimer: ReturnType<typeof setInterval> | null = null;
export function startBatchCommandPoll(intervalMs = 2000): void {
  if (commandTimer) return;
  commandTimer = setInterval(() => {
    void getBatchRunner().then(runner => { runner.pollCommand(); }).catch(() => { /* 下一轮再试 */ });
  }, intervalMs);
  commandTimer.unref?.();
}

/**
 * 接管守护：只要还有等用户处理的接管（批量或对话里的 apply_run 都算），就持有浏览器，
 * 防止填表引擎跑完后 15 秒空闲宽限把 Chrome 关掉——否则用户打开现场时要处理的页面已经没了。
 * 每 3 秒对一次账（宽限 15 秒，足够在回收前接上）。
 */
let keeperTimer: ReturnType<typeof setInterval> | null = null;
export function startHandoffKeeper(intervalMs = 3000): void {
  if (keeperTimer) return;
  keeperTimer = setInterval(() => { void syncHandoffHold().catch(() => { /* 下一轮再试 */ }); }, intervalMs);
  keeperTimer.unref?.();
}

export async function syncHandoffHold(deps: { repos?: { openHandoffs(): unknown[]; listActions?(status?: string): Array<{ kind: string }> }; host?: Pick<PlaywrightBrowserHost, 'hasContext' | 'setHandoffHold'> | null; sessionId?: string } = {}): Promise<boolean> {
  const id = deps.sessionId ?? careerProductSessionId();
  const host = deps.host !== undefined ? deps.host : (hostCache ?? (hostResolver ? hostCache = await hostResolver() : null));
  if (!id || !host) return false;
  const repos = deps.repos ?? await getRepos();
  // 浏览器不在就不持有（stale 接管由批量运行器重新排队）；接管全部关闭后释放
  // 等提交的网申（填好了停在提交前、待审或已批准待执行）也要持有：它们的页面就在这个浏览器里
  const pendingSubmits = ['pending_review', 'approved', 'executing'].some(status => repos.listActions?.(status).some(a => a.kind === 'submit'));
  const held = (repos.openHandoffs().length > 0 || !!pendingSubmits) && host.hasContext(id);
  host.setHandoffHold(id, held);
  return held;
}
