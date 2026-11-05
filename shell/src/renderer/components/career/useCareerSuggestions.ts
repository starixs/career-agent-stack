/**
 * 建议条的取数：一轮说完后去取一次，整条一次出、不先出后补（plan-r2 §B.5、§B.6）。
 * 视图在 SuggestChips.tsx，点了以后怎么办在 suggestActions.ts。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { track } from '@/analytics';
import type { Message } from '@/types/chat';

import { careerApi } from './careerApi';
import { SUGGEST_MAX_TURNS, type SuggestChip, type SuggestRequest } from '../../../shared/careerSuggest';

/** 埋点里一条建议的 action 类型；没有 action 记空串。 */
export const actionTypeOf = (chip: SuggestChip): string => chip.action?.type ?? '';

/** 一轮说完后去取建议。`turnKey` 变了（新的一轮说完）才重新取；在说话时、或结果不属于这一轮时不显示。 */
export function useCareerSuggestions({ enabled, streaming, turnKey, request }: {
  enabled: boolean;
  streaming: boolean;
  /** 最后一条消息的 id：变了说明有新的一轮。 */
  turnKey: string | null;
  request: () => SuggestRequest;
}) {
  const [got, setGot] = useState<{ key: string | null; chips: SuggestChip[] }>({ key: null, chips: [] });
  const requestRef = useRef(request);
  // 只要最新的取法，不让它驱动重取：重取只跟着新的一轮（turnKey）走
  useEffect(() => { requestRef.current = request; });
  useEffect(() => {
    if (!enabled || streaming) return;
    let alive = true;
    careerApi.suggest(requestRef.current())
      .then(next => {
        if (!alive) return;
        setGot({ key: turnKey, chips: next });
        if (next.length) {
          track('career_suggest_shown', {
            slots: next.map(c => c.slot).join(','),
            mode: next.map(c => c.mode).join(','),
            kind: next.map(c => c.kind).join(','),
            action_type: next.map(actionTypeOf).join(','),
          });
        }
      })
      .catch((error: unknown) => console.warn('[career-suggest] fetch failed:', error instanceof Error ? error.message : error));
    return () => { alive = false; };
  }, [enabled, streaming, turnKey]);
  const used = useCallback((chip: SuggestChip, how: 'click' | 'tab' | 'key') => {
    track('career_suggest_used', { slot: chip.slot, kind: chip.kind, mode: chip.mode, action_type: actionTypeOf(chip), seed_id: chip.seed_id ?? '', how });
    setGot({ key: null, chips: [] });
  }, []);
  const chips = enabled && !streaming && got.key === turnKey ? got.chips : [];
  return { chips, used };
}

/** 隐藏上下文（system-reminder）不算他说的话。 */
const HIDDEN_CONTEXT = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** 一条消息里给人看的文字。 */
export function visibleText(message: Message | undefined): string {
  if (!message) return '';
  const raw = typeof message.content === 'string'
    ? message.content
    : message.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
  return raw.replace(HIDDEN_CONTEXT, '').trim();
}

export const lastOf = (messages: readonly Message[], role: Message['role']): Message | undefined => [...messages].reverse().find(m => m.role === role);

/** 最近几条看得见的话（plan-r3 §4.3，≤ SUGGEST_MAX_TURNS）：隐藏上下文去掉，空的跳过。 */
export function recentTurns(messages: readonly Message[]): NonNullable<SuggestRequest['turns']> {
  const turns: NonNullable<SuggestRequest['turns']> = [];
  for (const m of messages) {
    const text = visibleText(m);
    if (text) turns.push({ role: m.role, text });
  }
  return turns.slice(-SUGGEST_MAX_TURNS);
}

/** 工具名去掉 MCP 前缀（mcp__career__job_search → job_search）。 */
const bareToolName = (name: string): string => name.replace(/^mcp__.+?__/, '');

/** 送几个工具名、什么样的名字算数（G0 契约：≤12 个，只留 [a-z_]）。 */
const MAX_LAST_TOOLS = 12;
const TOOL_NAME = /^[a-z_]+$/;

/** 上一轮小芽（最后一条他说的话之后的回复）用过的工具，去重、按先后。 */
export function lastTools(messages: readonly Message[]): string[] {
  let from = messages.length;
  while (from > 0 && messages[from - 1].role === 'assistant') from -= 1;
  const names: string[] = [];
  for (const m of messages.slice(from)) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      const name = b.type === 'tool_use' ? b.tool?.name : undefined;
      if (name) {
        const bare = bareToolName(name);
        if (TOOL_NAME.test(bare) && !names.includes(bare)) names.push(bare);
      }
    }
  }
  return names.slice(0, MAX_LAST_TOOLS);
}

const timeOf = (m: Message): number => new Date(m.timestamp).getTime();

/** 他隔了多久回来：最后一句和前一句他说的话之间隔了几小时（一位小数）；不到两句、时间不对给 null。 */
export function awayHours(messages: readonly Message[]): number | null {
  const users = messages.filter(m => m.role === 'user');
  if (users.length < 2) return null;
  const gap = timeOf(users[users.length - 1]) - timeOf(users[users.length - 2]);
  if (!Number.isFinite(gap) || gap < 0) return null;
  return Math.round(gap / 360_000) / 10;
}

/** 一轮建议的请求体：旧字段照留，加最近几轮、上一轮的工具、隔了多久。 */
export function buildSuggestRequest(messages: readonly Message[], pendingCards: string[]): SuggestRequest {
  return {
    last_user: visibleText(lastOf(messages, 'user')),
    last_assistant: visibleText(lastOf(messages, 'assistant')),
    pending_cards: pendingCards,
    turns: recentTurns(messages),
    last_tools: lastTools(messages),
    away_hours: awayHours(messages),
  };
}
