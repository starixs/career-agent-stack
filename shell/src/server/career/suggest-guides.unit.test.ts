/**
 * 29 幕思路与示例（plan-r4-suggest §4 / §5.1 末条）：每幕都有思路、2–3 组各 4 条示例、意图都在白名单里，
 * 示例本身过质量线的字面规则（≤22 字、无开发词、不撞卡按钮、不以"发给我"收尾），target 写法解析得了；
 * 外加 verify-r3 P2-10 / P2-11 / P2-18 三处兜底配方的回归。
 */
import { describe, expect, it } from 'vitest';

import { isFeatureId } from '../../shared/careerFeatures';
import { SUGGEST_MAX_CHARS, type SuggestChip } from '../../shared/careerSuggest';
import { ask, input, state } from './suggest-fixtures';
import { GUIDES as FLOW } from './suggest-guide-flow';
import { GUIDES as TALK } from './suggest-guide-talk';
import { isSuggestIntent, type SceneGuide } from './suggest-guide-types';
import { CARD_BUTTONS, lintChip, type LintCtx } from './suggest-lint';
import { recipeFor, type RecipeCtx } from './suggest-recipes';
import { COHORT_FILL, numberFills } from './suggest-recipes-talk';
import { SCENES, type SceneId } from './suggest-scene';
import type { SuggestState } from './suggest-types';

const GUIDES: Readonly<Partial<Record<SceneId, SceneGuide>>> = { ...TALK, ...FLOW };
/** 思路给模型的幕段上限（plan-r4 §3.3：幕段 ≤300 字）。 */
const GUIDE_TEXT_MAX = 300;
/** 底下有卡的幕：示例不能撞卡自己的按钮（L5）。 */
const CARD_OF: Partial<Record<SceneId, string>> = { S2: 'resume_intake', S7: 'claims_confirm', S11: 'tailor_diff', S13: 'batch_pick' };
const OPEN_TARGET = /^(live|resume|jobs|dossier|resume:tailored|dossier:.+)$/;
const ASK_KINDS = ['登录', '缺信息', '没填成', '过目', '选择'];

interface Row { text: string; intent: string; target: string | null }
const parseRow = (row: string): Row => {
  const [text = '', intent = '', target] = row.split('|');
  return { text, intent, target: target ?? null };
};
const each = (fn: (scene: SceneId, row: Row, guide: SceneGuide) => void) => {
  for (const scene of SCENES) {
    const guide = GUIDES[scene];
    if (!guide) continue;
    for (const set of guide.examples) for (const r of set) fn(scene, parseRow(r), guide);
  }
};

/** target 写法是否是解析器认得的（plan-r4 §3.2 解析表）。 */
function targetOk({ intent, target }: Row): boolean {
  switch (intent) {
    case 'say': case 'fill': case 'dismiss_card': return target === null;
    case 'start_card': return target === 'picked' || target === 'all';
    case 'open': return target !== null && OPEN_TARGET.test(target);
    case 'start_feature': return target !== null && isFeatureId(target.split(':')[0]);
    case 'ask_choose': return !!target;
    case 'ask_primary': return target !== null && ['没填成', '过目'].includes(target);
    case 'open_deck': return target === null || ASK_KINDS.includes(target);
    case 'propose_batch': return target === null || target.length > 0;
    default: return false;
  }
}

describe('29 幕思路与示例', () => {
  it('每一幕都有思路，S1–S12 / S13–S29 两份不重叠', () => {
    expect(SCENES.filter(id => !GUIDES[id])).toEqual([]);
    expect(Object.keys(TALK).filter(k => k in FLOW)).toEqual([]);
    for (const id of SCENES) {
      const g = GUIDES[id];
      expect(g?.text.trim().length, id).toBeGreaterThan(40);
      expect(g?.text.length, id).toBeLessThanOrEqual(GUIDE_TEXT_MAX);
    }
  });

  it('每幕 2–3 组示例、每组 4 条；意图在白名单且在本幕允许内', () => {
    for (const id of SCENES) {
      const g = GUIDES[id];
      expect(g?.examples.length, id).toBeGreaterThanOrEqual(2);
      expect(g?.examples.length, id).toBeLessThanOrEqual(3);
      expect(g?.examples.every(set => set.length === 4), id).toBe(true);
      expect(g?.intents.every(isSuggestIntent), id).toBe(true);
    }
    each((scene, row, g) => expect(g.intents, `${scene} ${row.text}`).toContain(row.intent));
  });

  it('示例过字面质量线：≤22 字、无开发词、无残渣、不承诺、不撞卡按钮、不"发给我"', () => {
    each((scene, row) => {
      expect(row.text.length, row.text).toBeLessThanOrEqual(SUGGEST_MAX_CHARS);
      const chip: SuggestChip = { text: row.text, slot: 'act', kind: 'say', mode: 'answer', seed_id: 'guide_example' };
      const ctx: LintCtx = { scene, entities: [], cardKind: CARD_OF[scene] ?? null, recent: new Set<string>() };
      expect(lintChip(chip, ctx), `${scene} ${row.text}`).toBeNull();
    });
    expect(Object.values(CARD_OF).filter(k => !CARD_BUTTONS[k ?? ''])).toEqual([]);
  });

  it('fill 示例带空或以冒号收尾；target 写法解析器认得', () => {
    each((scene, row) => {
      if (row.intent === 'fill') expect(/＿＿|：$/.test(row.text), `${scene} ${row.text}`).toBe(true);
      expect(targetOk(row), `${scene} ${row.text}|${row.intent}|${row.target}`).toBe(true);
    });
  });

  it('非访谈幕和访谈幕一样有变化：同一幕的几组示例第一条各不相同', () => {
    for (const id of SCENES) {
      const firsts = (GUIDES[id]?.examples ?? []).map(set => set[0]);
      expect(new Set(firsts).size, id).toBe(firsts.length);
    }
  });
});

const ctxOf = (scene: SceneId, s: SuggestState, lastAssistant = ''): RecipeCtx =>
  ({ s, x: input({ last_assistant: lastAssistant }), scene, recent: new Set() });
const chipsOf = (scene: SceneId, c: RecipeCtx) => recipeFor(scene).rules(c).filter((x): x is SuggestChip => x !== null);

describe('兜底配方回归（verify-r3）', () => {
  it('P2-18 S1 届别是真填空，不写猜的届别', () => {
    const s = state({ stage: 'profile', resume: { has: false, name: null, tailored: 0, experiences: 0 }, prefs: { keywords: [], cities: [], cohort: null } });
    const chip = chipsOf('S1', ctxOf('S1', s)).find(c => c.seed_id === 's1_cohort');
    expect(chip).toMatchObject({ kind: 'fill', text: COHORT_FILL });
    expect(chip?.text).toContain('＿＿');
  });

  it('P2-10 S4 第二个半句也按问句挑；「多久以前」不算问时长', () => {
    expect(numberFills('多少人参加，排第几名？').map(c => c.seed_id)).toEqual(['s4_rank', 's4_people']);
    expect(numberFills('提升了多少，覆盖多少用户？').map(c => c.seed_id)).toEqual(['s4_pct', 's4_people']);
    expect(numberFills('大概有多少人参加？').map(c => c.seed_id)).toEqual(['s4_people', 's4_weeks']);
    expect(numberFills('这是多久以前的事，有多少人？').map(c => c.seed_id)).toEqual(['s4_people', 's4_weeks']);
  });

  it('P2-11 S20 收尾不是回答；S21 没公司不出「这家会深挖」；S25 不出无对象的「继续聊刚才的」', () => {
    const exam = state({ dueSoon: [{ kind: 'written_test', company: '字节跳动', at: '2026-11-06' }] });
    expect(chipsOf('S20', ctxOf('S20', exam)).find(c => c.seed_id === 's20_after')?.mode).toBe('option');
    const s21 = chipsOf('S21', ctxOf('S21', state()));
    expect(s21.some(c => c.text.includes('这家'))).toBe(false);
    const s25 = chipsOf('S25', ctxOf('S25', state({ asks: [ask({ kind: 'login', companies: ['华为'], count: 1 })] })));
    expect(s25.map(c => c.text)).not.toContain('继续聊刚才的');
    expect(s25[0]).toMatchObject({ kind: 'do', action: { type: 'open_deck', ask_id: 'ask-login' } });
  });
});
