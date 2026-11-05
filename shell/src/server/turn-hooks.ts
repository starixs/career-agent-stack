/**
 * turn-hooks.ts — leaf hook slot decoupling the runtime paths from post-turn
 * side-effects.
 *
 * Why this exists: `agent-session.ts` / `external-session.ts` need to trigger
 * auto session titling after a successful turn, but the Title Service reaches
 * `title-generator.ts`, which imports CLI/env/bridge helpers back from
 * `agent-session.ts`. A direct (even dynamic) import from the runtime files to
 * the service would therefore form an import cycle
 * (agent-session → service → title-generator → agent-session) that
 * dependency-cruiser rejects — bare `import('./x')` edges are still counted.
 *
 * Dependency inversion breaks it cleanly: the runtime files depend only on this
 * leaf (they call `firePostTurnTitleHook`); the service registers the
 * implementation at boot via `setPostTurnTitleHook`. This module imports nothing
 * at runtime (the type imports are erased — dep-cruiser runs with
 * tsPreCompilationDeps:false), so it sits outside every cycle.
 *
 * Keep it titling-specific and tiny: a single function slot, not a generic event
 * bus. Add a sibling slot if a second post-turn side-effect ever needs the same
 * decoupling.
 */

import type { RuntimeType } from '../shared/types/runtime';
import type { ProviderEnv } from './provider-types';

/**
 * 求职下一步条的轮末钩子上下文（plan-r4 §2.1）：在挂点处同步取齐，钩子异步跑时
 * 不再碰 turn 状态。只放类型；实现由 agent-session 动态导入 career/suggest-hook。
 * 消息形状是 builtin-session MessageWire 的结构等价子集（不引 builtin-session 类型）。
 */
export interface PostTurnSuggestBlock {
  type: string;
  text?: string;
  tool?: { name: string };
}

export interface PostTurnSuggestMessage {
  id: string;
  role: 'user' | 'assistant';
  timestamp: string;
  content: string | ReadonlyArray<PostTurnSuggestBlock>;
}

export interface PostTurnSuggestContext {
  sessionId: string;
  turnId: string | null;
  assistantMessageId: string | null;
  rootUserMessageId: string | null;
  /** 这一轮小芽的最终回复文本（composedAssistantText）。 */
  assistantText: string;
  /** getCurrentTurnStartTime()；取不到为 null。 */
  startedAt: number | null;
  /** 最近 ≤14 条消息（投影 messages 的 values 或旧路径 getMessages()）。 */
  messages: ReadonlyArray<PostTurnSuggestMessage>;
}

export type PostTurnSuggestHook = (ctx: PostTurnSuggestContext) => void;

export type PostTurnTitleHook = (
  sessionId: string,
  runtime: RuntimeType,
  model: string | undefined,
  providerEnv?: ProviderEnv,
) => void;

let titleHook: PostTurnTitleHook | null = null;

/** Install the auto-title implementation. Called once at sidecar boot by the
 *  Title Service; later calls replace the slot (last writer wins). */
export function setPostTurnTitleHook(hook: PostTurnTitleHook): void {
  titleHook = hook;
}

/**
 * Fire the post-turn title hook from a runtime path. No-op until the service has
 * installed its implementation. Never throws — a titling failure must never
 * affect the turn that triggered it (red-line: title-gen is best-effort).
 */
export function firePostTurnTitleHook(
  sessionId: string,
  runtime: RuntimeType,
  model: string | undefined,
  providerEnv?: ProviderEnv,
): void {
  if (!titleHook) return;
  try {
    titleHook(sessionId, runtime, model, providerEnv);
  } catch {
    /* best-effort: swallow so the turn is never affected */
  }
}
