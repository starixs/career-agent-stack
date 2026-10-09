/**
 * 批量投递运行器的 Global 单例装配：浏览器宿主（免令牌借用）+ 表单引擎 + 私密库资料 + 视觉感知器。
 * 侧车重启后由 bootstrap 的 global 步骤调用 resumeBatchIfRunning() 续跑（队列与进度都在 SQLite / kv 里）。
 */
import { homedir } from 'os';
import { join } from 'path';

import type { PlaywrightBrowserHost } from '../browser-host';
import { loadConfig } from '../utils/admin-config';
import { BatchRunner } from './batch-runner';
import { careerExportsDir, getRepos } from './db';
import { FileChooserBroker } from './file-chooser';
import { liveHub } from './live-hub';
import { packetResumeFile } from './packets';
import { SubmitExecutor } from './submit-executor';
import type { CareerBrowserHost, RunEmitter } from '../routes/career-browser';

type HostResolver = () => Promise<PlaywrightBrowserHost>;
let hostResolver: HostResolver | null = null;
let runnerPromise: Promise<BatchRunner> | null = null;

/** index.ts 在创建 ensureBrowserHost 后注册一次。 */
export function registerBatchBrowserHost(resolver: HostResolver | null): void { hostResolver = resolver; }

/** 唯一的个人助理会话 id（渲染层启动时写进 config）。 */
export function careerProductSessionId(): string | undefined {
  try { const id = loadConfig().careerSessionId; return typeof id === 'string' && id.trim() && !id.startsWith('pending-') ? id.trim() : undefined; } catch { return undefined; }
}
export function careerWorkspacePath(): string { return join(homedir(), '.keystone', 'projects', 'career'); }

export { liveHub };
/** 产品内选文件（内嵌窗口模式下拦截的系统选文件框）。 */
export const fileChooserBroker = new FileChooserBroker(liveHub);

export async function getBatchRunner(): Promise<BatchRunner> {
  if (!runnerPromise) {
    runnerPromise = (async () => {
      const repos = await getRepos();
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
          const id = careerProductSessionId();
          if (!id || !hostCache) return 'agent';
          try { return hostCache.hasContext(id) ? hostCache.getControl(id).control : 'agent'; } catch { return 'agent'; }
        },
        hasBrowser: () => {
          const id = careerProductSessionId();
          if (!id || !hostCache) return false;
          try { return hostCache.hasContext(id); } catch { return false; }
        },
        resumeFileFor: payload => packetResumeFile(repos, payload, legacyResumeFile),
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
            op: 'drive', actionId: req.action.id, applicationId: req.action.application_id, payload: req.payload,
            ...(req.mode === 'start' && typeof req.payload.url === 'string' ? { url: req.payload.url } : {}),
            ...(req.resumePath ? { resumePath: req.resumePath } : {}),
            ...(req.learnFrom?.length ? { learnFrom: req.learnFrom } : {}),
          };
          // 并行时：有等用户处理的接管就不把画面切到新开的网申上（接管那一页由 force 切过去）
          const focusPage = (page: Parameters<typeof host.focusPage>[1], force?: boolean) => { if (force || repos.openHandoffs().length === 0) host.focusPage(id, page); };
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

/** bootstrap（global）：上次还在跑就续上；同时启动接管守护与提交执行器。 */
export async function resumeBatchIfRunning(): Promise<void> {
  startHandoffKeeper();
  try { (await getSubmitExecutor()).start(); } catch (error) { console.warn('[career] 提交执行器启动失败：', error instanceof Error ? error.message : error); }
  try { (await getBatchRunner()).resumeIfRunning(); } catch (error) { console.warn('[career] 批量运行器恢复失败：', error instanceof Error ? error.message : error); }
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
