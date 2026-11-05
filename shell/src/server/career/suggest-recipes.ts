/**
 * 29 幕的配方表（plan-r3-suggest §2）：前半程在 suggest-recipes-talk.ts，后半程在 suggest-recipes-flow.ts。
 * 缺了哪一幕就退到兜底 S29（并留日志），保证每一幕都有配方。
 * r4：配方整体是兜底；给模型的"思路 + 示例 + 允许意图"由 guideFor 从 GUIDES 表取（plan-r4 §4）。
 */
import { GUIDES_FLOW } from './suggest-guide-flow';
import { GUIDES_TALK } from './suggest-guide-talk';
import type { SceneGuide } from './suggest-guide-types';
import type { Recipe } from './suggest-recipe-kit';
import { FLOW_RECIPES } from './suggest-recipes-flow';
import { TALK_RECIPES } from './suggest-recipes-talk';
import { SCENES, type SceneId } from './suggest-scene';

export type { Recipe, RecipeCtx } from './suggest-recipe-kit';
export { LOW_CHIP } from './suggest-recipes-flow';

const ALL: Readonly<Partial<Record<SceneId, Recipe>>> = { ...TALK_RECIPES, ...FLOW_RECIPES };

export function recipeFor(scene: SceneId): Recipe {
  const recipe = ALL[scene] ?? ALL.S29;
  if (!recipe) throw new Error('[career-suggest] fallback recipe S29 missing');
  if (!ALL[scene]) console.warn(`[career-suggest] no recipe for ${scene}, using S29`);
  return recipe;
}

/** 单测用：没有配方的幕（应为空）。 */
export const MISSING_RECIPES: readonly SceneId[] = SCENES.filter(id => !ALL[id]);

/** 29 幕思路表（GC：suggest-guide-talk.ts / suggest-guide-flow.ts）。 */
const GUIDES: Readonly<Partial<Record<SceneId, SceneGuide>>> = { ...GUIDES_TALK, ...GUIDES_FLOW };

/** 这一幕给模型的思路：配方自带的优先，其次 GUIDES 表；都没有返回 null（suggest.ts 用旧 prompt 或幕名顶上）。 */
export function guideFor(scene: SceneId): SceneGuide | null {
  return ALL[scene]?.guide ?? GUIDES[scene] ?? null;
}
