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
