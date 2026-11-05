/**
 * 29 幕的配方表（plan-r3-suggest §2）：前半程在 suggest-recipes-talk.ts，后半程在 suggest-recipes-flow.ts。
 * 缺了哪一幕就退到兜底 S29（并留日志），保证每一幕都有配方。
 */
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
