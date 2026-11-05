/**
 * 下一步条（输入框上方一行三条，2026-11-05 你定：配合 / 犹豫 / 纠正各一条）：前后端共用的形状。
 *
 * stance（立场）是这一条在这一行里的位置：配合（顺着小芽往下走）· 犹豫（拿不准、想缓缓）· 纠正（小芽说偏了）。
 * 下面 mode / slot 是更早的分类，留作图标、埋点和 lint 用。
 *
 * r3：服务端先判"他在哪一幕"（scene），再按这一幕的配方出四格；每格带 mode（主要怎么帮他）：
 *  answer 候选回答 · option 推导选项 · advance 直接办 · start 功能起头 · exit 退出口。
 * slot 保留为来源标记（兼容埋点与样式），老含义：
 *  - act：接话——替他回小芽刚说的（模型出，≤2）；
 *  - next：下一步——永远有、永远具体、能直接做（规则出）；
 *  - shape：塑形——收偏好、收数据、教功能、给底气（规则出候选，模型挑一条）；
 *  - exit：退出口——有后台在跑或有东西等他时才出。
 *
 * 三种触发：say 发原话；fill 填进输入框；do 前端直接执行 action，不进对话、不叫模型。
 */
import { type FeatureId, isFeatureId } from './careerFeatures';

export type SuggestSlot = 'act' | 'next' | 'shape' | 'exit';
export type SuggestKind = 'say' | 'fill' | 'do';
export type SuggestSurface = 'live' | 'dossier' | 'jobs' | 'resume';
export type SuggestMode = 'answer' | 'option' | 'advance' | 'start' | 'exit';
export type SuggestStance = 'agree' | 'hesitate' | 'correct';

/** 一行里立场的固定顺序（左→右）。 */
export const SUGGEST_STANCES: readonly SuggestStance[] = ['agree', 'hesitate', 'correct'];

/** 功能起头带进去的对象（公司名拼进预填句；岗位 / 申请 id 备用）。 */
export interface SuggestFeatureArgs { company?: string; job_id?: string; application_id?: string }

/** do 类要执行的动作（服务端给、前端白名单执行；不认识的退回 say）。 */
export type SuggestAction =
  | { type: 'propose_batch'; job_ids?: string[] }
  | { type: 'start_card'; card_id: string; job_ids: string[] }
  | { type: 'dismiss_card'; card_id: string }
  | { type: 'open_deck'; ask_id?: string }
  | { type: 'ask_primary'; ask_id: string }
  /** 网页弹窗的选择题：直接替他选这一项（与卡组里选同一个接口），后台接着填。 */
  | { type: 'ask_choose'; ask_id: string; choice: string }
  | { type: 'open'; surface: SuggestSurface; id?: string }
  /** 功能起头：前端按 careerFeatures.ts 的 FEATURES[feature_id].start 打开页面 / 预填 / 出勾选表。 */
  | { type: 'start_feature'; feature_id: FeatureId; args?: SuggestFeatureArgs };

export type SuggestActionType = SuggestAction['type'];

export interface SuggestChip {
  text: string;
  slot: SuggestSlot;
  kind: SuggestKind;
  /** 这一格主要怎么帮他（图标 / 埋点用）；旧数据没有时按 slot 推（modeOfSlot）。 */
  mode: SuggestMode;
  /** 立场；旧数据没有时按 mode 推（stanceOf）。 */
  stance?: SuggestStance;
  /** kind 为 do 时必有。 */
  action?: SuggestAction;
  /** 塑形候选的稳定 id（埋点与冷却用）；其余为 null。 */
  seed_id: string | null;
}

export interface SuggestRequest {
  /** 他最后说的一句（截断后）。 */
  last_user?: string | null;
  /** 小芽最后说的一段（截断后）。 */
  last_assistant?: string | null;
  /** 旧字段：前端看到的待定卡片种类。服务端现在自己查卡片，留着只为兼容。 */
  pending_cards?: string[];
  /** 最近几轮可见文字（≤ SUGGEST_MAX_TURNS 条，旧→新；每条服务端再截 SUGGEST_TURN_CHARS 字）。 */
  turns?: SuggestTurn[];
  /** 上一条小芽消息里用过的工具名（去掉 mcp__xx__ 前缀，只留 [a-z_]）。 */
  last_tools?: string[];
  /** 离他上一次说话过了几小时（前端从消息时间戳算）；没说过为 null。 */
  away_hours?: number | null;
  /** 这一轮：他说的、小芽说的、小芽用的工具（去前缀）、这一轮放的卡种类（plan-r4 §2.3）。 */
  this_turn?: SuggestThisTurn;
  /** 谁发起的：轮末钩子（服务端自己算）还是前端兜底请求。 */
  source?: SuggestSource;
}

export interface SuggestThisTurn { user: string; assistant: string; tools: string[]; cards: string[] }

export type SuggestSource = 'hook' | 'poll';

export interface SuggestTurn { role: 'user' | 'assistant'; text: string }

/** scene 是服务端判出的幕（S1–S29 的 id，见 server/career/suggest-scene.ts），埋点用。 */
export interface SuggestResponse { chips: SuggestChip[]; scene: string | null }

/** 轮末钩子经本会话 SSE 推的事件名（plan-r4 §2.3；sse.ts 与 SseConnection.ts 白名单都要登记）。 */
export const CAREER_SUGGEST_EVENT = 'career:suggest';

/**
 * career:suggest 的载荷：小芽这一轮说完时服务端算好的三条。
 * assistant_message_id 与前端消息 id 相同；前端只在它等于当前 turnKey 时显示（早到就先存着）。
 */
export interface SuggestPush {
  sessionId: string;
  turn_id: string | null;
  assistant_message_id: string | null;
  chips: SuggestChip[];
  scene: string;
  source: 'hook';
  /** 模型没回来 / 超时，走的是兜底配方。 */
  degraded: boolean;
  ts: number;
}

/** 请求里最多带几轮对话。 */
export const SUGGEST_MAX_TURNS = 6;
/** 每轮对话最多带几个字（最后一轮服务端也按这个截）。 */
export const SUGGEST_TURN_CHARS = 600;
/** 最多带几个工具名。 */
export const SUGGEST_MAX_TOOLS = 12;

/** 一条建议最多几个字：装得下"先投招商银行和平安"这种带名字的话，一行放得下（§B.5）。 */
export const SUGGEST_MAX_CHARS = 22;
/** 每轮几条：配合 / 犹豫 / 纠正各一条。 */
export const SUGGEST_MAX_CHIPS = SUGGEST_STANCES.length;

/** 等模型写三条多久（服务端生成器）。下面两个时限都从它推出来，只改这一处。 */
export const SUGGEST_MODEL_TIMEOUT_MS = 3_000;
/** 轮末钩子总预算：模型 + 状态快照与发布的余量。 */
export const SUGGEST_HOOK_BUDGET_MS = SUGGEST_MODEL_TIMEOUT_MS + 500;
/** 前端等钩子推送多久再自己拉（比钩子预算多一点在路上的时间）。 */
export const SUGGEST_HOOK_GRACE_MS = SUGGEST_HOOK_BUDGET_MS + 300;

const SLOTS: readonly SuggestSlot[] = ['act', 'next', 'shape', 'exit'];
const KINDS: readonly SuggestKind[] = ['say', 'fill', 'do'];
const SURFACES: readonly SuggestSurface[] = ['live', 'dossier', 'jobs', 'resume'];
const MODES: readonly SuggestMode[] = ['answer', 'option', 'advance', 'start', 'exit'];
const SLOT_MODE: Readonly<Record<SuggestSlot, SuggestMode>> = { act: 'answer', next: 'advance', shape: 'option', exit: 'exit' };

/** 没标立场的格（兜底配方、旧数据）：退出口算犹豫，其余算配合。 */
export function stanceOf(chip: Pick<SuggestChip, 'mode' | 'stance'>): SuggestStance {
  return chip.stance ?? (chip.mode === 'exit' ? 'hesitate' : 'agree');
}

/** 旧数据没有 mode 时按槽位推。 */
export function modeOfSlot(slot: SuggestSlot): SuggestMode {
  return SLOT_MODE[slot];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isSlot = (v: unknown): v is SuggestSlot => SLOTS.some(s => s === v);
const isKind = (v: unknown): v is SuggestKind => KINDS.some(k => k === v);
const isSurface = (v: unknown): v is SuggestSurface => SURFACES.some(s => s === v);
const isMode = (v: unknown): v is SuggestMode => MODES.some(m => m === v);
const isStance = (v: unknown): v is SuggestStance => SUGGEST_STANCES.some(m => m === v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(nonEmpty) ? v.filter(nonEmpty) : null;

/** action 白名单校验：形状不对的返回 null。 */
export function parseSuggestAction(raw: unknown): SuggestAction | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'propose_batch': {
      if (raw.job_ids === undefined) return { type: 'propose_batch' };
      const ids = stringList(raw.job_ids);
      return ids ? { type: 'propose_batch', job_ids: ids } : null;
    }
    case 'start_card': {
      const ids = stringList(raw.job_ids);
      return nonEmpty(raw.card_id) && ids ? { type: 'start_card', card_id: raw.card_id, job_ids: ids } : null;
    }
    case 'dismiss_card':
      return nonEmpty(raw.card_id) ? { type: 'dismiss_card', card_id: raw.card_id } : null;
    case 'open_deck':
      return nonEmpty(raw.ask_id) ? { type: 'open_deck', ask_id: raw.ask_id } : { type: 'open_deck' };
    case 'ask_primary':
      return nonEmpty(raw.ask_id) ? { type: 'ask_primary', ask_id: raw.ask_id } : null;
    case 'ask_choose':
      return nonEmpty(raw.ask_id) && nonEmpty(raw.choice) ? { type: 'ask_choose', ask_id: raw.ask_id, choice: raw.choice } : null;
    case 'open':
      if (!isSurface(raw.surface)) return null;
      return nonEmpty(raw.id) ? { type: 'open', surface: raw.surface, id: raw.id } : { type: 'open', surface: raw.surface };
    case 'start_feature':
      return isFeatureId(raw.feature_id) ? withArgs(raw.feature_id, raw.args) : null;
    default:
      return null;
  }
}

function withArgs(feature_id: FeatureId, raw: unknown): SuggestAction {
  if (!isRecord(raw)) return { type: 'start_feature', feature_id };
  const args: SuggestFeatureArgs = {};
  if (nonEmpty(raw.company)) args.company = raw.company;
  if (nonEmpty(raw.job_id)) args.job_id = raw.job_id;
  if (nonEmpty(raw.application_id)) args.application_id = raw.application_id;
  return Object.keys(args).length ? { type: 'start_feature', feature_id, args } : { type: 'start_feature', feature_id };
}

/** 一格的校验：action 不认识就丢掉 action、kind 退回 say。 */
export function parseSuggestChip(item: unknown): SuggestChip | null {
  if (!isRecord(item)) return null;
  const { text, slot, kind, seed_id } = item;
  if (typeof text !== 'string' || !text.trim() || text.length > SUGGEST_MAX_CHARS || !isSlot(slot)) return null;
  const seed = typeof seed_id === 'string' ? seed_id : null;
  const mode = isMode(item.mode) ? item.mode : modeOfSlot(slot);
  const stance = isStance(item.stance) ? { stance: item.stance } : {};
  const action = parseSuggestAction(item.action);
  if (action) return { text, slot, kind: 'do', mode, ...stance, action, seed_id: seed };
  const plain: SuggestKind = isKind(kind) && kind !== 'do' ? kind : 'say';
  return { text, slot, kind: plain, mode, ...stance, seed_id: seed };
}

/** 跨边界校验：接口返回的 scene（不是字符串就当没有）。 */
export function parseSuggestScene(raw: unknown): string | null {
  return isRecord(raw) && nonEmpty(raw.scene) ? raw.scene : null;
}

/** 跨边界校验：接口返回的 `{ chips }` 里只留形状对的、不超长的。 */
export function parseSuggest(raw: unknown): SuggestChip[] {
  const list = isRecord(raw) && Array.isArray(raw.chips) ? raw.chips : [];
  const chips: SuggestChip[] = [];
  for (const item of list) {
    const chip = parseSuggestChip(item);
    if (chip) chips.push(chip);
  }
  return chips.slice(0, SUGGEST_MAX_CHIPS);
}

const idOrNull = (v: unknown): string | null => (nonEmpty(v) ? v : null);

/** 跨边界校验：career:suggest 载荷。缺 sessionId / scene 返回 null；chips 只留形状对的。 */
export function parseSuggestPush(raw: unknown): SuggestPush | null {
  if (!isRecord(raw) || !nonEmpty(raw.sessionId) || !nonEmpty(raw.scene)) return null;
  return {
    sessionId: raw.sessionId,
    turn_id: idOrNull(raw.turn_id),
    assistant_message_id: idOrNull(raw.assistant_message_id),
    chips: parseSuggest(raw),
    scene: raw.scene,
    source: 'hook',
    degraded: raw.degraded === true,
    ts: typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now(),
  };
}
