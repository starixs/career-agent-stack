/**
 * 邮箱连接器的云端客户端（契约见 docs/SERVER-API.md「邮箱连接器」）。
 * 云端是连接的唯一事实源：保存加密授权码、IMAP 收信与保活、留痕；本机只镜像连接（mail_account.remote_id），
 * 从事件流拉求职邮件，交给本机的规则与模型识别、接管（archiveBatch，与本机 IMAP 同步共用）。
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import type { MailAccount, Repos } from '@career/core';

import { dataChanged } from '../intake';
import { fileSha256 } from '../packets';
import { serverCall, type FetchLike, type ServerConfig } from '../server-api';
import type { ConnectInput, ConnectResult } from './connect-service';
import { connectorServers, type ConnectorId, type MailConnector } from './connectors';
import type { SendMailPayload } from './send';
import { archiveBatch, type FetchedMail, type MailSyncDeps, type MailSyncResult } from './sync';
import type { MailErrorCode } from './verify';

export interface RemoteConnection {
  id: string; provider: ConnectorId; auth_type: 'credential_form' | 'oauth'; email_address: string;
  status: 'active' | 'expired' | 'revoked';
  health: { status: 'healthy' | 'degraded' | 'expired'; last_check_at: string | null; last_ok_at: string | null; consecutive_fails: number; last_error: string | null };
  created_at: string; last_used_at: string | null; last_sync_at: string | null;
}
interface RemoteEvent { id: string; connection_id: string; uid: number | null; message_id: string | null; in_reply_to: string | null; from: string | null; to: string | null; subject: string | null; received_at: string | null; backfill: boolean; text: string }

const EVENTS_CURSOR_KEY = 'mail:events:cursor';
/** 每次拉事件最多翻几页（每页 200 封），剩下的下一轮再拉。 */
const EVENT_PAGES_PER_RUN = 20;
const EVENT_PAGE_SIZE = 200;

/** 云端状态 → 本机 mail_account.status（connectionOf 据此投影成 active / expired）。 */
function localStatus(c: RemoteConnection): string {
  if (c.status === 'expired') return 'auth_failed';
  return c.health.status === 'degraded' ? 'error' : 'ok';
}

export function mirrorConnection(repos: Repos, c: RemoteConnection): MailAccount {
  const servers = connectorServers(c.provider);
  return repos.mirrorMailAccount({
    remote_id: c.id, provider: c.provider, address: c.email_address.toLowerCase(),
    imap_host: servers.imap_host, smtp_host: servers.smtp_host,
    status: localStatus(c), last_error: c.health.last_error, consecutive_fails: c.health.consecutive_fails,
    last_ok_at: c.health.last_ok_at, last_check_at: c.health.last_check_at, last_sync_at: c.last_sync_at, created_at: c.created_at,
  });
}

/** 拉连接列表并镜像；云端已经没有的（别处解绑了）本机也删掉。 */
export async function refreshConnections(repos: Repos, cfg: ServerConfig, fetchImpl: FetchLike = fetch): Promise<MailAccount[]> {
  const { connections } = await serverCall<{ connections: RemoteConnection[] }>(cfg, '/v1/connections', {}, fetchImpl);
  const live = connections.filter(c => c.status !== 'revoked');
  const mirrored = live.map(c => mirrorConnection(repos, c));
  const keep = new Set(live.map(c => c.id));
  for (const a of repos.listMailAccounts()) if (a.remote_id && !keep.has(a.remote_id)) repos.deleteMailAccount(a.id);
  return mirrored;
}

export async function remoteCatalog(cfg: ServerConfig, fetchImpl: FetchLike = fetch): Promise<MailConnector[]> {
  const { connectors } = await serverCall<{ connectors: MailConnector[] }>(cfg, '/v1/connectors', {}, fetchImpl);
  return connectors;
}

type RemoteVerify = { ok: true; smtp_ok: boolean; connection: RemoteConnection } | { ok: false; error_code: MailErrorCode | 'duplicate' | 'invalid_input'; message: string; connection_id?: string };

export async function remoteConnect(repos: Repos, cfg: ServerConfig, input: ConnectInput, fetchImpl: FetchLike = fetch): Promise<ConnectResult> {
  const body = { email: input.email.trim().toLowerCase(), authCode: input.authCode.replace(/\s+/g, ''), reauthorize: !!input.reauthorize };
  const r = await serverCall<RemoteVerify>(cfg, `/v1/connectors/${encodeURIComponent(input.connector)}/credentials/verify`, { method: 'POST', body: JSON.stringify(body) }, fetchImpl);
  if (!r.ok) {
    const local = r.connection_id ? repos.getMailAccountByRemote(r.connection_id) : undefined;
    return { ok: false, error_code: r.error_code, message: r.message, ...(local ? { account_id: local.id } : {}) };
  }
  return { ok: true, smtp_ok: r.smtp_ok, account: mirrorConnection(repos, r.connection) };
}

export async function remoteDetail(cfg: ServerConfig, remoteId: string, fetchImpl: FetchLike = fetch) {
  const id = encodeURIComponent(remoteId);
  const [usage, audit] = await Promise.all([
    serverCall<{ days: number; by_op: Record<string, { ok: number; failed: number }> }>(cfg, `/v1/connections/${id}/usage?days=7`, {}, fetchImpl),
    serverCall<{ entries: Array<{ id: string; actor: 'agent' | 'user' | 'system'; operation: string; status: 'ok' | 'failed'; detail: unknown; latency_ms: number | null; created_at: string }> }>(cfg, `/v1/connections/${id}/audit?limit=20`, {}, fetchImpl),
  ]);
  return { usage, audit: audit.entries };
}

export async function remoteUnbind(repos: Repos, cfg: ServerConfig, account: MailAccount, remoteId: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await serverCall(cfg, `/v1/connections/${encodeURIComponent(remoteId)}`, { method: 'DELETE' }, fetchImpl);
  repos.deleteMailAccount(account.id);
}

export async function remoteSyncNow(cfg: ServerConfig, remoteId: string, fetchImpl: FetchLike = fetch): Promise<{ fetched?: number; error_code?: string }> {
  return serverCall(cfg, `/v1/connections/${encodeURIComponent(remoteId)}/sync`, { method: 'POST', body: '{}' }, fetchImpl);
}

/** 事件里的连接本机还没镜像（刚在别处连上）：刷新一次连接列表再找。 */
async function accountForConnection(r: Repos, cfg: ServerConfig, connectionId: string, fetchImpl: FetchLike): Promise<MailAccount | undefined> {
  const known = r.getMailAccountByRemote(connectionId);
  if (known) return known;
  await refreshConnections(r, cfg, fetchImpl);
  return r.getMailAccountByRemote(connectionId);
}

const toFetched = (e: RemoteEvent): FetchedMail => ({ uid: e.uid ?? 0, message_id: e.message_id, in_reply_to: e.in_reply_to, from: e.from, to: e.to, subject: e.subject, text: e.text ?? '', received_at: e.received_at });

/** 按游标拉新邮件事件，按 (连接, 是否回填) 分组交给 archiveBatch；每页处理完才前移游标（至少一次，靠 message_id 去重）。 */
export async function pullMailEvents(deps: MailSyncDeps, cfg: ServerConfig, fetchImpl: FetchLike = fetch): Promise<MailSyncResult[]> {
  const r = deps.repos;
  const out: MailSyncResult[] = [];
  for (let page = 0; page < EVENT_PAGES_PER_RUN; page++) {
    const since = r.kvGet<string>(EVENTS_CURSOR_KEY) ?? '';
    const res = await serverCall<{ events: RemoteEvent[]; next_cursor: string | null }>(cfg, `/v1/mail/events?since=${encodeURIComponent(since)}&limit=${EVENT_PAGE_SIZE}`, {}, fetchImpl);
    if (!res.events.length) break;
    const groups = new Map<string, { account: MailAccount; backfill: boolean; mails: FetchedMail[] }>();
    for (const e of res.events) {
      const account = await accountForConnection(r, cfg, e.connection_id, fetchImpl);
      if (!account) { console.warn(`[career-mail] event for unknown connection ${e.connection_id}, skipped`); continue; }
      const key = `${account.id}:${e.backfill}`;
      const g = groups.get(key) ?? { account, backfill: e.backfill, mails: [] };
      g.mails.push(toFetched(e));
      groups.set(key, g);
    }
    for (const g of groups.values()) out.push(await archiveBatch(deps, g.account, g.mails, g.backfill));
    if (res.next_cursor) r.kvSet(EVENTS_CURSOR_KEY, res.next_cursor);
    if (!res.next_cursor) break;
  }
  if (out.length) dataChanged(deps, ['mail_account', 'mail_message', 'inbox_item', 'dossier_note', 'job', 'application', 'application_history', 'interview', 'offer', 'deadline']);
  return out;
}

/** 经云端代发：附件读成 base64 并带上冻结时的哈希；按客户端动作 id 幂等。 */
export async function remoteSend(cfg: ServerConfig, remoteId: string, mail: SendMailPayload, trigger: string, fetchImpl: FetchLike = fetch): Promise<{ messageId: string | null }> {
  const attachments = (mail.attachments ?? []).map(a => ({ filename: a.filename ?? basename(a.path), content_base64: readFileSync(a.path).toString('base64'), sha256: a.sha256 ?? fileSha256(a.path) }));
  const body = { connection_id: remoteId, to: mail.to, cc: mail.cc ?? null, subject: mail.subject, body: mail.body, attachments, trigger };
  const r = await serverCall<{ message_id?: string; error_code?: string; message?: string }>(cfg, '/v1/mail/send', { method: 'POST', body: JSON.stringify(body) }, fetchImpl);
  if (r.error_code) throw new Error(r.message ?? r.error_code);
  return { messageId: r.message_id ?? null };
}

export type OauthStart = { ok: true; authorize_url: string; state: string } | { ok: false; error_code: string; message: string };

/** OAuth 轨（预留）：云端未启用时返回 oauth_not_enabled。 */
export async function remoteOauthStart(cfg: ServerConfig, id: ConnectorId, fetchImpl: FetchLike = fetch): Promise<OauthStart> {
  const r = await serverCall<{ authorize_url?: string; state?: string; error_code?: string; message?: string }>(cfg, `/v1/connectors/${encodeURIComponent(id)}/oauth/start`, { method: 'POST', body: '{}' }, fetchImpl);
  return r.authorize_url && r.state ? { ok: true, authorize_url: r.authorize_url, state: r.state } : { ok: false, error_code: r.error_code ?? 'oauth_not_enabled', message: r.message ?? '官方授权审核通过后开放' };
}

export async function remoteOauthStatus(repos: Repos, cfg: ServerConfig, id: ConnectorId, state: string, fetchImpl: FetchLike = fetch): Promise<{ status: 'pending' | 'done' | 'failed'; account?: MailAccount }> {
  const r = await serverCall<{ status: 'pending' | 'done' | 'failed'; connection?: RemoteConnection }>(cfg, `/v1/connectors/${encodeURIComponent(id)}/oauth/status?state=${encodeURIComponent(state)}`, {}, fetchImpl);
  return { status: r.status, ...(r.connection ? { account: mirrorConnection(repos, r.connection) } : {}) };
}
