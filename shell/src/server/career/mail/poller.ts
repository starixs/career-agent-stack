/**
 * 邮箱轮询（只在 Global 侧车跑一份）：云端模式每分钟拉一次新邮件事件（很轻）；本机模式每 5 分钟登录 IMAP 同步一次。
 * 分流见 backend.ts。失败只记日志与账号状态，不抛出；没有账号时什么都不做。
 */
import { loadCore } from '../core-module';
import { getRepos } from '../db';
import { getShellLLM } from '../llm';
import { broadcast as sseBroadcast } from '../../sse';
import { mailBackend } from './backend';
import type { MailSyncResult } from './sync';

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<MailSyncResult[]> | null = null;

/** 轮询节拍：云端事件每分钟拉一次。 */
export const MAIL_POLL_INTERVAL_MS = 60_000;
/** 本机模式直连 IMAP，太勤会被服务商限流：至少隔 5 分钟。 */
const LOCAL_SYNC_INTERVAL_MS = 5 * 60_000;
let lastLocalSync = 0;

export async function runMailSyncOnce(): Promise<MailSyncResult[]> {
  if (running) return running;
  running = (async () => {
    const [core, repos] = await Promise.all([loadCore(), getRepos()]);
    if (repos.listMailAccounts().length === 0) return [];
    let llm = null;
    try { llm = getShellLLM(); } catch (error) { console.warn('[career-mail] 模型不可用，邮件只落库不归档:', error instanceof Error ? error.message : error); }
    const backend = mailBackend({ repos, core, llm, broadcast: sseBroadcast, sessionId: () => 'global' });
    if (backend.kind === 'local') {
      if (Date.now() - lastLocalSync < LOCAL_SYNC_INTERVAL_MS) return [];
      lastLocalSync = Date.now();
    }
    return backend.poll();
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
