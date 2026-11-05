/**
 * Global 后台往个人助理对话里放一张卡（不在工具调用里，所以没有锚点，落在对话底部）。
 * 落库后经现场通道推给前端：CareerLiveBridge 转到 eventBus，TabProvider 按会话收下（同审核卡的路径）。
 * 还没有对话会话时只落库，不推；对话第一次打开时按会话读回不到它，所以记一条日志。
 */
import type { Repos } from '@career/core';

import { liveHub } from './live-hub';
import { careerProductSessionId } from './product-session';

export interface ChatCardPush { id: string; kind: string; title: string; data: Record<string, unknown> }
export type PostChatCard = (card: ChatCardPush) => void;

export function productChatCardPoster(repos: Repos): PostChatCard {
  return card => {
    const sessionId = careerProductSessionId() ?? null;
    if (!sessionId) console.warn(`[career-card] no product chat session yet, card ${card.id} stored without session`);
    let createdAt = new Date().toISOString();
    try {
      createdAt = repos.upsertChatCard({ id: card.id, session_id: sessionId, tool_use_id: null, kind: card.kind, title: card.title, data: card.data }).created_at;
    } catch (error) {
      console.error(`[career-card] store card ${card.id} failed:`, error instanceof Error ? error.message : error);
    }
    if (!sessionId) return;
    liveHub.publish('career:card', { sessionId, card: { ...card, createdAt, sessionId, toolUseId: null, state: 'pending' } });
  };
}

/**
 * 改写一张已有的卡并定下它的状态（如勾选表点了「投这 N 家」后收成"已开始投 N 家"）：
 * upsert 会把卡打回 pending，所以先写数据、再定状态、最后按定好的状态推给前端。
 */
export function settleChatCard(repos: Repos, id: string, patch: Record<string, unknown>, state: 'completed' | 'dismissed'): boolean {
  const row = repos.getChatCard(id);
  if (!row) {
    console.warn(`[career-card] settle: card ${id} not found`);
    return false;
  }
  const prev: unknown = JSON.parse(row.data_json);
  const data = { ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? Object.fromEntries(Object.entries(prev)) : {}), ...patch };
  repos.upsertChatCard({ id, session_id: row.session_id, tool_use_id: row.tool_use_id, kind: row.kind, title: row.title, data });
  const settled = repos.setChatCardState(id, state);
  if (row.session_id && settled) {
    liveHub.publish('career:card', { sessionId: row.session_id, card: { id, kind: row.kind, title: row.title, data, createdAt: settled.created_at, sessionId: row.session_id, toolUseId: row.tool_use_id, state } });
  }
  return true;
}
