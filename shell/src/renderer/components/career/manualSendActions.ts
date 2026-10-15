/**
 * 批准后要用户自己发出去的动作：招呼语（send_greeting）/ 开放题回答（answer_open_q）。
 * 产品不替用户在招聘平台上发消息，批准后服务端把它们置为 needs_user，结果里带上要发的原文；
 * 页面把原文摆出来，给一个「复制」按钮（用户亲手点才写剪贴板），不再停在一个没下文的「已批准」。
 */
import type { ActionKind, ActionQueueItem } from './types';

const MANUAL_SEND_KINDS: ReadonlySet<ActionKind> = new Set(['send_greeting', 'answer_open_q']);

export function isManualSendKind(kind: ActionKind): boolean {
  return MANUAL_SEND_KINDS.has(kind);
}

/** 已批准、等用户自己发出去的动作。 */
export function isManualSend(action: Pick<ActionQueueItem, 'kind' | 'status'>): boolean {
  return action.status === 'needs_user' && isManualSendKind(action.kind);
}

function parseDict(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function pick(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * 要发的原文：服务端结果的 `text` 是纯原文（`message` 是带说明的一句话，不拿来复制）；
 * 老数据没有 text 时退回 note / answer，再退回待审时的 payload（text / answer）。
 */
export function manualSendText(action: Pick<ActionQueueItem, 'payload_json' | 'result_json'>): string | null {
  return pick(parseDict(action.result_json), ['text', 'note', 'answer']) ?? pick(parseDict(action.payload_json), ['text', 'answer']);
}
