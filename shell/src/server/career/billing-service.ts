/**
 * 计费服务（侧车侧）：把各处的用量埋点落进本机积分账本（@career/core 的 billing/）。
 *
 * - 模型用量：主对话每轮、标题生成、ShellLLM 后台调用都经 turn-hooks 的用量槽进来（启动时 install）。
 * - 工具用量：联网搜索等按次计价的外部服务直接调 meterToolUsage。
 * - 现在只记账、不拦截：没有账号和充值前，余额到 0 也不挡用户；云端账户上线后改为上报云端、以云端为准。
 * - 计费失败绝不打断用户的活：只打 `[billing] FAILED` 锚点日志，事后按日志补账。
 */
import type { MeterResult } from '@career/core';
import { setUsageMeterHook, type MeteredModelUsage } from '../turn-hooks';
import { loadCore } from './core-module';
import { getRepos } from './db';

/** 正在落账的写入：测试和关库前可以等它们写完。 */
const inflight = new Set<Promise<void>>();

function track(p: Promise<void>): void {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** 等所有已触发的记账写完（测试用；关库前也可调）。 */
export async function flushBillingWrites(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}

function logResult(kind: string, key: string, name: string, r: MeterResult): void {
  if (!r.recorded) return;
  console.log(`[billing] METERED kind=${kind} key=${key} name=${name} credits=${r.creditsCharged} balance=${r.balance}`);
  // 走了兜底价 / 没定价：照记不误，但必须显式可见，不然「本该收钱」没人发现
  if (r.unpriced) console.warn(`[billing] UNPRICED kind=${kind} name=${name} key=${key}`);
}

export async function meterModelUsage(usage: MeteredModelUsage): Promise<void> {
  try {
    const [core, repos] = await Promise.all([loadCore(), getRepos()]);
    const r = core.recordLlmUsage(repos.db, {
      idempotencyKey: usage.key,
      scope: usage.scope ?? core.backgroundScope(),
      origin: usage.origin,
      model: usage.model ?? 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    });
    logResult('llm', usage.key, usage.model ?? 'unknown', r);
  } catch (error) {
    console.error(`[billing] FAILED kind=llm key=${usage.key} model=${usage.model ?? 'unknown'} in=${usage.inputTokens} out=${usage.outputTokens} cache=${usage.cacheReadTokens ?? 0} err=${String(error)}`);
  }
}

/** 按次计价的工具（联网搜索等）。key 不传就每次一条新的。 */
export async function meterToolUsage(tool: string, opts: { count?: number; key?: string; scope?: string } = {}): Promise<void> {
  const key = opts.key ?? `tool:${tool}:${crypto.randomUUID()}`;
  try {
    const [core, repos] = await Promise.all([loadCore(), getRepos()]);
    const r = core.recordToolUsage(repos.db, { idempotencyKey: key, scope: opts.scope ?? core.backgroundScope(), tool, count: opts.count });
    logResult('tool', key, tool, r);
  } catch (error) {
    console.error(`[billing] FAILED kind=tool key=${key} tool=${tool} count=${opts.count ?? 1} err=${String(error)}`);
  }
}

/** 侧车启动时调一次：把用量槽接到本机账本。 */
export function installBillingMeter(): void {
  setUsageMeterHook(usage => track(meterModelUsage(usage)));
}

/** 不等结果的工具记账（调用方是用户正在等的路径，记账不能拖慢它）。 */
export function meterToolUsageInBackground(tool: string, opts: { count?: number; key?: string; scope?: string } = {}): void {
  track(meterToolUsage(tool, opts));
}
