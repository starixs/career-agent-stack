/**
 * 邮箱轮询（只在 Global 侧车跑一份）：每 N 分钟同步所有账号；用户也可从面板手动触发。
 * 失败只记日志与账号状态，不抛出；没有账号时什么都不做。
 */
import { loadCore } from '../core-module';
import { getRepos } from '../db';
import { getShellLLM } from '../llm';
import { broadcast as sseBroadcast } from '../../sse';
import { syncAllMailAccounts, type MailSyncResult } from './sync';

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<MailSyncResult[]> | null = null;

export const MAIL_POLL_INTERVAL_MS = 5 * 60_000;

export async function runMailSyncOnce(): Promise<MailSyncResult[]> {
  if (running) return running;
  running = (async () => {
    const [core, repos] = await Promise.all([loadCore(), getRepos()]);
    if (repos.listMailAccounts().length === 0) return [];
    let llm = null;
    try { llm = getShellLLM(); } catch (error) { console.warn('[career-mail] 模型不可用，邮件只落库不归档:', error instanceof Error ? error.message : error); }
    return syncAllMailAccounts({ repos, core, llm, broadcast: sseBroadcast, sessionId: () => 'global' });
  })().catch((error: unknown) => { console.warn('[career-mail] 同步失败:', error instanceof Error ? error.message : error); return [] as MailSyncResult[]; })
    .finally(() => { running = null; });
  return running;
}

export function startCareerMailPoller(intervalMs = MAIL_POLL_INTERVAL_MS): void {
  if (timer) return;
  // 启动后延迟一会再跑，避开冷启动高峰
  setTimeout(() => { void runMailSyncOnce(); }, 20_000).unref?.();
  timer = setInterval(() => { void runMailSyncOnce(); }, intervalMs);
  timer.unref?.();
}

export function stopCareerMailPoller(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
