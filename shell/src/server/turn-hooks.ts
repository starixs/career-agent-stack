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

/**
 * Sibling slot #2 — usage metering (billing). Same dependency-inversion reason
 * as the title slot: runtime paths fire it, the career billing service
 * (`career/billing-service.ts`) installs the implementation at boot. Fired for
 * every model call that spent tokens (chat turns, title generation, …) so the
 * credit ledger sees all spend. Best-effort: a billing failure must not break
 * the turn that already happened.
 */
export interface MeteredModelUsage {
  /** Idempotency key; the ledger records each key once (e.g. `chat:<session>:<result uuid>`). */
  key: string;
  /** Accumulation window: chat turns use the session id; omitted = the background window of the day. */
  scope?: string;
  origin: 'chat' | 'background';
  model?: string;
  providerId?: string;
  /** Uncached input tokens (DeepSeek reports cache hits separately). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type UsageMeterHook = (usage: MeteredModelUsage) => void;

let usageMeterHook: UsageMeterHook | null = null;

/** Install the billing implementation (last writer wins); null uninstalls. */
export function setUsageMeterHook(hook: UsageMeterHook | null): void {
  usageMeterHook = hook;
}

/** Fire the usage meter; no-op until installed or when nothing was spent. Never throws. */
export function fireUsageMeterHook(usage: MeteredModelUsage): void {
  if (!usageMeterHook) return;
  if (!usage.inputTokens && !usage.outputTokens && !usage.cacheReadTokens && !usage.cacheCreationTokens) return;
  try {
    usageMeterHook(usage);
  } catch (error) {
    console.error(`[billing] FAILED hook key=${usage.key} err=${String(error)}`);
  }
}
