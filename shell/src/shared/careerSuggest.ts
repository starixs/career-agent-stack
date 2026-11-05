/**
 * 建议条（输入框上方每轮四个小框，face-beta-polish 2026-11-05 你定）：前后端共用的形状。
 *
 * 四个槽各有用意：
 *  - reply：替他回答小芽刚问的，省思考；
 *  - mainline：主线下一步，保证总有一条把他往下一步带；
 *  - seed：培养心智——收偏好、收数据、教功能、给底气，埋进产品后面要用的东西。
 */
export type SuggestSlot = 'reply' | 'mainline' | 'seed';

export interface SuggestChip {
  text: string;
  slot: SuggestSlot;
  /** 种子的稳定 id（埋点与去重用）；reply / mainline 为 null。 */
  seed_id: string | null;
}

export interface SuggestRequest {
  /** 他最后说的一句（截断后）。 */
  last_user?: string | null;
  /** 小芽最后说的一段（截断后）。 */
  last_assistant?: string | null;
  /** 对话底部还在等他决定的卡片种类（有的话不出主线那一条，免得和卡上的按钮重复）。 */
  pending_cards?: string[];
}

export interface SuggestResponse { chips: SuggestChip[] }

/** 一条建议最多几个字：一眼读完，一行放得下。 */
export const SUGGEST_MAX_CHARS = 16;
/** 每轮最多几条。 */
export const SUGGEST_MAX_CHIPS = 4;

const SLOTS: readonly SuggestSlot[] = ['reply', 'mainline', 'seed'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isSlot = (v: unknown): v is SuggestSlot => SLOTS.some(s => s === v);

/** 跨边界校验：接口返回的 `{ chips }` 里只留形状对的、不超长的。 */
export function parseSuggest(raw: unknown): SuggestChip[] {
  const list = isRecord(raw) && Array.isArray(raw.chips) ? raw.chips : [];
  const chips: SuggestChip[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const { text, slot, seed_id } = item;
    if (typeof text !== 'string' || !text.trim() || text.length > SUGGEST_MAX_CHARS || !isSlot(slot)) continue;
    chips.push({ text, slot, seed_id: typeof seed_id === 'string' ? seed_id : null });
  }
  return chips.slice(0, SUGGEST_MAX_CHIPS);
}
