/**
 * 下一步条的格子构造（plan-r3-suggest §4.2）：配方与积木都用这几个函数造格，mode 与来源 slot 一处对应。
 * seed_id 非 null 的是"配方白名单模板"（规则写的，自带对象）；模型写的格 seed_id 为 null，要过 L4"有对象"。
 */
import { featureChipText, type FeatureId } from '../../shared/careerFeatures';
import type { SuggestAction, SuggestChip, SuggestMode, SuggestSlot } from '../../shared/careerSuggest';

/** mode → 来源槽位（slot 只留作埋点与样式兼容：exit 无边框）。 */
const MODE_SLOT: Readonly<Record<SuggestMode, SuggestSlot>> = { answer: 'act', option: 'shape', advance: 'next', start: 'shape', exit: 'exit' };
/** 功能起头格的 seed 前缀：冷却按它算（L9）。 */
export const FEATURE_SEED_PREFIX = 'feat_';

export const slotOf = (mode: SuggestMode): SuggestSlot => MODE_SLOT[mode];

export function sayChip(text: string, mode: SuggestMode, seed: string): SuggestChip {
  return { text, slot: MODE_SLOT[mode], kind: 'say', mode, seed_id: seed };
}

export function fillChip(text: string, mode: SuggestMode, seed: string): SuggestChip {
  return { text, slot: MODE_SLOT[mode], kind: 'fill', mode, seed_id: seed };
}

export function doChip(text: string, mode: SuggestMode, action: SuggestAction, seed: string): SuggestChip {
  return { text, slot: MODE_SLOT[mode], kind: 'do', mode, action, seed_id: seed };
}

/** 换一格的 mode（积木给的格按配方的用途重标）。 */
export function withMode(chip: SuggestChip, mode: SuggestMode): SuggestChip {
  return { ...chip, mode, slot: MODE_SLOT[mode] };
}

/** 功能起头格：do + start_feature，文字按有无公司取。 */
export function featureChip(id: FeatureId, company?: string | null): SuggestChip {
  const name = company?.trim() || null;
  const action: SuggestAction = name
    ? { type: 'start_feature', feature_id: id, args: { company: name } }
    : { type: 'start_feature', feature_id: id };
  return doChip(featureChipText(id, name), 'start', action, `${FEATURE_SEED_PREFIX}${id}`);
}

export const isActionable = (c: SuggestChip): boolean => c.kind === 'do';
export const isFeatureStart = (c: SuggestChip): boolean => c.action?.type === 'start_feature';
