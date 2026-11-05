/**
 * 下一步条 r4（plan-r4-suggest §3.2 / §4）：每一幕给模型的"思路 + 示例 + 允许意图"。
 * 模型写文字和意图（intent + 自然语言 target），服务端把意图换成带真 id 的 SuggestAction。
 */
import type { SuggestMode } from '../../shared/careerSuggest';

/** 模型可用的意图白名单（say / fill 无动作，其余对应 SuggestAction.type）。 */
export const SUGGEST_INTENTS = [
  'say',
  'fill',
  'start_card',
  'propose_batch',
  'dismiss_card',
  'open_deck',
  'ask_primary',
  'ask_choose',
  'open',
  'start_feature',
] as const;

export type SuggestIntent = typeof SUGGEST_INTENTS[number];

export function isSuggestIntent(v: unknown): v is SuggestIntent {
  return SUGGEST_INTENTS.some(i => i === v);
}

/**
 * L11（本轮锚定）开不开：strict = 模型格必须点到这一轮或状态里的真东西；
 * loose = 这一幕要模型替他说出处境 / 感受（"做过家教，算吗""我更想稳定一点"），新词本来就不在这一轮里，跳过 L11（L4 等照查）。
 */
export type SceneAnchor = 'strict' | 'loose';

export interface SceneGuide {
  /** 给模型的思路（≤300 字）。 */
  text: string;
  /** 这一幕允许的意图；越界的按 say 处理。 */
  intents: readonly SuggestIntent[];
  /** L11 开不开（见 SceneAnchor）。 */
  anchor: SceneAnchor;
  /** 2–3 组示例，每组 4 条 'text|intent|target'（target 可省）；名字是占位，模型须换成真名字。 */
  examples: ReadonlyArray<ReadonlyArray<string>>;
  /** 排序；缺省沿用兜底配方的 order。 */
  order?: readonly SuggestMode[];
}
