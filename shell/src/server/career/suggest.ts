/**
 * 下一步条：每轮小芽说完，拼出输入框上方最多四格（plan-r4-suggest §3.1，2026-11-05）。
 *
 * 先判"他在哪一幕"（suggest-scene.ts，规则）→ 取这一幕的思路 + 示例 + 允许意图（guideFor）
 * → 每一幕都叫一次模型写全部四格 {text, intent, target}（喂状态快照、这一轮、最近 6 轮、上一轮出过的，≤3s）
 * → 意图换成带真 id 的动作，换不出的丢（suggest-intents.ts）→ 旧配方的规则格与兜底格排在后面补位
 * → 质量线（suggest-lint.ts，L1–L9 + L11 本轮锚定 + L12 不和上一轮重样）
 * → 保证有回应格、有能办的格、卡的主动作、类型不全相同（L10 / L13）→ 低谷叠加 → 按 mode 排，截 4。
 * 模型超时 / 出错 / 解析后不到 2 格：就是旧配方（规则 + 兜底），条至少两格，degraded = true。整条一次出，不先出后补。
 */
import { extractJson, type LLM } from '@career/core';

import {
  SUGGEST_MAX_CHIPS, SUGGEST_MODEL_TIMEOUT_MS, type SuggestChip, type SuggestMode, type SuggestRequest, type SuggestThisTurn,
} from '../../shared/careerSuggest';
import { FEATURE_SEED_PREFIX, isActionable } from './suggest-chip';
import { SUGGEST_INTENTS, type SceneGuide, type SuggestIntent } from './suggest-guide-types';
import { ModelOut, resolveIntents, type ModelChip } from './suggest-intents';
import { anchorsOf, entitiesOf, lintChips, STARTER_BUTTONS, type LintCtx, type LintResult } from './suggest-lint';
import { buildPrompt } from './suggest-prompt';
import { guideFor, LOW_CHIP, recipeFor, type Recipe, type RecipeCtx } from './suggest-recipes';
import { classifyScene, inputOf, SCENE_NAMES, starterVisible, type SceneId, type SceneResult, type SuggestInput } from './suggest-scene';
import { careerProductSessionId } from './product-session';
import type { SuggestState } from './suggest-types';

/** 等模型多久：唯一来源在 shared（钩子预算、前端等待都由它推出）。 */
export const SUGGEST_LLM_TIMEOUT_MS = SUGGEST_MODEL_TIMEOUT_MS;
/** 一个功能起头出过以后，隔多少轮再出（L9）。 */
export const SEED_COOLDOWN = 10;
/** 模型输出上限：紧凑行 {"c":[["文字","intent","target"]]}，四条 ≈ 60–90 token；留到八条的余量。 */
const MODEL_MAX_TOKENS = 180;
const MODEL_TEMPERATURE = 0.5;
/** 模型格留下不到这么多就算走了兜底（degraded）。 */
const MIN_MODEL_CHIPS = 2;
/** 条上至少几格：不够时把 L12（和上一轮重样）丢掉的放回来，宁可重样也不空。 */
const MIN_BAR_CHIPS = 2;
/** 叠加低谷时不动的幕：底下有卡在等，条只管卡。 */
const CARD_SCENES: readonly SceneId[] = ['S13', 'S11', 'S7'];
const ASKS_QUESTION = /[？?]\s*$/;
/** 没有会话 id 时 lastShown 记在这个键下。 */
const NO_SESSION = '_';

const recentSeeds: string[] = [];
/** 每个会话上一轮出过的四格（进程内；重启后第一轮可能重样，plan-r4 §8-5 已接受）。 */
const lastShown = new Map<string, SuggestChip[]>();

const present = (list: ReadonlyArray<SuggestChip | null>): SuggestChip[] => list.filter((c): c is SuggestChip => c !== null);
const isReply = (c: SuggestChip) => c.mode === 'answer' || c.mode === 'option';
const isCardMain = (c: SuggestChip) => c.action?.type === 'start_card';

/** 钩子送来的 this_turn 补齐旧字段（判幕只看 last_user / last_assistant / last_tools）。 */
function withThisTurn(req: SuggestRequest): SuggestRequest {
  const t = req.this_turn;
  if (!t) return req;
  return {
    ...req,
    last_user: req.last_user ?? (t.user.trim() || null),
    last_assistant: req.last_assistant ?? (t.assistant.trim() || null),
    last_tools: req.last_tools?.length ? req.last_tools : t.tools,
  };
}

function thisTurnOf(req: SuggestRequest, x: SuggestInput): SuggestThisTurn {
  return req.this_turn ?? { user: x.lastUser, assistant: x.lastAssistant, tools: x.lastTools, cards: [] };
}

/** 这一幕的思路；GUIDES 没写时用旧幕段或幕名顶上，意图全开。 */
function guideOf(scene: SceneId, recipe: Recipe): SceneGuide {
  return guideFor(scene) ?? {
    text: recipe.prompt ?? `${SCENE_NAMES[scene]}：按这一轮和状态写最顺手的四条。`,
    intents: SUGGEST_INTENTS,
    anchor: 'strict',
    examples: [],
  };
}

interface ModelAsk { llm: LLM; system: string; user: string; scene: SceneId }

/** 叫一次模型；超时 / 出错返回 null（调用方走兜底）。 */
async function askModel({ llm, system, user, scene }: ModelAsk): Promise<ModelChip[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SUGGEST_LLM_TIMEOUT_MS); });
  const call = llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, maxTokens: MODEL_MAX_TOKENS, temperature: MODEL_TEMPERATURE })
    .then(res => ModelOut.parse(extractJson(res.text)).chips);
  try {
    const out = await Promise.race([call, timeout]);
    if (!out) console.warn(`[career-suggest] model timed out after ${SUGGEST_LLM_TIMEOUT_MS}ms scene=${scene}, fallback recipe`);
    return out;
  } catch (error) {
    console.warn(`[career-suggest] model step failed scene=${scene}, fallback recipe:`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

/** L13 类型多样：四格同一种触发（全 say / 全 fill / 全 do）时换一格别的进来。 */
function ensureVariety(chosen: SuggestChip[], pool: readonly SuggestChip[]): SuggestChip[] {
  const kind = chosen[0]?.kind;
  if (chosen.length < SUGGEST_MAX_CHIPS || !chosen.every(c => c.kind === kind)) return chosen;
  const extra = pool.find(c => c.kind !== kind && !chosen.includes(c));
  return extra ? [...chosen.slice(0, -1), extra] : chosen;
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

/** 这一幕的 say 格记成 answer 还是 option：排序里谁先出现用谁。 */
function replyModeOf(order: readonly SuggestMode[]): SuggestMode {
  return order.find(m => m === 'answer' || m === 'option') ?? 'answer';
}

function rememberShown(key: string, chips: readonly SuggestChip[]): void {
  lastShown.set(key, [...chips]);
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

/** 过线后留下的；不够两格时把只因和上一轮重样被丢的放回来。 */
function keptOf(res: LintResult): SuggestChip[] {
  if (res.kept.length >= MIN_BAR_CHIPS) return res.kept;
  const back = res.dropped.filter(d => d.rule === 'L12').map(d => d.chip);
  return [...res.kept, ...back];
}

/** 从过了线的候选里定这一条：截 4 → 回应格 → 能办格 → 卡的主动作 → 类型多样 → 低谷 → 排序。 */
function pickBar(kept: readonly SuggestChip[], x: SuggestInput, scene: SceneId, low: boolean, order: readonly SuggestMode[]): SuggestChip[] {
  let chosen = kept.slice(0, SUGGEST_MAX_CHIPS);
  if (ASKS_QUESTION.test(x.lastAssistant)) chosen = ensure(chosen, kept, isReply); // L10 回应性
  chosen = ensure(chosen, kept, isActionable);
  if (scene === 'S13') chosen = ensure(chosen, kept, isCardMain);
  chosen = ensureVariety(chosen, kept);
  return sortByOrder(overlayLow(chosen, scene, low), order);
}

export interface SuggestResult {
  chips: SuggestChip[];
  scene: SceneId;
  /** 模型没回来 / 被丢得不到 2 格：这一条主要是兜底配方。 */
  degraded?: boolean;
}

export interface SuggestOptions {
  /** 记"上一轮出过"用的会话 id；缺省取个人助理会话（careerProductSessionId）。 */
  sessionId?: string | null;
  /** 结果已经没人要了（钩子超时改发兜底 / 被新一轮顶掉）：不记 lastShown、不压功能冷却。 */
  isStale?: () => boolean;
}

interface ModelRun { raw: ModelChip[] | null; ms: number; asked: boolean }

/** 有话才叫模型；记下用了多久（日志锚点用）。 */
async function runModel(llm: LLM | null, x: SuggestInput, ask: Omit<ModelAsk, 'llm'>): Promise<ModelRun> {
  if (!llm || !(x.lastAssistant || x.lastUser)) return { raw: null, ms: 0, asked: false };
  const t0 = Date.now();
  const raw = await askModel({ llm, ...ask });
  return { raw, ms: Date.now() - t0, asked: true };
}

/** 补位只用示例里的这两种：不带动作，名字不对的会被 L4 / L11 挡下。 */
const REFILL_EXAMPLE_INTENTS: readonly SuggestIntent[] = ['say', 'fill'];

/** 这一幕思路里的示例行 'text|intent|target' → 模型格（只留说 / 填空）。 */
function exampleChips(guide: SceneGuide): ModelChip[] {
  return guide.examples.flat().flatMap(row => {
    const [text = '', intent = 'say'] = row.split('|').map(p => p.trim());
    const known = REFILL_EXAMPLE_INTENTS.find(i => i === intent);
    return text && known ? [{ text, intent: known, target: null }] : [];
  });
}

interface RefillAsk { kept: SuggestChip[]; guide: SceneGuide; scene: SceneId; ctx: RecipeCtx; lint: LintCtx; replyMode: SuggestMode }

/** 补位的通用兜底：一般幕拿 S29 的；S29 自己再拿 S29 等于重复，改拿 S26 按阶段的起头（真机 r2：S29 只剩两格）。 */
const REFILL_FALLBACK_OF = (scene: SceneId): SceneId => (scene === 'S29' ? 'S26' : 'S29');

/** 过线后不到四格：先拿这一幕示例里的说 / 填空，再拿通用兜底补到四格；补的也要过线、不和已有的重复。 */
function refill({ kept, guide, scene, ctx, lint, replyMode }: RefillAsk): SuggestChip[] {
  if (kept.length >= SUGGEST_MAX_CHIPS) return kept;
  const fromGuide = resolveIntents(exampleChips(guide), { s: ctx.s, allowed: REFILL_EXAMPLE_INTENTS, replyMode });
  const from = REFILL_FALLBACK_OF(scene);
  const generic = present(recipeFor(from).fallback({ ...ctx, scene: from }));
  const more = lintChips([...fromGuide, ...generic], lint, kept).kept;
  const out = [...kept, ...more.slice(0, SUGGEST_MAX_CHIPS - kept.length)];
  if (out.length > kept.length) console.log(`[career-suggest] refill +${out.length - kept.length} scene=${scene}`);
  return out;
}

/** 一整条：判幕 → 模型写四格 → 意图解析 → 兜底补位 → lint → 保底 → 低谷叠加 → 排序截 4。 */
export async function suggestFor(base: SuggestState, rawReq: SuggestRequest, llm: LLM | null, opts: SuggestOptions = {}): Promise<SuggestResult> {
  const req = withThisTurn(rawReq);
  const s = typeof req.away_hours === 'number' ? { ...base, awayHours: req.away_hours } : base;
  const x = inputOf(req);
  const { scene, low } = safeClassify(s, x);
  const recipe = recipeFor(scene);
  const guide = guideOf(scene, recipe);
  const key = opts.sessionId ?? careerProductSessionId() ?? NO_SESSION;
  const last = lastShown.get(key) ?? [];
  const thisTurn = thisTurnOf(req, x);
  const ctx: RecipeCtx = { s, x, scene, recent: new Set(recentSeeds) };
  const order = guide.order ?? recipe.order;
  const prompt = buildPrompt({ guide, s, x, thisTurn, lastShown: last.map(c => c.text) });
  const run = await runModel(llm, x, { ...prompt, scene });
  const model = run.raw ? resolveIntents(run.raw, { s, allowed: guide.intents, replyMode: replyModeOf(order) }) : [];
  const pool = [...model, ...present(recipe.rules(ctx)), ...present(recipe.fallback(ctx))];
  const lint: LintCtx = {
    scene, cardKind: s.openCard?.kind ?? null, recent: ctx.recent, lastShown: last,
    entities: entitiesOf(s, [x.lastUser, x.lastAssistant, ...x.turns.map(t => t.text)]),
    anchors: guide.anchor === 'strict' ? anchorsOf(s, [thisTurn.user, thisTurn.assistant, ...thisTurn.cards]) : undefined,
    buttons: starterVisible(scene, x) ? STARTER_BUTTONS : undefined,
    lastUser: x.lastUser,
  };
  const kept = refill({ kept: keptOf(lintChips(pool, lint)), guide, scene, ctx, lint, replyMode: replyModeOf(order) });
  const chosen = pickBar(kept, x, scene, low, order);
  const degraded = chosen.filter(c => model.includes(c)).length < MIN_MODEL_CHIPS;
  if (run.asked) console.log(`[career-suggest] model ms=${run.ms} chips=${run.raw?.length ?? 0} degraded=${degraded} scene=${scene}`);
  if (opts.isStale?.()) console.log(`[career-suggest] stale result not remembered scene=${scene}`);
  else rememberShown(key, chosen);
  return { chips: chosen, scene, degraded };
}

/** 路由旧名：只要格子。 */
export async function buildSuggestions(s: SuggestState, req: SuggestRequest, llm: LLM | null): Promise<SuggestChip[]> {
  return (await suggestFor(s, req, llm)).chips;
}

/** 测试用：清掉最近出过的功能起头与上一轮四格。 */
export function resetSuggestMemory(): void {
  recentSeeds.length = 0;
  lastShown.clear();
}
