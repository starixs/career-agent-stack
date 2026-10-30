/**
 * 连接一个邮箱（连接器的 P3 → P4 → P5）：格式校验 → 查重 → 真实校验（verify.ts）→ 保存。
 * 校验没过什么都不存；授权码只在本机（credentials.ts）。首次导入由调用方转到后台。
 */
import type { MailAccount } from '@career/core';

import { dataChanged, type IntakeDeps } from '../intake';
import { connectionOf, connectorServers, normalizeAuthCode, type ConnectorId } from './connectors';
import { setMailPassword } from './credentials';
import { isExpired } from './health';
import { verifyMailCredentials, type MailErrorCode, type VerifyDeps } from './verify';

export interface ConnectInput { connector: ConnectorId; email: string; authCode: string; reauthorize?: boolean }

export type ConnectErrorCode = MailErrorCode | 'duplicate' | 'invalid_input';
export type ConnectResult =
  | { ok: true; account: MailAccount; smtp_ok: boolean }
  | { ok: false; error_code: ConnectErrorCode; message: string; account_id?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function connectMailbox(deps: IntakeDeps, input: ConnectInput, verifyDeps: VerifyDeps = {}): Promise<ConnectResult> {
  const r = deps.repos;
  const address = input.email.trim().toLowerCase();
  const code = normalizeAuthCode(input.authCode);
  if (!EMAIL_RE.test(address)) return { ok: false, error_code: 'invalid_input', message: '邮箱地址格式不对' };
  if (!code) return { ok: false, error_code: 'invalid_input', message: '授权码是 16 位字母' };
  const existing = r.listMailAccounts().find(a => a.address === address);
  if (existing && !isExpired(existing) && !input.reauthorize) {
    return { ok: false, error_code: 'duplicate', message: '这个邮箱已经连上了', account_id: existing.id };
  }
  const servers = connectorServers(input.connector);
  const outcome = await verifyMailCredentials({ ...servers, address, password: code }, verifyDeps);
  if (!outcome.ok) return { ok: false, error_code: outcome.error_code, message: outcome.message };

  const account = r.upsertMailAccount({ provider: input.connector, address, ...servers });
  setMailPassword(account.id, code);
  const t = new Date().toISOString();
  r.updateMailAccount(account.id, { status: 'ok', last_error: null, consecutive_fails: 0, last_ok_at: t, last_check_at: t, ...(outcome.uidvalidity !== null ? { uidvalidity: outcome.uidvalidity } : {}) });
  r.addMailAudit({ account_id: account.id, actor: 'user', operation: existing ? 'reauthorize' : 'connect', status: 'ok', detail: { smtp_ok: outcome.smtp_ok } });
  dataChanged(deps, ['mail_account']);
  return { ok: true, account: r.getMailAccount(account.id)!, smtp_ok: outcome.smtp_ok };
}

/** 连接管理页（P6）：连接状态、近 7 天用量、最近的操作记录。 */
export const USAGE_DAYS = 7;
const AUDIT_SHOWN = 20;

export function mailAccountDetail(r: IntakeDeps['repos'], account: MailAccount) {
  const since = new Date(Date.now() - USAGE_DAYS * 86_400_000).toISOString();
  const byOp: Record<string, { ok: number; failed: number }> = {};
  for (const u of r.mailUsage(account.id, since)) {
    const slot = byOp[u.operation] ?? (byOp[u.operation] = { ok: 0, failed: 0 });
    if (u.status === 'ok') slot.ok += u.n; else slot.failed += u.n;
  }
  const audit = r.listMailAudit(account.id, undefined, AUDIT_SHOWN).map(a => ({ ...a, detail: a.detail_json ? JSON.parse(a.detail_json) as unknown : null }));
  return { account: withConnection(account), usage: { days: USAGE_DAYS, by_op: byOp }, audit };
}

export function withConnection(a: MailAccount) {
  return { ...a, connection: connectionOf(a) };
}
