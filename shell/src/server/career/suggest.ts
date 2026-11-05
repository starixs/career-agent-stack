/**
 * 下一步条：每轮小芽说完，拼出输入框上方最多四格（plan-r2 §B 2026-11-05）。
 *
 * 顺序固定：接话 act（≤2，模型）→ 下一步 next（规则）→ 塑形 shape（规则出候选、模型挑一条）→ 退出 exit（规则）。
 * 底下有卡在等他时接话给卡的次动作（规则，不叫模型）。模型只做两件小事：替他接话、挑一条塑形；
 * 超时（2.5s）或出错就只出规则那几格，空出来的位置用后面的塑形候选补上。整条一次出，不先出后补。
 */
import { extractJson, type LLM } from '@career/core';
import { z } from 'zod';

import {
  SUGGEST_MAX_CHARS, SUGGEST_MAX_CHIPS,
  type SuggestChip, type SuggestRequest, type SuggestSlot,
} from '../../shared/careerSuggest';
import { cardActs, exitChip, nextChip, shapeCandidates, type SuggestTalk } from './suggest-seeds';
import type { ShapeCandidate } from './suggest-shapes';
import type { SuggestState } from './suggest-types';

/** 等模型多久：说完到小框出现，超过这个就像卡了（3.5→2.5，§B.6）。 */
export const SUGGEST_LLM_TIMEOUT_MS = 2_500;
/** 一条老种子出过以后，隔多少条再出：不让同一句反复出现。 */
export const SEED_COOLDOWN = 10;
/** 喂给模型的对话截断长度：只需要最后一来一回的意思。 */
const CONTEXT_CHARS = 600;
const MAX_ACTS = 2;
/** 模型输出上限：两句接话 + 一个序号，220 足够。 */
const MODEL_MAX_TOKENS = 220;
const MODEL_TEMPERATURE = 0.5;
/** 接话里不该出现的开发者词（§B.6）。 */
const DEV_WORDS = /技能|工具|模型|会话|Agent|agent|任务/;
const SLOT_ORDER: readonly SuggestSlot[] = ['act', 'next', 'shape', 'exit'];

const SYSTEM = [
  '你在替一个找工作的大学生想"下一句直接可以点的话"。他不爱打字、没耐心、不太信 AI。',
  '只输出 JSON：{"act":[{"text":"…","kind":"say"|"fill"}],"shape":<候选序号或-1>}',
  `act 最多 ${MAX_ACTS} 条：替他回小芽刚说的话，第一人称、口语、≤${SUGGEST_MAX_CHARS} 字；必须点到对话或状态里出现的具体对象（公司名、日期、数字、刚提的那件事）；`,
  '小芽问了问题就给两种不同的答法；没问就给最可能接着说的一句；不编他没说过的事实；不替他答应没决定的事；kind 为 fill 时 text 以冒号结尾，等他补完；',
  '不出现"技能、工具、模型、会话、Agent、任务"这类词；不加表情和符号。',
  'shape：从候选里挑此刻最自然的一条，都不合适填 -1。',
].join('\n');

const ModelOut = z.object({
  act: z.array(z.object({ text: z.string(), kind: z.enum(['say', 'fill']).catch('say') })).max(4).default([]),
  shape: z.number().int().default(-1),
});
type ModelOut = z.infer<typeof ModelOut>;

const recentSeeds: string[] = [];

function clip(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  return t.length > CONTEXT_CHARS ? `${t.slice(0, CONTEXT_CHARS)}…` : t;
}

/** 一条建议能不能用：非空、不超长、不是 JSON 残渣、没有开发者词。 */
export function cleanChip(text: string): string | null {
  const t = text.trim().replace(/^["“「]|["”」]$/g, '');
  if (!t || t.length > SUGGEST_MAX_CHARS || /[{}<>]/.test(t) || DEV_WORDS.test(t)) return null;
  return t;
}

/** 给模型看的状态：去掉 id，只留名字和数字。 */
export function compactState(s: SuggestState): Record<string, unknown> {
  return {
    阶段: s.stage,
    等他: s.asks.map(a => ({ 类: a.kind, 事: a.title, 公司: a.companies, 家数: a.count })),
    底下的卡: s.openCard ? { 类: s.openCard.kind, 默认勾: s.openCard.picked, 勾了几家: s.openCard.pickedIds.length, 表里几家: s.openCard.allIds.length } : null,
    批量: s.batch ? { 状态: s.batch.status, 在填: s.batch.running, 填完: s.batch.done, 排队: s.batch.queued } : null,
    备好待投: s.held.count ? { 份数: s.held.count, 公司: s.held.companies } : null,
    下一批: s.nextJobs.map(j => j.company),
    能投家数: s.pool.fits,
    条件: s.prefs,
    简历: s.resume.has ? { 名字: s.resume.name, 定制几份: s.resume.tailored } : '还没有',
    刚定制: s.lastTailor ? { 公司: s.lastTailor.company, 改了几处: s.lastTailor.changes } : null,
    今天投出: s.todaySent,
    离开几小时: s.awayHours === null ? null : Math.round(s.awayHours),
    钟点: s.hour,
  };
}

async function askModel(llm: LLM, s: SuggestState, req: SuggestRequest, shapes: readonly ShapeCandidate[]): Promise<ModelOut | null> {
  const user = [
    `状态：${JSON.stringify(compactState(s))}`,
    `他最后说：${clip(req.last_user) || '（还没说话）'}`,
    `小芽最后说：${clip(req.last_assistant) || '（还没说话）'}`,
    `候选：${shapes.map((c, i) => `${i}. ${c.chip.text}`).join(' ') || '无'}`,
  ].join('\n');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SUGGEST_LLM_TIMEOUT_MS); });
  const call = llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: user }], json: true, maxTokens: MODEL_MAX_TOKENS, temperature: MODEL_TEMPERATURE })
    .then(res => ModelOut.parse(extractJson(res.text)));
  try {
    const out = await Promise.race([call, timeout]);
    if (!out) console.warn(`[career-suggest] model timed out after ${SUGGEST_LLM_TIMEOUT_MS}ms, rules only`);
    return out;
  } catch (error) {
    console.warn('[career-suggest] model step failed, rules only:', error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function modelActs(model: ModelOut | null): SuggestChip[] {
  const chips: SuggestChip[] = [];
  for (const a of model?.act ?? []) {
    const text = cleanChip(a.text);
    if (text) chips.push({ text, slot: 'act', kind: a.kind, seed_id: null });
  }
  return chips.slice(0, MAX_ACTS);
}

function rememberSeed(c: ShapeCandidate): void {
  if (!c.cools) return;
  recentSeeds.push(c.id);
  while (recentSeeds.length > SEED_COOLDOWN) recentSeeds.shift();
}

/** 塑形：模型挑的那条在前，其余按候选顺序补位。 */
function orderShapes(shapes: readonly ShapeCandidate[], picked: number | undefined): ShapeCandidate[] {
  if (picked === undefined || picked < 0 || picked >= shapes.length) return [...shapes];
  return [shapes[picked], ...shapes.filter((_, i) => i !== picked)];
}

/** 拼条：接话、下一步、退出口先占位，剩下的位置给塑形；同一句不出现两次；按槽位顺序排。 */
export function assemble(acts: SuggestChip[], next: SuggestChip | null, exit: SuggestChip | null, shapes: readonly ShapeCandidate[]): { chips: SuggestChip[]; used: ShapeCandidate[] } {
  const seen = new Set<string>();
  const keep = (c: SuggestChip | null): c is SuggestChip => !!c && !seen.has(c.text) && (seen.add(c.text), true);
  const fixed = [...acts.slice(0, MAX_ACTS), next, exit].filter(keep);
  const used: ShapeCandidate[] = [];
  for (const c of shapes) {
    if (fixed.length + used.length >= SUGGEST_MAX_CHIPS) break;
    if (keep(c.chip)) used.push(c);
  }
  const chips = [...fixed, ...used.map(c => c.chip)].slice(0, SUGGEST_MAX_CHIPS);
  chips.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  return { chips, used };
}

export async function buildSuggestions(s: SuggestState, req: SuggestRequest, llm: LLM | null): Promise<SuggestChip[]> {
  const talk: SuggestTalk = { lastUser: req.last_user ?? '', lastAssistant: req.last_assistant ?? '' };
  const shapes = shapeCandidates(s, new Set(recentSeeds));
  const ruleActs = cardActs(s);
  const wantsModel = !!llm && !ruleActs && !!(req.last_assistant || req.last_user);
  const model = wantsModel && llm ? await askModel(llm, s, req, shapes) : null;
  const acts = ruleActs ?? modelActs(model);
  const { chips, used } = assemble(acts, nextChip(s, talk), exitChip(s), orderShapes(shapes, model?.shape));
  used.forEach(rememberSeed);
  return chips;
}

/** 测试用：清掉最近出过的种子。 */
export function resetSuggestMemory(): void {
  recentSeeds.length = 0;
}
