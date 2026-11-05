/**
 * 轮末钩子推来的下一步四格（plan-r4 §2.4）：按会话只留最新一条。
 *
 * 为什么是 store 不是 hook 里直接订阅：推送可能早于 chat:message-complete 到（钩子不等落盘），
 * 那时建议条的 turnKey 还是上一条；先存着，等最后一条消息变成它的 assistant_message_id 再显示。
 * TabProvider 已按 shouldAcceptInteractiveEvent 过滤过他会话；这里再按 sessionId 取，双保险。
 */
import { useSyncExternalStore } from 'react';

import { onEvent } from '@/api/eventBus';

import { CAREER_SUGGEST_EVENT, parseSuggestPush, type SuggestPush } from '../../../shared/careerSuggest';

const latest = new Map<string, SuggestPush>();
const listeners = new Set<() => void>();

/** 收一条推送：形状不对的丢掉；比已存的旧（ts 更早）也丢掉——晚到的旧结果不能盖新的。 */
export function acceptSuggestPush(raw: unknown): boolean {
  const push = parseSuggestPush(raw);
  if (!push) return false;
  const prev = latest.get(push.sessionId);
  if (prev && prev.ts > push.ts) return false;
  latest.set(push.sessionId, push);
  for (const fn of listeners) fn();
  return true;
}

onEvent<unknown>(CAREER_SUGGEST_EVENT, acceptSuggestPush);

export function suggestPushOf(sessionId: string | null | undefined): SuggestPush | null {
  return sessionId ? latest.get(sessionId) ?? null : null;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 本会话最新一条推送（不管属于哪条消息；对不对得上由调用方按 turnKey 判）。 */
export function useSuggestPush(sessionId: string | null | undefined): SuggestPush | null {
  return useSyncExternalStore(subscribe, () => suggestPushOf(sessionId), () => null);
}

/** 测试用：清空。 */
export function resetSuggestStore(): void {
  latest.clear();
  for (const fn of listeners) fn();
}
