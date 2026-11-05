/**
 * 建议条要的上下文：主线走到哪、有几件等他、有没有简历、连没连邮箱、说过哪些条件。
 * 全是本地查询，不过模型；等你的数和输入框上沿的等你条同一个来源（asksFor）。
 */
import type { Repos } from '@career/core';

import { asksFor } from './delivery';
import { getJobPrefs } from './job-board';
import { mainlineStage, receipts } from './rail';
import type { CareerStore } from './store';
import type { SuggestContext } from './suggest-seeds';
import { readLedger } from './trust-ledger';

export function suggestContextOf(repos: Repos, store: CareerStore): SuggestContext {
  const prefs = getJobPrefs(repos);
  const ledger = Object.values(readLedger(repos));
  return {
    stage: mainlineStage(repos, store, receipts(repos).length, ledger),
    waiting: asksFor(repos).length,
    hasResume: store.listResumeMasters().length > 0,
    mailConnected: repos.listMailAccounts().length > 0,
    prefsText: [...(prefs.keywords ?? []), ...(prefs.cities ?? [])].join(' '),
  };
}
