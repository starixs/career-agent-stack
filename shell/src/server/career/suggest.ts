/**
 * 下一步条：每轮小芽说完，拼出输入框上方一行三条——配合 / 犹豫 / 纠正各一条（2026-11-05 你定）。
 *
 * 先判"他在哪一幕"（suggest-scene.ts，规则）→ 取这一幕的思路 + 示例 + 允许意图（guideFor）
 * → 叫一次模型按三种立场各写两条备选 {text, intent, target}（喂画像、状态、最近对话摘要、最后一条回复，≤3s）
 * → 意图换成带真 id 的动作，换不出的丢（suggest-intents.ts）→ 旧配方的规则格与兜底格排在后面
 * → 质量线（suggest-lint.ts）→ 每种立场一个位置先到先得，空着的依次用示例、通用兜底、最近出过的固定入口、立场兜底补
 * → 勾选表在等时配合位给卡的主动作 → 低谷时犹豫位换成"看我这个月的数"。
 * 模型超时 / 出错 / 留下不到 2 条：degraded = true。整条一次出，不先出后补。
 */
import { extractJson, type LLM } from '@career/core';

import {
  SUGGEST_MODEL_TIMEOUT_MS, type SuggestChip, type SuggestMode, type SuggestRequest, type SuggestThisTurn,
} from '../../shared/careerSuggest';
import { FEATURE_SEED_PREFIX } from './suggest-chip';
import { SUGGEST_INTENTS, type SceneGuide, type SuggestIntent } from './suggest-guide-types';
import { ModelOut, resolveIntents, type ModelChip } from './suggest-intents';
import { anchorsOf, entitiesOf, lintChips, STARTER_BUTTONS, type LintCtx, type LintResult } from './suggest-lint';
import { buildPrompt } from './suggest-prompt';
import { guideFor, LOW_CHIP, recipeFor, type Recipe, type RecipeCtx } from './suggest-recipes';
import { classifyScene, inputOf, SCENE_NAMES, starterVisible, type SceneId, type SceneResult, type SuggestInput } from './suggest-scene';
import { careerProductSessionId } from './product-session';
import { guessStance, missingStances, rowOf, STANCE_FALLBACK, stanceAt, takeByStance, type StanceSlots } from './suggest-stance';
import type { SuggestState } from './suggest-types';

/** 等模型多久：唯一来源在 shared（钩子预算、前端等待都由它推出）。 */
export const SUGGEST_LLM_TIMEOUT_MS = SUGGEST_MODEL_TIMEOUT_MS;
/** 一个功能起头出过以后，隔多少轮再出（L9）。 */
export const SEED_COOLDOWN = 10;
/** 模型输出上限：{"配合":[["文字","intent","target"],…],…} 三种立场各两条 ≈ 90–130 token，留余量。 */
const MODEL_MAX_TOKENS = 220;
const MODEL_TEMPERATURE = 0.5;
/** 模型格留下不到这么多就算走了兜底（degraded）。 */
const MIN_MODEL_CHIPS = 2;
/** 条上至少几格：不够时把 L12（和上一轮重样）丢掉的放回来，宁可重样也不空。 */
const MIN_BAR_CHIPS = 2;
/** 叠加低谷时不动的幕：底下有卡在等，条只管卡。 */
const CARD_SCENES: readonly SceneId[] = ['S13', 'S11', 'S7'];
/** 没有会话 id 时 lastShown 记在这个键下。 */
const NO_SESSION = '_';

const recentSeeds: string[] = [];
/** 每个会话上一轮出过的三条（进程内；重启后第一轮可能重样，plan-r4 §8-5 已接受）。 */
const lastShown = new Map<string, SuggestChip[]>();

const present = (list: ReadonlyArray<SuggestChip | null>): SuggestChip[] => list.filter((c): c is SuggestChip => c !== null);
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
    text: recipe.prompt ?? `${SCENE_NAMES[scene]}：按这一轮和状态，配合、犹豫、纠正各写最顺手的一条。`,
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

/** 只因和上一轮重样（L12）被丢的格。 */
const repeatsOf = (res: LintResult): SuggestChip[] => res.dropped.filter(d => d.rule === 'L12').map(d => d.chip);
/** 只因最近出过被丢的：和上一轮重样（L12）或功能起头还在冷却（L9）。 */
const RECENT_RULES: ReadonlySet<string> = new Set(['L12', 'L9']);
/** 补不满时能放回的：只放配方里的固定入口（有 seed），模型写的具体话不重样。 */
const stableRepeatsOf = (res: LintResult): SuggestChip[] =>
  res.dropped.filter(d => RECENT_RULES.has(d.rule) && d.chip.seed_id !== null).map(d => d.chip);

/** 过线后留下的；不够两格时把只因和上一轮重样被丢的放回来。 */
function keptOf(res: LintResult): SuggestChip[] {
  if (res.kept.length >= MIN_BAR_CHIPS) return res.kept;
  return [...res.kept, ...repeatsOf(res)];
}

/** 低谷叠加：犹豫位（不是直接办事的）换成"看我这个月的数"；底下有卡在等的幕不动。 */
function overlayLow(slots: StanceSlots, scene: SceneId, low: boolean): void {
  if (!low || CARD_SCENES.includes(scene) || rowOf(slots).some(c => c.text === LOW_CHIP.text)) return;
  if (slots.hesitate?.kind === 'do') return;
  slots.hesitate = { ...LOW_CHIP, stance: 'hesitate' };
}

export interface SuggestResult {
  chips: SuggestChip[];
  scene: SceneId;
  /** 模型没回来 / 留下不到 2 条：这一行主要是兜底。 */
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

/** 这一幕思路里的示例行 'text|intent|target' → 模型格（只留说 / 填空；每组第 i 行是第 i 种立场）。 */
function exampleChips(guide: SceneGuide): ModelChip[] {
  return guide.examples.flatMap(group => group.flatMap((row, i) => {
    const [text = '', intent = 'say'] = row.split('|').map(p => p.trim());
    const known = REFILL_EXAMPLE_INTENTS.find(k => k === intent);
    const stance = stanceAt(i);
    return text && known && stance ? [{ text, intent: known, target: null, stance }] : [];
  }));
}

interface FillAsk {
  first: LintResult; guide: SceneGuide; scene: SceneId; ctx: RecipeCtx; lint: LintCtx; replyMode: SuggestMode; low: boolean;
}

/** 补位的通用兜底：一般幕拿 S29 的；S29 自己再拿 S29 等于重复，改拿 S26 按阶段的起头（真机 r2：S29 只剩两格）。 */
const REFILL_FALLBACK_OF = (scene: SceneId): SceneId => (scene === 'S29' ? 'S26' : 'S29');

/** 勾选表在等：卡的主动作排最前，配合位先给它。 */
function cardFirst(kept: readonly SuggestChip[], scene: SceneId): SuggestChip[] {
  if (scene !== 'S13') return [...kept];
  return [...kept.filter(isCardMain), ...kept.filter(c => !isCardMain(c))];
}

/**
 * 配合 / 犹豫 / 纠正各一个位置：先放过了线的模型格和配方格；空着的依次用这一幕示例、通用兜底，
 * 再放回最近出过的固定入口和立场兜底（这两步不查重样与冷却），都要过线、不和已有的重复。
 */
function fillRow({ first, guide, scene, ctx, lint, replyMode, low }: FillAsk): SuggestChip[] {
  const slots: StanceSlots = {};
  takeByStance(slots, cardFirst(keptOf(first), scene));
  const before = rowOf(slots).length;
  if (missingStances(slots).length) {
    const examples = resolveIntents(exampleChips(guide), { s: ctx.s, allowed: REFILL_EXAMPLE_INTENTS, replyMode });
    const from = REFILL_FALLBACK_OF(scene);
    const fresh = lintChips([...examples, ...present(recipeFor(from).fallback({ ...ctx, scene: from })).map(guessStance)], lint, rowOf(slots));
    takeByStance(slots, fresh.kept);
    const relaxed: LintCtx = { ...lint, lastShown: undefined, recent: new Set() };
    const lastResort = [...stableRepeatsOf(first), ...stableRepeatsOf(fresh), ...missingStances(slots).map(st => STANCE_FALLBACK[st])];
    takeByStance(slots, lintChips(lastResort, relaxed, rowOf(slots)).kept);
  }
  const after = rowOf(slots).length;
  if (after > before) console.log(`[career-suggest] refill +${after - before} scene=${scene}`);
  overlayLow(slots, scene, low);
  return rowOf(slots);
}

/** 一整条：判幕 → 模型按立场写 → 意图解析 → lint → 按立场填三个位置 → 低谷叠加。 */
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
  const order = recipe.order;
  const prompt = buildPrompt({ guide, s, x, thisTurn, lastShown: last.map(c => c.text), sceneName: SCENE_NAMES[scene] });
  const run = await runModel(llm, x, { ...prompt, scene });
  const model = run.raw ? resolveIntents(run.raw, { s, allowed: guide.intents, replyMode: replyModeOf(order) }) : [];
  const pool = [...model, ...[...present(recipe.rules(ctx)), ...present(recipe.fallback(ctx))].map(guessStance)];
  const lint: LintCtx = {
    scene, cardKind: s.openCard?.kind ?? null, recent: ctx.recent, lastShown: last,
    entities: entitiesOf(s, [x.lastUser, x.lastAssistant, ...x.turns.map(t => t.text)]),
    anchors: guide.anchor === 'strict' ? anchorsOf(s, [thisTurn.user, thisTurn.assistant, ...thisTurn.cards]) : undefined,
    buttons: starterVisible(scene, x) ? STARTER_BUTTONS : undefined,
    lastUser: x.lastUser,
  };
  const first = lintChips(pool, lint);
  const chosen = fillRow({ first, guide, scene, ctx, lint, replyMode: replyModeOf(order), low });
  const degraded = chosen.filter(c => model.some(m => m.text === c.text)).length < MIN_MODEL_CHIPS;
  if (run.asked) console.log(`[career-suggest] model ms=${run.ms} chips=${run.raw?.length ?? 0} degraded=${degraded} scene=${scene}`);
  if (opts.isStale?.()) console.log(`[career-suggest] stale result not remembered scene=${scene}`);
  else rememberShown(key, chosen);
  return { chips: chosen, scene, degraded };
}

/** 路由旧名：只要格子。 */
export async function buildSuggestions(s: SuggestState, req: SuggestRequest, llm: LLM | null): Promise<SuggestChip[]> {
  return (await suggestFor(s, req, llm)).chips;
}

/** 测试用：清掉最近出过的功能起头与上一轮出过的。 */
export function resetSuggestMemory(): void {
  recentSeeds.length = 0;
  lastShown.clear();
}
