/**
 * 提示词契约（plan-r4-suggest §3.3 / §5.1）：模型看得到这一轮（他说的、小芽说的、工具中文名、放的卡）、
 * 截止"几天后"、近 7 天拒信、离开小时、上一轮四格；system 有幕思路、允许意图、标"别照抄"的示例；总长在预算内。
 */
import { describe, expect, it } from 'vitest';

import type { SuggestTurn } from '../../shared/careerSuggest';
import { ask, card, jobs, state } from './suggest-fixtures';
import type { SceneGuide } from './suggest-guide-types';
import { buildPrompt, PROMPT_MAX_CHARS } from './suggest-prompt';
import { guideFor } from './suggest-recipes';
import { inputOf, SCENES } from './suggest-scene';

const roleOf = (i: number): SuggestTurn['role'] => (i % 2 ? 'assistant' : 'user');

const guide: SceneGuide = {
  text: '底下是一张勾选表，默认勾了几家等他点头。',
  intents: ['start_card', 'dismiss_card', 'say'],
  anchor: 'strict',
  examples: [['就这 5 家，先投招商|start_card|picked', '全投，18 家都投|start_card|all', '换一批|say', '先放着|dismiss_card']],
};

const s = state({
  asks: [ask({ kind: 'login', companies: ['华为'] })],
  openCard: card({ kind: 'batch_pick', picked: ['招商银行'], pickedIds: ['j1'], allIds: ['j1', 'j2'] }),
  nextJobs: [{ job_id: 'j1', company: '招商银行', known: true, title: '管培生' }],
  dueSoon: [{ kind: 'written_test', company: '字节跳动', at: '2026-11-07', daysLeft: 2 }],
  rejections7d: 5, awayHours: 30.4,
});
const thisTurn = { user: '外包的我都不要', assistant: '好，先给你挑了 5 家，招商银行排第一，要投吗？', tools: ['batch_propose', 'job_evaluate', 'mystery_tool'], cards: ['batch_pick'] };

describe('buildPrompt', () => {
  it('user 里有这一轮、工具中文名、卡、截止几天后、拒信、离开小时、上一轮四格', () => {
    const { user } = buildPrompt({ guide, s, x: inputOf({ turns: [{ role: 'user', text: '早' }] }), thisTurn, lastShown: ['就这 5 家', '换一批'] });
    for (const want of [thisTurn.user, thisTurn.assistant, '挑一批岗位', '评估岗位', 'mystery_tool', 'batch_pick',
      '"几天后":2', '"近7天拒信":5', '"离上次说话小时":30', '"岗位":"管培生"', '华为', '"类":"登录"', '["就这 5 家","换一批"]', 'U: 早']) {
      expect(user).toContain(want);
    }
  });

  it('system 有幕思路、只列允许的意图、示例标"别照抄"', () => {
    const { system } = buildPrompt({ guide, s, x: inputOf({}), thisTurn, lastShown: [] });
    expect(system).toContain(guide.text);
    expect(system).toContain('示例，别照抄');
    expect(system).toContain('就这 5 家，先投招商｜start_card｜picked');
    expect(system).toContain('start_card：');
    expect(system).not.toContain('ask_choose：');
  });

  it('超预算先丢最早的历史轮', () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, text: `第${i}轮${'很长的一段话'.repeat(40)}` }));
    const long = { ...thisTurn, user: '他'.repeat(400), assistant: '小芽'.repeat(400) };
    const wordy = { ...guide, text: '思路'.repeat(400) };
    const { system, user } = buildPrompt({ guide: wordy, s, x: inputOf({ turns }), thisTurn: long, lastShown: [] });
    expect(system.length + user.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(user).toContain('第5轮');
    expect(user).not.toContain('第0轮');
  });

  it('29 幕的真思路在一般状态下都放得进预算', () => {
    const typical = state({ nextJobs: jobs('平安银行', '美的', '格力', '招商银行'), asks: [ask({ kind: 'review', count: 3 })] });
    const turns = Array.from({ length: 6 }, (_, i) => ({ role: roleOf(i), text: '一句普通长度的话，二三十个字左右的样子吧'.repeat(2) }));
    for (const scene of SCENES) {
      const g = guideFor(scene);
      if (!g) continue;
      const { system, user } = buildPrompt({ guide: g, s: typical, x: inputOf({ turns }), thisTurn, lastShown: ['a', 'b', 'c', 'd'] });
      expect(system.length + user.length, scene).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
      expect(user, scene).toContain(thisTurn.user);
    }
  });
});
