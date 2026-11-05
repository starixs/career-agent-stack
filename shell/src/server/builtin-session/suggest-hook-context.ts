/**
 * 求职下一步条轮末钩子在 builtin session 这一侧的挂点助手（plan-r4 §2.1）：
 * 挂点处同步取齐上下文（completeTurn 之后 turn 累加器会被清），再排到下一拍（setImmediate）才真正调用钩子，
 * 让 handleSdkResult 先返回、钩子里的状态读取（求职库）不压在回复收尾的同步路径上。
 */
import type { PostTurnSuggestBlock, PostTurnSuggestContext, PostTurnSuggestMessage } from '../turn-hooks';
import { getCurrentTurnStartTime } from './turn';
import { getBuiltinProductContent, getMessageCount, getMessages } from './transcript';

/** 钩子看的最近几条消息（够取本轮 + 最近六轮可见文字）。 */
const SUGGEST_HOOK_MESSAGES = 14;

export type FirePostTurnSuggestHook = (ctx: PostTurnSuggestContext, isSuperseded: () => boolean) => void;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function suggestBlockOf(raw: unknown): PostTurnSuggestBlock {
  if (!isRecord(raw)) return { type: 'unknown' };
  const block: PostTurnSuggestBlock = { type: typeof raw.type === 'string' ? raw.type : 'unknown' };
  if (typeof raw.text === 'string') block.text = raw.text;
  if (isRecord(raw.tool) && typeof raw.tool.name === 'string') block.tool = { name: raw.tool.name };
  return block;
}

function suggestMessageOf(m: { id: string; role: string; timestamp: string; content: unknown }): PostTurnSuggestMessage | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(suggestBlockOf) : '';
  return { id: m.id, role: m.role, timestamp: m.timestamp, content };
}

/** 挂点处同步取齐钩子上下文：钩子异步跑时不能再碰 turn 累加器。 */
export function snapshotSuggestContext(sessionId: string, assistantText: string, assistantMessageId: string | null): PostTurnSuggestContext {
  const product = getBuiltinProductContent();
  const raw = product ? [...product.writer.projection.messages.values()].slice(-SUGGEST_HOOK_MESSAGES) : getMessages().slice(-SUGGEST_HOOK_MESSAGES);
  const messages = raw.map(suggestMessageOf).filter((m): m is PostTurnSuggestMessage => m !== null);
  const lastUser = messages.findLast(m => m.role === 'user');
  return {
    sessionId,
    turnId: (product ? product.currentTurn?.id : getMessages().at(-1)?.turnId) ?? null,
    assistantMessageId,
    rootUserMessageId: product?.currentTurn?.rootUserMessageId ?? lastUser?.id ?? null,
    assistantText,
    startedAt: getCurrentTurnStartTime(),
    messages,
  };
}

/** 他在这一轮之后又说了一句（新一轮已开始）：钩子据此丢掉旧结果。基线在挂点处同步取。 */
function supersededProbe(turnId: string | null): () => boolean {
  const countAtEnd = getMessageCount();
  return () => {
    const product = getBuiltinProductContent();
    if (product) {
      const turn = product.currentTurn;
      return !!turn && turn.id !== turnId;
    }
    return getMessageCount() > countAtEnd && getMessages().at(-1)?.role === 'user';
  };
}

/** 排到下一拍再调钩子；钩子抛错只记日志，永不影响轮的收尾。 */
export function dispatchSuggestHook(fire: FirePostTurnSuggestHook, ctx: PostTurnSuggestContext): void {
  const isSuperseded = supersededProbe(ctx.turnId);
  setImmediate(() => {
    try {
      fire(ctx, isSuperseded);
    } catch (error) {
      console.warn(`[career-suggest] hook dispatch failed session=${ctx.sessionId}:`, error instanceof Error ? error.message : error);
    }
  });
}
