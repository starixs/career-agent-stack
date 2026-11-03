/**
 * 邮箱连接器的唯一分流入口：配了服务端（server-api.ts serverConfig）就走云端，云端是连接的事实源；
 * 没配就走本机实现（本地打磨用，凭证存本机）。路由、轮询、代发都只调这里，不自己判断云端还是本机。
 */
import type { MailAccount } from '@career/core';

import { serverConfig, type FetchLike } from '../server-api';
import { connectMailbox, mailAccountDetail, withConnection, type ConnectInput, type ConnectResult } from './connect-service';
import { CONNECTOR_ORDER, MAIL_CONNECTORS, type ConnectorId, type MailConnector } from './connectors';
import { deleteMailPassword } from './credentials';
import {
  pullMailEvents, refreshConnections, remoteCatalog, remoteConnect, remoteDetail, remoteOauthStart, remoteOauthStatus, remoteSyncNow, remoteUnbind,
  type OauthStart,
} from './remote';
import { syncAllMailAccounts, syncMailAccount, type MailSyncDeps, type MailSyncResult } from './sync';
import type { VerifyDeps } from './verify';

export type MailAccountDetail = ReturnType<typeof mailAccountDetail>;

export interface MailBackend {
  kind: 'cloud' | 'local';
  catalog(): Promise<MailConnector[]>;
  /** 列表前刷新：云端拉连接镜像到本机；本机什么都不做。 */
  refresh(): Promise<void>;
  connect(input: ConnectInput): Promise<ConnectResult>;
  /** 连上后开始收历史邮件（后台，不等）。 */
  startImport(account: MailAccount): void;
  detail(account: MailAccount): Promise<MailAccountDetail>;
  unbind(account: MailAccount): Promise<void>;
  syncNow(account?: MailAccount): Promise<MailSyncResult[]>;
  /** 轮询一轮：云端拉事件，本机 IMAP 同步。 */
  poll(): Promise<MailSyncResult[]>;
  oauthStart(id: ConnectorId): Promise<OauthStart>;
  oauthStatus(id: ConnectorId, state: string): Promise<{ status: 'pending' | 'done' | 'failed'; account?: MailAccount }>;
}

export interface MailBackendOptions { fetchImpl?: FetchLike; verify?: VerifyDeps; sync?: typeof syncMailAccount }

const LOCAL_CATALOG = (): MailConnector[] => CONNECTOR_ORDER.map(id => MAIL_CONNECTORS[id]);
const OAUTH_NOT_ENABLED: OauthStart = { ok: false, error_code: 'oauth_not_enabled', message: '官方授权审核通过后开放，现在先用授权码连接' };

export function mailBackend(deps: MailSyncDeps, opts: MailBackendOptions = {}): MailBackend {
  const cfg = serverConfig(deps.repos);
  return cfg ? cloudBackend(deps, cfg, opts) : localBackend(deps, opts);
}

function background(label: string, p: Promise<unknown>): void {
  void p.catch(error => console.error(`[career-mail] ${label} failed:`, error instanceof Error ? error.message : error));
}

function localBackend(deps: MailSyncDeps, opts: MailBackendOptions): MailBackend {
  const sync = opts.sync ?? syncMailAccount;
  return {
    kind: 'local',
    catalog: async () => LOCAL_CATALOG(),
    refresh: async () => undefined,
    connect: input => connectMailbox(deps, input, opts.verify),
    startImport: account => background(`first sync account=${account.id}`, sync(deps, account)),
    detail: async account => mailAccountDetail(deps.repos, account),
    unbind: async account => { deps.repos.deleteMailAccount(account.id); deleteMailPassword(account.id); },
    syncNow: async account => account ? [await sync(deps, account)] : syncAllMailAccounts(deps),
    poll: () => syncAllMailAccounts(deps),
    oauthStart: async () => OAUTH_NOT_ENABLED,
    oauthStatus: async () => ({ status: 'failed' }),
  };
}

function cloudBackend(deps: MailSyncDeps, cfg: NonNullable<ReturnType<typeof serverConfig>>, opts: MailBackendOptions): MailBackend {
  const f = opts.fetchImpl;
  const r = deps.repos;
  const remoteIdOf = (a: MailAccount): string => {
    if (!a.remote_id) throw new Error(`邮箱 ${a.address} 还没连到云端，请重新连接`);
    return a.remote_id;
  };
  const pull = async () => { await refreshConnections(r, cfg, f); return pullMailEvents(deps, cfg, f); };
  return {
    kind: 'cloud',
    // 云端目录拿不到时用内置的同一份，保证总能连
    catalog: async () => { try { return await remoteCatalog(cfg, f); } catch (error) { console.warn('[career-mail] remote catalog unavailable, using bundled:', error instanceof Error ? error.message : error); return LOCAL_CATALOG(); } },
    refresh: async () => { await refreshConnections(r, cfg, f); },
    connect: input => remoteConnect(r, cfg, input, f),
    startImport: () => background('pull events after connect', pullMailEvents(deps, cfg, f)),
    detail: async account => {
      const { usage, audit } = await remoteDetail(cfg, remoteIdOf(account), f);
      return { account: withConnection(r.getMailAccount(account.id) ?? account), usage, audit: audit.map(e => ({ ...e, account_id: account.id, detail_json: null })) };
    },
    unbind: account => remoteUnbind(r, cfg, account, remoteIdOf(account), f),
    syncNow: async account => {
      if (account) {
        const res = await remoteSyncNow(cfg, remoteIdOf(account), f);
        if (res.error_code) return [{ account_id: account.id, fetched: 0, stored: 0, job_related: 0, ignored: 0, archived: [], error: res.error_code === 'expired' ? '邮箱连接已失效，需要重新授权' : res.error_code }];
      }
      return pull();
    },
    poll: pull,
    oauthStart: id => remoteOauthStart(cfg, id, f),
    oauthStatus: (id, state) => remoteOauthStatus(r, cfg, id, state, f),
  };
}
