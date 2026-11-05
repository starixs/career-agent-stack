/**
 * 下一步条（输入框上方每轮最多四格，plan-r2 §B 2026-11-05）：前后端共用的形状。
 *
 * 四个槽，顺序固定：
 *  - act：接话——替他回小芽刚说的（模型出，≤2）；
 *  - next：下一步——永远有、永远具体、能直接做（规则出）；
 *  - shape：塑形——收偏好、收数据、教功能、给底气（规则出候选，模型挑一条）；
 *  - exit：退出口——有后台在跑或有东西等他时才出。
 *
 * 三种触发：say 发原话；fill 填进输入框；do 前端直接执行 action，不进对话、不叫模型。
 */
export type SuggestSlot = 'act' | 'next' | 'shape' | 'exit';
export type SuggestKind = 'say' | 'fill' | 'do';
export type SuggestSurface = 'live' | 'dossier' | 'jobs' | 'resume';

/** do 类要执行的动作（服务端给、前端白名单执行；不认识的退回 say）。 */
export type SuggestAction =
  | { type: 'propose_batch'; job_ids?: string[] }
  | { type: 'start_card'; card_id: string; job_ids: string[] }
  | { type: 'dismiss_card'; card_id: string }
  | { type: 'open_deck'; ask_id?: string }
  | { type: 'ask_primary'; ask_id: string }
  | { type: 'open'; surface: SuggestSurface; id?: string };

export type SuggestActionType = SuggestAction['type'];

export interface SuggestChip {
  text: string;
  slot: SuggestSlot;
  kind: SuggestKind;
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
}

export interface SuggestResponse { chips: SuggestChip[] }

/** 一条建议最多几个字：装得下"先投招商银行和平安"这种带名字的话，一行放得下（§B.5）。 */
export const SUGGEST_MAX_CHARS = 22;
/** 每轮最多几条。 */
export const SUGGEST_MAX_CHIPS = 4;

const SLOTS: readonly SuggestSlot[] = ['act', 'next', 'shape', 'exit'];
const KINDS: readonly SuggestKind[] = ['say', 'fill', 'do'];
const SURFACES: readonly SuggestSurface[] = ['live', 'dossier', 'jobs', 'resume'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isSlot = (v: unknown): v is SuggestSlot => SLOTS.some(s => s === v);
const isKind = (v: unknown): v is SuggestKind => KINDS.some(k => k === v);
const isSurface = (v: unknown): v is SuggestSurface => SURFACES.some(s => s === v);
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
    case 'open':
      if (!isSurface(raw.surface)) return null;
      return nonEmpty(raw.id) ? { type: 'open', surface: raw.surface, id: raw.id } : { type: 'open', surface: raw.surface };
    default:
      return null;
  }
}

/** 一格的校验：action 不认识就丢掉 action、kind 退回 say。 */
export function parseSuggestChip(item: unknown): SuggestChip | null {
  if (!isRecord(item)) return null;
  const { text, slot, kind, seed_id } = item;
  if (typeof text !== 'string' || !text.trim() || text.length > SUGGEST_MAX_CHARS || !isSlot(slot)) return null;
  const seed = typeof seed_id === 'string' ? seed_id : null;
  const action = parseSuggestAction(item.action);
  if (action) return { text, slot, kind: 'do', action, seed_id: seed };
  const plain: SuggestKind = isKind(kind) && kind !== 'do' ? kind : 'say';
  return { text, slot, kind: plain, seed_id: seed };
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
