/**
 * 绑定账号的抓取状态（2026-10-13 会议定：绑一次抓一次，登录过期了再绑再抓，不天天爬）。
 *
 * 绑定本身（主页链接 / 用户名）存在私密库的 profile 字段里；这里只记「什么时候让小芽抓的、抓成没有、是不是登录过期了」，
 * 存在 kv `profile.account_fetch`。页面点「绑定 / 重新抓取」时记 requested，小芽抓完用 account_fetch_report 工具回报结果。
 */
import type { Repos } from '@career/core';

export const ACCOUNT_FIELDS = ['linkedin', 'maimai', 'github', 'portfolio', 'chsi'] as const;
export type AccountField = typeof ACCOUNT_FIELDS[number];
export type AccountFetchStatus = 'requested' | 'ok' | 'login_expired' | 'failed';

export interface AccountFetchState {
  status: AccountFetchStatus;
  requested_at: string;
  /** 最近一次成功抓到的时间；失败或过期时保留上一次成功的时间。 */
  fetched_at: string | null;
  /** 小芽回报的一句话（失败原因等）。 */
  note: string | null;
}

const KV_KEY = 'profile.account_fetch';

export function isAccountField(value: unknown): value is AccountField {
  return typeof value === 'string' && (ACCOUNT_FIELDS as readonly string[]).includes(value);
}

export function listAccountFetch(repos: Pick<Repos, 'kvGet'>): Partial<Record<AccountField, AccountFetchState>> {
  return repos.kvGet<Partial<Record<AccountField, AccountFetchState>>>(KV_KEY) ?? {};
}

function write(repos: Pick<Repos, 'kvGet' | 'kvSet'>, field: AccountField, next: AccountFetchState | null): AccountFetchState | null {
  const all = { ...listAccountFetch(repos) };
  if (next) all[field] = next;
  else delete all[field];
  repos.kvSet(KV_KEY, all);
  return next;
}

/** 页面点了「绑定 / 重新抓取」：交给小芽之前先记一笔。 */
export function requestAccountFetch(repos: Pick<Repos, 'kvGet' | 'kvSet'>, field: AccountField, at: string = new Date().toISOString()): AccountFetchState {
  const prev = listAccountFetch(repos)[field];
  return write(repos, field, { status: 'requested', requested_at: at, fetched_at: prev?.fetched_at ?? null, note: null })!;
}

/** 小芽抓完回报：ok 记下抓取时间；login_expired / failed 保留上一次成功的时间。 */
export function reportAccountFetch(
  repos: Pick<Repos, 'kvGet' | 'kvSet'>, field: AccountField, status: Exclude<AccountFetchStatus, 'requested'>, note: string | null, at: string = new Date().toISOString(),
): AccountFetchState {
  const prev = listAccountFetch(repos)[field];
  return write(repos, field, {
    status, requested_at: prev?.requested_at ?? at, fetched_at: status === 'ok' ? at : prev?.fetched_at ?? null, note: note?.trim() || null,
  })!;
}

/** 解绑：抓取状态一起清掉。 */
export function clearAccountFetch(repos: Pick<Repos, 'kvGet' | 'kvSet'>, field: AccountField): void {
  write(repos, field, null);
}
