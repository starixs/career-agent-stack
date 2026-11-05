/**
 * 求职下一步条的轮末钩子（plan-r4 §2.2）：小芽这一轮在 Session 侧车里说完的那一刻，
 * 服务端自己算好四格，经本会话 SSE 推 career:suggest（和 career:card 同路），不等前端再发请求。
 *
 * - 只管求职对话（careerProductSessionId）；永不抛进 turn lifecycle。
 * - 同会话新一轮完成或他又说了一句 → 旧结果作废（generation + isSuperseded），不发。
 * - 同一条回复（assistant_message_id）只发一次。
 * - 预算 SUGGEST_HOOK_BUDGET_MS；超时也发：改用不叫模型的兜底配方，标 degraded；
 *   超时的那次生成迟到了也不记"上一轮出过"、不压功能冷却（isStale）。
 */
import type { LLM, Repos } from '@career/core';

import {
  CAREER_SUGGEST_EVENT, SUGGEST_HOOK_BUDGET_MS, SUGGEST_MAX_TOOLS, SUGGEST_MAX_TURNS, SUGGEST_TURN_CHARS,
  type SuggestPush, type SuggestRequest, type SuggestTurn,
} from '../../shared/careerSuggest';
import { broadcast as sseBroadcast } from '../sse';
import type { PostTurnSuggestContext, PostTurnSuggestMessage } from '../turn-hooks';
import { loadCore } from './core-module';
import { getRepos } from './db';
import { getShellLLM } from './llm';
import { careerProductSessionId } from './product-session';
import { suggestFor, type SuggestOptions, type SuggestResult } from './suggest';
import { suggestStateOf, type SuggestState } from './suggest-context';
import { CareerStore } from './store';

/** 隐藏上下文（system-reminder）不算他说的话。 */
const HIDDEN_CONTEXT = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** 工具名去掉 MCP 前缀后只留 [a-z_]（同 suggest-request 的契约）。 */
const TOOL_NAME = /^[a-z_]+$/;
const MS_PER_TENTH_HOUR = 360_000;

export interface SuggestTurnContext {
  user: string;
  assistant: string;
  tools: string[];
  turns: SuggestTurn[];
  away_hours: number | null;
}

function visibleText(m: PostTurnSuggestMessage | undefined): string {
  if (!m) return '';
  const raw = typeof m.content === 'string'
    ? m.content
    : m.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
  return raw.replace(HIDDEN_CONTEXT, '').trim();
}

/** 本轮从哪条开始：rootUserMessageId 那条；找不到就最后一条他说的话。 */
function turnStartIndex(ctx: PostTurnSuggestContext): number {
  const byId = ctx.rootUserMessageId ? ctx.messages.findIndex(m => m.id === ctx.rootUserMessageId) : -1;
  if (byId >= 0) return byId;
  return ctx.messages.findLastIndex(m => m.role === 'user');
}

function toolsOf(messages: readonly PostTurnSuggestMessage[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      const bare = b.type === 'tool_use' && b.tool ? b.tool.name.replace(/^mcp__.+?__/, '') : '';
      if (TOOL_NAME.test(bare) && !names.includes(bare)) names.push(bare);
    }
  }
  return names.slice(0, SUGGEST_MAX_TOOLS);
}

function awayOf(messages: readonly PostTurnSuggestMessage[]): number | null {
  const users = messages.filter(m => m.role === 'user');
  if (users.length < 2) return null;
  const gap = Date.parse(users[users.length - 1].timestamp) - Date.parse(users[users.length - 2].timestamp);
  return Number.isFinite(gap) && gap >= 0 ? Math.round(gap / MS_PER_TENTH_HOUR) / 10 : null;
}

/** 纯函数：这一轮他说的、小芽说的、用的工具，最近几轮可见文字，隔了多久。 */
export function turnContextOf(ctx: PostTurnSuggestContext): SuggestTurnContext {
  const start = turnStartIndex(ctx);
  const thisTurn = start >= 0 ? ctx.messages.slice(start) : ctx.messages;
  const user = start >= 0 ? visibleText(ctx.messages[start]) : '';
  const streamed = thisTurn.filter(m => m.role === 'assistant').map(visibleText).filter(Boolean).join('\n');
  const turns: SuggestTurn[] = [];
  for (const m of ctx.messages) {
    const text = visibleText(m);
    if (text) turns.push({ role: m.role, text: text.slice(0, SUGGEST_TURN_CHARS) });
  }
  return {
    user: user.slice(0, SUGGEST_TURN_CHARS),
    assistant: (ctx.assistantText.trim() || streamed).slice(0, SUGGEST_TURN_CHARS),
    tools: toolsOf(thisTurn),
    turns: turns.slice(-SUGGEST_MAX_TURNS),
    away_hours: awayOf(ctx.messages),
  };
}

/** 纯函数：钩子发给生成器的请求（旧字段照填，生成器新旧两版都看得懂）。 */
export function hookRequestOf(t: SuggestTurnContext, cards: string[]): SuggestRequest {
  return {
    last_user: t.user || null,
    last_assistant: t.assistant || null,
    turns: t.turns,
    last_tools: t.tools,
    away_hours: t.away_hours,
    this_turn: { user: t.user, assistant: t.assistant, tools: t.tools, cards },
    source: 'hook',
  };
}

export interface SuggestHookDeps {
  productSessionId: () => string | undefined;
  /** 状态快照 + 这一轮放的卡种类。 */
  load: (ctx: PostTurnSuggestContext) => Promise<{ state: SuggestState; cards: string[] }>;
  generate: (state: SuggestState, req: SuggestRequest, llm: LLM | null, opts: SuggestOptions) => Promise<SuggestResult>;
  llm: () => LLM | null;
  broadcast: (event: string, data: unknown) => void;
  budgetMs: number;
  now: () => number;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** 这一轮放（或重新推出）的卡：updated_at 不早于本轮开始。 */
export function turnCardsOf(repos: Repos, sessionId: string, startedAt: number | null): string[] {
  const since = iso(startedAt);
  if (!since) return [];
  return repos.listChatCards(sessionId).filter(c => c.updated_at >= since).map(c => c.kind);
}

async function defaultLoad(ctx: PostTurnSuggestContext): Promise<{ state: SuggestState; cards: string[] }> {
  const repos = await getRepos();
  const store = new CareerStore(repos, await loadCore());
  return { state: suggestStateOf(repos, store, { sessionId: ctx.sessionId }), cards: turnCardsOf(repos, ctx.sessionId, ctx.startedAt) };
}

const DEFAULT_DEPS: SuggestHookDeps = {
  productSessionId: careerProductSessionId,
  load: defaultLoad,
  generate: suggestFor,
  llm: getShellLLM,
  broadcast: sseBroadcast,
  budgetMs: SUGGEST_HOOK_BUDGET_MS,
  now: Date.now,
};

const TIMED_OUT = Symbol('timed-out');

function withBudget<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** 模型没回来：生成器若自己报 degraded 就信它；超时或没有模型一律算 degraded。 */
function flaggedDegraded(res: SuggestResult): boolean {
  return 'degraded' in res && res.degraded === true;
}

/** 有状态的钩子：generation 与已发记录按会话记在闭包里（测试各建一个）。 */
export function createCareerSuggestHook(deps: SuggestHookDeps = DEFAULT_DEPS) {
  const generation = new Map<string, number>();
  const published = new Map<string, string>();

  /** live：这一代还算数（没被新一轮顶掉）。超时那次即使迟到返回，也按 stale 处理，不进记忆。 */
  async function generate(ctx: PostTurnSuggestContext, live: () => boolean): Promise<{ res: SuggestResult; degraded: boolean }> {
    const { state, cards } = await deps.load(ctx);
    const req = hookRequestOf(turnContextOf(ctx), cards);
    const llm = deps.llm();
    let timedOut = false;
    const sessionId = ctx.sessionId;
    const first = await withBudget(deps.generate(state, req, llm, { sessionId, isStale: () => timedOut || !live() }), deps.budgetMs);
    if (first !== TIMED_OUT) return { res: first, degraded: !llm || flaggedDegraded(first) };
    timedOut = true;
    console.warn(`[career-suggest] hook timeout session=${sessionId} turn=${ctx.turnId ?? '-'} budget=${deps.budgetMs}ms, using fallback`);
    return { res: await deps.generate(state, req, null, { sessionId, isStale: () => !live() }), degraded: true };
  }

  return async function onTurnComplete(ctx: PostTurnSuggestContext, isSuperseded: () => boolean = () => false): Promise<void> {
    const sid = ctx.sessionId;
    if (deps.productSessionId() !== sid) return;
    const msgId = ctx.assistantMessageId;
    if (msgId && published.get(sid) === msgId) return;
    const gen = (generation.get(sid) ?? 0) + 1;
    generation.set(sid, gen);
    const t0 = deps.now();
    const live = () => generation.get(sid) === gen && !isSuperseded();
    try {
      const { res, degraded } = await generate(ctx, live);
      if (!live()) {
        console.log(`[career-suggest] hook superseded session=${sid} turn=${ctx.turnId ?? '-'}`);
        return;
      }
      if (msgId && published.get(sid) === msgId) return;
      const push: SuggestPush = {
        sessionId: sid, turn_id: ctx.turnId, assistant_message_id: msgId,
        chips: res.chips, scene: res.scene, source: 'hook', degraded, ts: deps.now(),
      };
      deps.broadcast(CAREER_SUGGEST_EVENT, push);
      if (msgId) published.set(sid, msgId);
      console.log(`[career-suggest] hook published scene=${res.scene} ms=${deps.now() - t0} degraded=${degraded} chips=${res.chips.length}`);
    } catch (error) {
      console.warn(`[career-suggest] hook FAILED session=${sid} turn=${ctx.turnId ?? '-'}:`, error instanceof Error ? error.message : error);
    }
  };
}

let shared: ReturnType<typeof createCareerSuggestHook> | null = null;

/** agent-session 动态导入后调用的入口（进程内一份 generation / 已发记录）。 */
export function onCareerTurnComplete(ctx: PostTurnSuggestContext, isSuperseded?: () => boolean): Promise<void> {
  shared ??= createCareerSuggestHook();
  return shared(ctx, isSuperseded);
}
