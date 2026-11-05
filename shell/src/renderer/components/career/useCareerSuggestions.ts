/**
 * 建议条的取数（plan-r4 §2.4）：两路——
 *  1. 轮末钩子经本会话 SSE 推来（suggestStore），对得上最后一条消息就直接用，不再请求；
 *  2. 没推来时兜底 POST（source: 'poll'）：回到页面 / 初次打开立刻取，刚说完就先等一个宽限期。
 * 整条一次出、不先出后补（plan-r2 §B.5、§B.6）。视图在 SuggestChips.tsx，点了以后怎么办在 suggestActions.ts。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { track } from '@/analytics';
import type { Message } from '@/types/chat';

import { careerApi } from './careerApi';
import { useSuggestPush } from './suggestStore';
import { SUGGEST_HOOK_GRACE_MS, SUGGEST_MAX_TURNS, type SuggestChip, type SuggestPush, type SuggestRequest, type SuggestSource } from '../../../shared/careerSuggest';

/** 最后一条消息早于这么久：不是刚说完（回到页面 / 初次打开），钩子不会再推，立刻取。 */
export const STALE_MS = 10_000;
/** 刚说完时等钩子推送的宽限：和服务端钩子预算同一个来源（shared SUGGEST_HOOK_GRACE_MS），改时限只改一处。 */
export const HOOK_GRACE_MS = SUGGEST_HOOK_GRACE_MS;

/** 埋点里一条建议的 action 类型；没有 action 记空串。 */
export const actionTypeOf = (chip: SuggestChip): string => chip.action?.type ?? '';

/** 这一轮显示的是什么：属于哪条消息、从哪来、哪一幕。 */
interface Shown { key: string | null; chips: SuggestChip[]; scene: string | null; source: SuggestSource }
const NONE: Shown = { key: null, chips: [], scene: null, source: 'poll' };

/** 推送能不能直接用：对得上这一轮且有格子（降级但有格子也用——不先出后补）。 */
const usablePush = (push: SuggestPush | null, turnKey: string | null): push is SuggestPush =>
  !!push && push.assistant_message_id === turnKey && push.chips.length > 0;

/** 兜底请求要等多久：刚说完（看着它说完，或最后一条消息在 STALE_MS 内）等宽限，否则立刻。 */
function pollDelay(endedAt: number | null, lastAt: number | null, now: number): number {
  const fresh = (endedAt !== null && now - endedAt < STALE_MS) || (lastAt !== null && now - lastAt < STALE_MS);
  return fresh ? HOOK_GRACE_MS : 0;
}

/** 小芽从说话变成说完的时刻（只在这个挂载期间看到的才算）。 */
function useEndedAt(streaming: boolean): RefObject<number | null> {
  const endedAt = useRef<number | null>(null);
  const was = useRef(streaming);
  useEffect(() => {
    if (was.current && !streaming) endedAt.current = Date.now();
    was.current = streaming;
  }, [streaming]);
  return endedAt;
}

/** 兜底请求：没推送时按 pollDelay 等一会再取；推送到了就作废。 */
function usePoll({ active, turnKey, lastAt, request, endedAt, setPolled }: {
  active: boolean; turnKey: string | null; lastAt: number | null; request: RefObject<() => SuggestRequest>;
  endedAt: RefObject<number | null>; setPolled: (s: Shown) => void;
}) {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const timer = setTimeout(() => {
      careerApi.suggest({ ...request.current(), source: 'poll' })
        .then(res => { if (alive) setPolled({ key: turnKey, chips: res.chips, scene: res.scene, source: 'poll' }); })
        .catch((error: unknown) => console.warn(`[career-suggest] poll FAILED turn=${turnKey ?? ''}:`, error instanceof Error ? error.message : error));
    }, pollDelay(endedAt.current, lastAt, Date.now()));
    return () => { alive = false; clearTimeout(timer); };
  }, [active, turnKey, lastAt, request, endedAt, setPolled]);
}

/** 每条消息、每个来源只记一次"出现了"。 */
function useShownTrack(shown: Shown) {
  const tracked = useRef<string | null>(null);
  useEffect(() => {
    if (!shown.chips.length) return;
    const id = `${shown.key ?? ''}:${shown.source}`;
    if (tracked.current === id) return;
    tracked.current = id;
    const c = shown.chips;
    track('career_suggest_shown', {
      slots: c.map(x => x.slot).join(','), mode: c.map(x => x.mode).join(','), kind: c.map(x => x.kind).join(','),
      action_type: c.map(actionTypeOf).join(','), scene: shown.scene ?? '', source: shown.source,
    });
  }, [shown]);
}

/** 一轮说完后的建议。`turnKey` 变了（新的一轮说完）才换；在说话时、或结果不属于这一轮时不显示。 */
export function useCareerSuggestions({ enabled, streaming, turnKey, sessionId = null, lastAt = null, request }: {
  enabled: boolean;
  streaming: boolean;
  /** 最后一条消息的 id：变了说明有新的一轮；也是推送的 assistant_message_id 要对上的值。 */
  turnKey: string | null;
  /** 本 Tab 的会话：只认这个会话的推送。 */
  sessionId?: string | null;
  /** 最后一条消息的时间（ms）：判断是不是刚说完。 */
  lastAt?: number | null;
  request: () => SuggestRequest;
}) {
  const [polled, setPolled] = useState<Shown>(NONE);
  const [usedKey, setUsedKey] = useState<string | null>(null);
  const requestRef = useRef(request);
  // 只要最新的取法，不让它驱动重取：重取只跟着新的一轮（turnKey）走
  useEffect(() => { requestRef.current = request; });
  const push = useSuggestPush(sessionId);
  const pushed = usablePush(push, turnKey);
  const endedAt = useEndedAt(streaming);
  usePoll({ active: enabled && !streaming && !pushed, turnKey, lastAt, request: requestRef, endedAt, setPolled });
  const live = enabled && !streaming && usedKey !== turnKey;
  // 兜底先到了就留着它，推送晚到不替换（不先出后补）
  const shown: Shown = !live ? NONE
    : polled.key === turnKey ? polled
      : pushed ? { key: turnKey, chips: push.chips, scene: push.scene, source: 'hook' } : NONE;
  useShownTrack(shown);
  const shownRef = useRef(shown);
  useEffect(() => { shownRef.current = shown; });
  const used = useCallback((chip: SuggestChip, how: 'click' | 'tab' | 'key') => {
    const { scene, source, key } = shownRef.current;
    track('career_suggest_used', { slot: chip.slot, kind: chip.kind, mode: chip.mode, action_type: actionTypeOf(chip), seed_id: chip.seed_id ?? '', how, scene: scene ?? '', source });
    setUsedKey(key);
  }, []);
  return { chips: shown.chips, used };
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

/** 这一轮（他最后一句之后）小芽说的看得见的话。 */
function thisTurnAssistant(messages: readonly Message[]): string {
  let from = messages.length;
  while (from > 0 && messages[from - 1].role === 'assistant') from -= 1;
  return messages.slice(from).map(visibleText).filter(Boolean).join('\n');
}

/**
 * 一轮建议的请求体：旧字段照留，加最近几轮、上一轮的工具、隔了多久；
 * this_turn 是这一轮他说的、小芽说的、用的工具、放的卡（plan-r4 §2.3）。
 */
export function buildSuggestRequest(messages: readonly Message[], pendingCards: string[], turnCards: string[] = []): SuggestRequest {
  const tools = lastTools(messages);
  const lastUser = visibleText(lastOf(messages, 'user'));
  return {
    last_user: lastUser,
    last_assistant: visibleText(lastOf(messages, 'assistant')),
    pending_cards: pendingCards,
    turns: recentTurns(messages),
    last_tools: tools,
    away_hours: awayHours(messages),
    this_turn: { user: lastUser, assistant: thisTurnAssistant(messages), tools, cards: turnCards },
  };
}
