/**
 * 信任账本（主线体验 §6.4 / §6.8，11-02 定）：信任按"类"攒，不是攒够一次就全放。
 *
 * 一类 = 一种网申系统（北森、Moka、飞书招聘…；没认出系统的按网站记）或一家标星公司。
 * 每类三档：new（没在他这儿投过）→ shown（当着他的面做通过一次）→ delegated（他盖章：以后同类直接投）。
 * 由他盖章才升到 delegated，AI 不自己升；碰到 new 的那一份停在当面做那一步给他看。
 *
 * 存 kv `trust:ledger`（Global 侧车写），右栏「学会了」读它。
 */
import type { Repos } from '@career/core';

import { siteOf } from './app-pages';
import { loadApply } from './domain';

import type { TrustEntry, TrustKind, TrustState } from '../../shared/careerRail';

export type { TrustEntry, TrustState } from '../../shared/careerRail';
export type TrustLedger = Record<string, TrustEntry>;

export const TRUST_LEDGER_KEY = 'trust:ledger';
/** 当面做通过几份同类之后，小芽才提议「以后同类直接投？」：一份可能是碰巧，两份说明这一类真的走通了。 */
export const DELEGATE_PROPOSE_AFTER = 2;

const SYSTEM_LABELS: Record<string, string> = { beisen: '北森', moka: 'Moka', feishu: '飞书招聘', nowcoder: '牛客', boss: 'BOSS 直聘' };

/** 网申网址属于哪一类：认得出的招聘系统按系统记，认不出的按网站记（同一网站的结构一样）。 */
export async function systemOf(url: string): Promise<{ key: string; label: string }> {
  const apply = await loadApply();
  const adapter = apply.pickAdapter(url);
  if (adapter.id !== 'generic') return { key: `system:${adapter.id}`, label: SYSTEM_LABELS[adapter.id] ?? adapter.id };
  const site = siteOf(url) ?? url;
  return { key: `site:${site}`, label: site };
}

export const targetKey = (company: string) => `target:${company}`;

export function readLedger(repos: Repos): TrustLedger {
  return repos.kvGet<TrustLedger>(TRUST_LEDGER_KEY) ?? {};
}

function write(repos: Repos, entry: TrustEntry): TrustEntry {
  repos.kvSet(TRUST_LEDGER_KEY, { ...readLedger(repos), [entry.key]: entry });
  return entry;
}

export function trustOf(repos: Repos, key: string): TrustState {
  return readLedger(repos)[key]?.state ?? 'new';
}

/** 一份投出成功：new 升到 shown（他看着做通了一次），已经是 shown / delegated 的只加次数。 */
export function recordSuccess(repos: Repos, cls: { key: string; label: string; kind?: TrustKind }): TrustEntry {
  const prev = readLedger(repos)[cls.key];
  return write(repos, {
    key: cls.key, kind: cls.kind ?? prev?.kind ?? 'system', label: cls.label,
    state: prev?.state === 'delegated' ? 'delegated' : 'shown',
    successes: (prev?.successes ?? 0) + 1, updated_at: new Date().toISOString(),
  });
}

/** 他盖章：以后同类直接投。只有用户动作能走到这里。 */
export function delegate(repos: Repos, key: string): TrustEntry | null {
  const prev = readLedger(repos)[key];
  if (!prev) return null;
  return write(repos, { ...prev, state: 'delegated', updated_at: new Date().toISOString() });
}

/** 收回放权：回到 shown，下一份同类又停在当面那一步。 */
export function revoke(repos: Repos, key: string): TrustEntry | null {
  const prev = readLedger(repos)[key];
  if (!prev || prev.state !== 'delegated') return prev ?? null;
  return write(repos, { ...prev, state: 'shown', updated_at: new Date().toISOString() });
}

/** 这一类该不该提议放权：做通够数、还没放。 */
export function shouldProposeDelegate(entry: TrustEntry | undefined): boolean {
  return !!entry && entry.state === 'shown' && entry.successes >= DELEGATE_PROPOSE_AFTER;
}

/** 这一份要不要当面做：系统没放权，或者是标星公司且这家没放权。 */
export function needsFaceToFace(repos: Repos, systemKey: string, company: string | null, starred: boolean): boolean {
  const ledger = readLedger(repos);
  if (ledger[systemKey]?.state !== 'delegated') return true;
  return starred && !!company && ledger[targetKey(company)]?.state !== 'delegated';
}
