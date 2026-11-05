/**
 * 下一步条 · 一行三条按立场排（2026-11-05 你定）：配合（顺着小芽往下走）· 犹豫（拿不准、想缓缓）· 纠正（小芽说偏了）。
 * 每种立场一个位置，左→右固定；候选按来源先后（模型 → 配方 → 示例 → 通用兜底 → 这里的立场兜底）先到先得。
 */
import { SUGGEST_STANCES, stanceOf, type SuggestChip, type SuggestStance } from '../../shared/careerSuggest';
import { fillChip, sayChip } from './suggest-chip';

/** 一行三个位置，按立场取。 */
export type StanceSlots = Partial<Record<SuggestStance, SuggestChip>>;

const withStance = (chip: SuggestChip, stance: SuggestStance): SuggestChip => ({ ...chip, stance });

/** 实在补不上时每种立场的最后一条：不点名对象，靠 seed 免 L4 / L11。 */
export const STANCE_FALLBACK: Readonly<Record<SuggestStance, SuggestChip>> = {
  agree: withStance(sayChip('好，就按你说的来', 'answer', 'stance_agree'), 'agree'),
  hesitate: withStance(sayChip('等等，我再想想', 'option', 'stance_hesitate'), 'hesitate'),
  correct: withStance(fillChip('不是这样，其实是：', 'option', 'stance_correct'), 'correct'),
};

/** 把候选按立场放进还空着的位置（先到先得），放进去的都带上 stance。 */
export function takeByStance(slots: StanceSlots, candidates: readonly SuggestChip[]): void {
  for (const c of candidates) {
    const st = stanceOf(c);
    if (!slots[st]) slots[st] = withStance(c, st);
  }
}

/** 还空着的立场。 */
export const missingStances = (slots: StanceSlots): SuggestStance[] => SUGGEST_STANCES.filter(st => !slots[st]);

/** 排成一行：配合 → 犹豫 → 纠正。 */
export const rowOf = (slots: StanceSlots): SuggestChip[] => SUGGEST_STANCES.flatMap(st => {
  const chip = slots[st];
  return chip ? [chip] : [];
});

/** 配方格的纠正词：改掉小芽的说法、换方向、去掉一类。 */
const CORRECT_WORDS = /^(不是|不对|不要|换|改成|去掉|只要|只投|方向改)/;
/** 配方格的犹豫词：先不 / 空着 / 再看 / 靠不靠谱 / 算不算，或干脆是一句问话。 */
const HESITATE_WORDS = /先不|不投|不填|空着|再看|再想|先放|靠谱吗|算吗|差在哪|先看看|[？?吗]$/;

/**
 * 配方格（规则 / 兜底，旧四格写法）不带立场：按文字判一次——退出口和犹豫词算犹豫，纠正词算纠正，其余算配合。
 * 只给没标立场的格判；模型按立场写的不动。
 */
export function guessStance(chip: SuggestChip): SuggestChip {
  if (chip.stance) return chip;
  const t = chip.text.trim();
  if (chip.mode === 'exit' || HESITATE_WORDS.test(t)) return withStance(chip, 'hesitate');
  if (CORRECT_WORDS.test(t)) return withStance(chip, 'correct');
  return withStance(chip, 'agree');
}

/** 一组示例里第 i 行是哪种立场（示例每组三行，按配合 / 犹豫 / 纠正写）。 */
export const stanceAt = (i: number): SuggestStance | undefined => SUGGEST_STANCES[i];
