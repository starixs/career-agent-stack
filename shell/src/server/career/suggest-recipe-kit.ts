/**
 * 配方的公共形状与小积木（plan-r3-suggest §4.2）：每一幕一个配方——
 * rules 出规则格（do / 功能起头 / 固定说法），fallback 是模型没回来或被 lint 丢光时的兜底（≥2 格），
 * order 是这一幕四格的排法（按 mode）。
 * r4（plan-r4-suggest §3.1）：每一幕都叫模型写全部四格；rules + fallback 整体退成兜底。
 * 给模型的"思路 + 示例 + 允许意图"在 guide（缺省由 suggest-recipes.ts 的 guideFor 从 GUIDES 表取）；
 * prompt 是 r3 的旧幕段，guide 没写时当思路用。
 */
import type { SuggestChip, SuggestMode } from '../../shared/careerSuggest';
import { sayChip } from './suggest-chip';
import type { SceneGuide } from './suggest-guide-types';
import type { SceneId, SuggestInput } from './suggest-scene';
import { fitText, shortCompany } from './suggest-text';
import type { SuggestState } from './suggest-types';

export interface RecipeCtx {
  s: SuggestState;
  x: SuggestInput;
  scene: SceneId;
  /** 冷却中的 seed（功能起头）。 */
  recent: ReadonlySet<string>;
}

export interface Recipe {
  rules(c: RecipeCtx): Array<SuggestChip | null>;
  /** r3 旧幕段：guide 没写时当给模型的思路。 */
  prompt?: string | null;
  /** r4 给模型的思路 + 示例 + 允许意图；缺省从 GUIDES 表取。 */
  guide?: SceneGuide;
  fallback(c: RecipeCtx): Array<SuggestChip | null>;
  order: readonly SuggestMode[];
}

/** 一般排法：回应 → 推进 → 起头 → 退出。 */
export const ORDER_TALK: readonly SuggestMode[] = ['answer', 'option', 'advance', 'start', 'exit'];
/** 办事幕：能直接办的在前。 */
export const ORDER_DO: readonly SuggestMode[] = ['advance', 'answer', 'option', 'start', 'exit'];
/** 起头幕（笔试 / 面试准备）：功能在前。 */
export const ORDER_START: readonly SuggestMode[] = ['start', 'answer', 'option', 'advance', 'exit'];

/** 放得下就用第一种写法，否则用第二种（第二种必须放得下）。 */
export function fit(text: string, plain: string): string {
  return fitText(text, plain) ?? plain;
}

/** 状态里出现过的公司（全名），按"等他 > 截止 > 在填 > 下一批"排。 */
function knownCompanies(s: SuggestState): string[] {
  return [
    ...s.asks.flatMap(a => a.companies), ...s.dueSoon.map(d => d.company), ...(s.batch?.running ?? []),
    ...s.held.companies, ...s.nextJobs.map(j => j.company), ...(s.lastTailor ? [s.lastTailor.company] : []),
  ].filter(Boolean);
}

/** 在一段话里找状态里认识的公司，返回短名；找不到 null。 */
export function companyIn(text: string, s: SuggestState): string | null {
  for (const name of knownCompanies(s)) {
    const short = shortCompany(name).replace(/…$/, '');
    if (short && text.includes(short)) return shortCompany(name);
  }
  return null;
}

/** 有后台事时退出口带"后面怎么接"；没有就用给定的一句。 */
export function exitSay(text: string, seed: string): SuggestChip {
  return sayChip(text, 'exit', seed);
}

/** 他说过城市就"只看这两城"，没说就填空收城市。 */
export function cityText(s: SuggestState): string | null {
  const cities = s.prefs.cities.map(shortCompany).slice(0, 2).join('、');
  return cities ? fitText(`只看${cities}`) : null;
}
