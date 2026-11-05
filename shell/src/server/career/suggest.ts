/**
 * 建议条：每轮小芽说完，拼出输入框上方的四个小框（face-beta-polish 2026-11-05）。
 *
 * 顺序：接话（≤2，模型）→ 主线下一步（规则）→ 培养心智的种子（模型从候选里挑一条，挑不出就取第一条）。
 * 模型只做两件小事：替他接话、挑一条最贴的种子；超时或出错就只出规则那两格，不卡他说话。
 */
import { extractJson, type LLM } from '@career/core';
import { z } from 'zod';

import {
  SUGGEST_MAX_CHARS, SUGGEST_MAX_CHIPS,
  type SuggestChip, type SuggestRequest,
} from '../../shared/careerSuggest';
import { mainlineChip, seedCandidates, type Seed, type SuggestContext } from './suggest-seeds';

/** 等模型多久：说完到小框出现，超过这个就像卡了。 */
export const SUGGEST_LLM_TIMEOUT_MS = 3_500;
/** 一条种子出过以后，隔多少条种子再出：不让同一句反复出现。 */
export const SEED_COOLDOWN = 10;
/** 喂给模型的上下文截断长度：只需要最后一来一回的意思。 */
const CONTEXT_CHARS = 600;
const MAX_REPLIES = 2;

const SYSTEM = [
  '你在帮一个求职的大学生想"下一句可以说什么"。他不爱打字、没耐心，也不太敢开口。',
  `给出最多 ${MAX_REPLIES} 句他可能想回小芽的话：用他的口吻、第一人称、口语，每句不超过 ${SUGGEST_MAX_CHARS} 个字。`,
  '小芽刚问了问题，就给能直接回答的话（可以是两种不同的答法）；小芽没问，就给他最可能接着说的话。',
  '不要写技能、工具、模型、会话、Agent 这类词；不要替他答应他没决定的事；不要加标点以外的符号或表情。',
  '另外从"候选"里挑一条此刻最自然的（填序号，都不合适填 -1）。',
  '只输出 JSON：{"replies": ["…"], "seed": 0}',
].join('\n');

const ModelOut = z.object({
  replies: z.array(z.string()).max(4).default([]),
  seed: z.number().int().default(-1),
});

const recentSeeds: string[] = [];

function clip(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  return t.length > CONTEXT_CHARS ? `${t.slice(0, CONTEXT_CHARS)}…` : t;
}

/** 一条建议能不能用：非空、不超长、不是 JSON 残渣。 */
export function cleanChip(text: string): string | null {
  const t = text.trim().replace(/^["“「]|["”」]$/g, '');
  if (!t || t.length > SUGGEST_MAX_CHARS || /[{}<>]/.test(t)) return null;
  return t;
}

async function askModel(llm: LLM, req: SuggestRequest, seeds: Seed[]): Promise<z.infer<typeof ModelOut> | null> {
  const user = [
    `他最后说：${clip(req.last_user) || '（还没说话）'}`,
    `小芽最后说：${clip(req.last_assistant) || '（还没说话）'}`,
    `候选：${seeds.map((s, i) => `${i}. ${s.text}`).join('；') || '无'}`,
  ].join('\n');
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), SUGGEST_LLM_TIMEOUT_MS));
  const call = llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: user }], json: true, maxTokens: 200, temperature: 0.6 })
    .then(res => ModelOut.parse(extractJson(res.text)));
  try {
    return await Promise.race([call, timeout]);
  } catch (error) {
    console.warn('[career-suggest] model step failed, rules only:', error instanceof Error ? error.message : error);
    return null;
  }
}

function rememberSeed(id: string): void {
  recentSeeds.push(id);
  while (recentSeeds.length > SEED_COOLDOWN) recentSeeds.shift();
}

/** 去重并截到上限：同一句不出现两次。 */
function dedupe(chips: SuggestChip[]): SuggestChip[] {
  const seen = new Set<string>();
  return chips.filter(c => (seen.has(c.text) ? false : (seen.add(c.text), true))).slice(0, SUGGEST_MAX_CHIPS);
}

export async function buildSuggestions(ctx: SuggestContext, req: SuggestRequest, llm: LLM | null): Promise<SuggestChip[]> {
  const seeds = seedCandidates(ctx, new Set(recentSeeds));
  const model = llm && (req.last_assistant || req.last_user) ? await askModel(llm, req, seeds) : null;
  const replies = (model?.replies ?? []).map(cleanChip).filter((t): t is string => !!t).slice(0, MAX_REPLIES);
  const chips: SuggestChip[] = replies.map(text => ({ text, slot: 'reply', seed_id: null }));
  // 底部有张卡在等他拍板时，不出主线那一条：卡上的按钮就是下一步
  if (!req.pending_cards?.length) chips.push({ text: mainlineChip(ctx), slot: 'mainline', seed_id: null });
  const seed = seeds[model && model.seed >= 0 && model.seed < seeds.length ? model.seed : 0];
  if (seed) {
    chips.push({ text: seed.text, slot: 'seed', seed_id: seed.id });
    rememberSeed(seed.id);
  }
  return dedupe(chips);
}

/** 测试用：清掉最近出过的种子。 */
export function resetSuggestMemory(): void {
  recentSeeds.length = 0;
}
