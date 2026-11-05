/**
 * 下一步条：每轮小芽说完，拼出输入框上方最多四格（plan-r3-suggest §4.2，2026-11-05）。
 *
 * 先判"他在哪一幕"（suggest-scene.ts，规则），再按这一幕的配方出四格（suggest-recipes*.ts）：
 * 规则格先占位（do / 功能起头 / 固定说法）→ 空位叫一次模型（喂最近 6 轮 + 上一轮工具 + 访谈进度 + 等他的选项，≤2.5s）
 * → 配方兜底补位 → 十条 lint 过线（suggest-lint.ts）→ 保证有回应格、有能办的格 → 按配方的 mode 顺序排，截 4。
 * 模型超时 / 出错 / 全被丢：只用规则与兜底，条至少两格。整条一次出，不先出后补。
 */
import { extractJson, type LLM } from '@career/core';
import { z } from 'zod';

import {
  SUGGEST_MAX_CHARS, SUGGEST_MAX_CHIPS, type SuggestChip, type SuggestMode, type SuggestRequest,
} from '../../shared/careerSuggest';
import { FEATURE_SEED_PREFIX, isActionable, slotOf } from './suggest-chip';
import { entitiesOf, lintChips } from './suggest-lint';
import { LOW_CHIP, recipeFor, type Recipe, type RecipeCtx } from './suggest-recipes';
import { classifyScene, inputOf, roundLabel, type SceneId, type SceneResult, type SuggestInput } from './suggest-scene';
import type { SuggestState } from './suggest-types';

/** 等模型多久：说完到小框出现，超过这个就像卡了（§4.6）。 */
export const SUGGEST_LLM_TIMEOUT_MS = 2_500;
/** 一个功能起头出过以后，隔多少轮再出（L9）。 */
export const SEED_COOLDOWN = 10;
/** 喂给模型的每轮截断长度；最后一轮多给一些（§4.3）。 */
const TURN_CHARS = 300;
const LAST_TURN_CHARS = 600;
/** 模型输出上限：四条短句的 JSON，300 足够。 */
const MODEL_MAX_TOKENS = 300;
const MODEL_TEMPERATURE = 0.4;
/** 叠加低谷时不动的幕：底下有卡在等，条只管卡。 */
const CARD_SCENES: readonly SceneId[] = ['S13', 'S11', 'S7'];
const ASKS_QUESTION = /[？?]\s*$/;

const COMMON = [
  '你在替一个找工作的大学生想"下一句直接可以点的话"。他不爱打字、没耐心、不太信 AI、不会探索。',
  '只输出 JSON：{"chips":[{"text":"…","kind":"say"|"fill","mode":"answer"|"option"|"advance"}]}，最多 {n} 条。',
  `每条 ≤${SUGGEST_MAX_CHARS} 字、第一人称、口语；必须点到对话或状态里出现的具体对象；不编他没说过的事实；不替他答应没决定的事；`,
  'kind=fill 时以冒号结尾等他补；不出现"技能、工具、模型、会话、任务"这类词；不加表情符号；不要和"已占用"的几条重复。',
].join('\n');

const ModelOut = z.object({
  chips: z.array(z.object({
    text: z.string(),
    kind: z.enum(['say', 'fill']).catch('say'),
    mode: z.enum(['answer', 'option', 'advance']).catch('answer'),
  })).max(SUGGEST_MAX_CHIPS * 2).default([]),
});

const recentSeeds: string[] = [];

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

/** 给模型看的状态：去掉 id，只留名字和数字。 */
export function compactState(s: SuggestState): Record<string, unknown> {
  return {
    阶段: s.stage,
    等他: s.asks.map(a => ({ 类: a.kind, 事: a.title, 公司: a.companies, 家数: a.count })),
    底下的卡: s.openCard ? { 类: s.openCard.kind, 默认勾: s.openCard.picked, 勾了几家: s.openCard.pickedIds.length, 表里几家: s.openCard.allIds.length } : null,
    批量: s.batch ? { 状态: s.batch.status, 在填: s.batch.running, 填完: s.batch.done, 排队: s.batch.queued } : null,
    备好待投: s.held.count ? { 份数: s.held.count, 公司: s.held.companies } : null,
    下一批: s.nextJobs.map(j => j.company),
    条件: s.prefs,
    简历: s.resume.has ? { 名字: s.resume.name, 定制几份: s.resume.tailored } : '还没有',
    经历段数: s.resume.experiences,
    三天内截止: s.dueSoon.map(d => ({ 类: d.kind, 公司: d.company })),
    今天投出: s.todaySent,
  };
}

function threadOf(s: SuggestState, scene: SceneId, x: SuggestInput): Record<string, unknown> {
  const askWithOptions = s.asks.find(a => s.askOptions[a.id]?.length);
  return {
    幕: scene,
    访谈这一轮: roundLabel(s.interview?.round ?? null),
    在聊的经历: s.interview?.experienceTitle ?? null,
    小芽接下来想问: s.interview?.followUps ?? [],
    候选选项: askWithOptions ? s.askOptions[askWithOptions.id] : [],
    上一轮用过: x.lastTools,
  };
}

function turnsText(x: SuggestInput): string {
  const turns = x.turns.length ? x.turns : [
    ...(x.lastUser ? [{ role: 'user' as const, text: x.lastUser }] : []),
    ...(x.lastAssistant ? [{ role: 'assistant' as const, text: x.lastAssistant }] : []),
  ];
  return turns.map((t, i) => `${t.role === 'user' ? 'U' : '小芽'}: ${clip(t.text.trim(), i === turns.length - 1 ? LAST_TURN_CHARS : TURN_CHARS)}`).join('\n');
}

function promptOf(recipe: Recipe, s: SuggestState, n: number): string {
  const scene = (recipe.prompt ?? '')
    .replace('{round}', roundLabel(s.interview?.round ?? null) ?? '这段经历')
    .replace('{title}', s.interview?.experienceTitle ? `「${s.interview.experienceTitle}」` : '');
  return `${COMMON.replace('{n}', String(n))}\n幕：${scene}`;
}

interface ModelAsk { llm: LLM; recipe: Recipe; ctx: RecipeCtx; taken: readonly SuggestChip[]; n: number }

async function askModel({ llm, recipe, ctx, taken, n }: ModelAsk): Promise<SuggestChip[]> {
  const user = [
    `状态：${JSON.stringify(compactState(ctx.s))}`,
    `线程：${JSON.stringify(threadOf(ctx.s, ctx.scene, ctx.x))}`,
    `最近几轮：\n${turnsText(ctx.x) || '（还没说话）'}`,
    `已占用：${JSON.stringify(taken.map(c => c.text))}`,
    `要你出：${n} 条`,
  ].join('\n');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SUGGEST_LLM_TIMEOUT_MS); });
  const call = llm.complete({ system: promptOf(recipe, ctx.s, n), messages: [{ role: 'user', content: user }], json: true, maxTokens: MODEL_MAX_TOKENS, temperature: MODEL_TEMPERATURE })
    .then(res => ModelOut.parse(extractJson(res.text)));
  try {
    const out = await Promise.race([call, timeout]);
    if (!out) console.warn(`[career-suggest] model timed out after ${SUGGEST_LLM_TIMEOUT_MS}ms scene=${ctx.scene}, rules only`);
    return (out?.chips ?? []).slice(0, n).map(c => {
      const text = c.text.trim().replace(/^["“「]|["”」]$/g, '');
      return { text, slot: slotOf(c.mode), kind: c.kind, mode: c.mode, seed_id: null };
    });
  } catch (error) {
    console.warn(`[career-suggest] model step failed scene=${ctx.scene}, rules only:`, error instanceof Error ? error.message : error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const present = (list: ReadonlyArray<SuggestChip | null>): SuggestChip[] => list.filter((c): c is SuggestChip => c !== null);
const isReply = (c: SuggestChip) => c.mode === 'answer' || c.mode === 'option';

/** 条上没有满足 want 的格时，从候选里换一格进来（不满就补，满了按 replaceIndex 换）。 */
function ensure(chosen: SuggestChip[], pool: readonly SuggestChip[], want: (c: SuggestChip) => boolean): SuggestChip[] {
  if (chosen.some(want)) return chosen;
  const extra = pool.find(c => want(c) && !chosen.includes(c));
  if (!extra) return chosen;
  if (chosen.length < SUGGEST_MAX_CHIPS) return [...chosen, extra];
  const i = replaceIndex(chosen);
  return i < 0 ? chosen : chosen.map((c, j) => (j === i ? extra : c));
}

/** 换哪一格：先换最后一格"推导 / 填空"，再换最后一格回答；能办的格不换。 */
function replaceIndex(chosen: readonly SuggestChip[]): number {
  const soft = chosen.map(c => !isActionable(c) && c.mode !== 'answer').lastIndexOf(true);
  return soft >= 0 ? soft : chosen.map(c => !isActionable(c)).lastIndexOf(true);
}

/** 叠加低谷：把一格（不是能办的、不是退出口）换成"看我这个月的数"。 */
function overlayLow(chosen: SuggestChip[], scene: SceneId, low: boolean): SuggestChip[] {
  if (!low || CARD_SCENES.includes(scene) || chosen.some(c => c.text === LOW_CHIP.text)) return chosen;
  if (chosen.length < SUGGEST_MAX_CHIPS) return [...chosen, LOW_CHIP];
  const i = chosen.map(c => !isActionable(c) && c.mode !== 'exit').lastIndexOf(true);
  return i < 0 ? chosen : chosen.map((c, j) => (j === i ? LOW_CHIP : c));
}

function sortByOrder(chips: SuggestChip[], order: readonly SuggestMode[]): SuggestChip[] {
  const rank = (m: SuggestMode) => (order.includes(m) ? order.indexOf(m) : order.length);
  return chips.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.mode) - rank(b.c.mode) || a.i - b.i).map(({ c }) => c);
}

function rememberShown(chips: readonly SuggestChip[]): void {
  for (const c of chips) {
    if (!c.seed_id?.startsWith(FEATURE_SEED_PREFIX)) continue;
    recentSeeds.push(c.seed_id);
    while (recentSeeds.length > SEED_COOLDOWN) recentSeeds.shift();
  }
}

function safeClassify(s: SuggestState, x: SuggestInput): SceneResult {
  try {
    return classifyScene(s, x);
  } catch (error) {
    console.warn('[career-suggest] classify failed, using S29:', error instanceof Error ? error.message : error);
    return { scene: 'S29', low: false };
  }
}

export interface SuggestResult { chips: SuggestChip[]; scene: SceneId }

/** 一整条：判幕 → 配方 → 模型补位 → lint → 回应格 / 能办格保底 → 低谷叠加 → 排序截 4。 */
export async function suggestFor(base: SuggestState, req: SuggestRequest, llm: LLM | null): Promise<SuggestResult> {
  const s = typeof req.away_hours === 'number' ? { ...base, awayHours: req.away_hours } : base;
  const x = inputOf(req);
  const { scene, low } = safeClassify(s, x);
  const recipe = recipeFor(scene);
  const ctx: RecipeCtx = { s, x, scene, recent: new Set(recentSeeds) };
  const fixed = present(recipe.rules(ctx));
  const n = SUGGEST_MAX_CHIPS - fixed.length;
  const wantsModel = !!llm && !!recipe.prompt && n > 0 && !!(x.lastAssistant || x.lastUser);
  const model = wantsModel && llm ? await askModel({ llm, recipe, ctx, taken: fixed, n }) : [];
  const fallback = present(recipe.fallback(ctx));
  const entities = entitiesOf(s, [x.lastUser, x.lastAssistant, ...x.turns.map(t => t.text)]);
  const { kept } = lintChips([...fixed, ...model, ...fallback], { scene, entities, cardKind: s.openCard?.kind ?? null, recent: ctx.recent });
  let chosen = kept.slice(0, SUGGEST_MAX_CHIPS);
  if (ASKS_QUESTION.test(x.lastAssistant)) chosen = ensure(chosen, kept, isReply); // L10 回应性
  chosen = ensure(chosen, kept, isActionable);
  chosen = sortByOrder(overlayLow(chosen, scene, low), recipe.order);
  rememberShown(chosen);
  return { chips: chosen, scene };
}

/** 路由旧名：只要格子。 */
export async function buildSuggestions(s: SuggestState, req: SuggestRequest, llm: LLM | null): Promise<SuggestChip[]> {
  return (await suggestFor(s, req, llm)).chips;
}

/** 测试用：清掉最近出过的功能起头。 */
export function resetSuggestMemory(): void {
  recentSeeds.length = 0;
}
