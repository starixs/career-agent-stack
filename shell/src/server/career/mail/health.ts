/**
 * 邮箱连接的健康：每次同步就是一次探测（轮询每 5 分钟登录一次，不另开心跳）。
 * 连续认证失败到阈值才判失效，网络抖一下不算；失效后不再自动重试（反复用错的授权码登录会被服务商锁），
 * 等用户重新授权。
 */
import type { MailAccount } from '@career/core';

import { dataChanged, type IntakeDeps } from '../intake';
import { classifyMailError } from './verify';

/** 连续失败这么多次才判失效。 */
export const EXPIRE_AFTER_FAILS = 3;

type HealthDeps = Pick<IntakeDeps, 'repos' | 'broadcast' | 'sessionId'>;

/** 登录 / 拉信失败：累计一次；认证类错误到阈值就判失效。返回给用户看的原因。 */
export function recordMailFailure(deps: HealthDeps, account: MailAccount, error: unknown): string {
  const c = classifyMailError(error);
  const fails = (account.consecutive_fails ?? 0) + 1;
  const authProblem = c.code === 'imap_auth_failed' || c.code === 'imap_disabled';
  const expired = authProblem && fails >= EXPIRE_AFTER_FAILS;
  deps.repos.updateMailAccount(account.id, { status: expired ? 'auth_failed' : 'error', last_error: c.message, consecutive_fails: fails, last_check_at: new Date().toISOString() });
  console.warn(`[career-mail] sync failed account=${account.id} code=${c.code} fails=${fails}${expired ? ' -> expired' : ''}: ${c.raw.slice(0, 200)}`);
  dataChanged(deps, ['mail_account']);
  return c.message;
}

export function recordMailSuccess(deps: HealthDeps, account: MailAccount, patch: { last_uid: number; uidvalidity: number | null }): void {
  const t = new Date().toISOString();
  deps.repos.updateMailAccount(account.id, {
    status: 'ok', last_error: null, consecutive_fails: 0, last_ok_at: t, last_check_at: t, last_sync_at: t,
    last_uid: patch.last_uid, ...(patch.uidvalidity !== null ? { uidvalidity: patch.uidvalidity } : {}),
  });
}

export function isExpired(account: MailAccount): boolean {
  return account.status === 'auth_failed';
}
