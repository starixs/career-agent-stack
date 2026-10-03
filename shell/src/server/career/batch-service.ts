/**
 * 批量投递运行器的 Global 单例装配：浏览器宿主（免令牌借用）+ 表单引擎 + 私密库资料 + 视觉感知器。
 * 侧车重启后由 bootstrap 的 global 步骤调用 resumeBatchIfRunning() 续跑（队列与进度都在 SQLite / kv 里）。
 */
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

import type { PlaywrightBrowserHost } from '../browser-host';
import { loadConfig } from '../utils/admin-config';
import { BatchRunner } from './batch-runner';
import { getRepos } from './db';
import { liveHub } from './live-hub';
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
        control: () => {
          const id = careerProductSessionId();
          if (!id || !hostCache) return 'agent';
          try { return hostCache.hasContext(id) ? hostCache.getControl(id).control : 'agent'; } catch { return 'agent'; }
        },
        resumeFileFor: async resumeId => {
          if (typeof resumeId !== 'string' || !resumeId) return undefined;
          const row = repos.db.get<{ export_pdf: string | null }>('SELECT export_pdf FROM resume_tailored WHERE id=?', [resumeId]);
          return row?.export_pdf && existsSync(row.export_pdf) ? row.export_pdf : undefined;
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
            op: 'drive', actionId: req.action.id, applicationId: req.action.application_id, payload: req.payload,
            ...(req.mode === 'start' && typeof req.payload.url === 'string' ? { url: req.payload.url } : {}),
            ...(req.resumePath ? { resumePath: req.resumePath } : {}),
            ...(req.learnFrom?.length ? { learnFrom: req.learnFrom } : {}),
          };
          await host.withProductSession(id, context => runOperation('drive', body, context, out, new AbortController().signal, { host: host as unknown as CareerBrowserHost }), { create: { workspacePath: careerWorkspacePath() } });
          return events;
        },
        log: msg => console.log(`[career] ${msg}`),
      });
    })();
  }
  return runnerPromise;
}
let hostCache: PlaywrightBrowserHost | null = null;

/** bootstrap（global）：上次还在跑就续上。 */
export async function resumeBatchIfRunning(): Promise<void> {
  try { (await getBatchRunner()).resumeIfRunning(); } catch (error) { console.warn('[career] 批量运行器恢复失败：', error instanceof Error ? error.message : error); }
}
