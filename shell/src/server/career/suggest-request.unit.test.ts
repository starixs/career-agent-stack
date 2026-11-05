/**
 * /api/career/suggest 请求体校验（跨边界）：this_turn 的形状与截断、source 只认 hook、坏字段丢掉不报错。
 */
import { describe, expect, it } from 'vitest';

import { SUGGEST_MAX_TOOLS, SUGGEST_MAX_TURNS, SUGGEST_TURN_CHARS } from '../../shared/careerSuggest';
import { parseSuggestRequest } from './suggest-request';

describe('parseSuggestRequest', () => {
  it('this_turn 不是对象（缺、数组、字符串、null）→ undefined', () => {
    for (const bad of [undefined, null, 'x', ['a'], 3]) {
      expect(parseSuggestRequest({ this_turn: bad }).this_turn).toBeUndefined();
    }
  });

  it('this_turn：文字截到 SUGGEST_TURN_CHARS；非字符串当空；工具去坏名；卡只留 [a-z_] 且最多 8 张', () => {
    const long = '字'.repeat(SUGGEST_TURN_CHARS + 50);
    const cards = ['batch_pick', 'Bad-Kind', 7, ...Array.from({ length: 10 }, () => 'tailor_diff')];
    const t = parseSuggestRequest({ this_turn: { user: long, assistant: 42, tools: ['job_evaluate', 'job-search', 'Bad', 3], cards } }).this_turn;
    expect(t?.user).toHaveLength(SUGGEST_TURN_CHARS);
    expect(t?.assistant).toBe('');
    expect(t?.tools).toEqual(['job_evaluate']);
    expect(t?.cards).toEqual(['batch_pick', ...Array.from({ length: 7 }, () => 'tailor_diff')]);
  });

  it('source 只有 "hook" 算 hook，其余（缺、别的字符串、非字符串）都是 poll', () => {
    expect(parseSuggestRequest({ source: 'hook' }).source).toBe('hook');
    for (const v of [undefined, 'poll', 'HOOK', 1, null]) expect(parseSuggestRequest({ source: v }).source).toBe('poll');
  });

  it('上限：轮数取最后几轮且每轮截字、空轮与坏角色丢；工具有上限；离开时长越界为 null', () => {
    const many = Array.from({ length: SUGGEST_MAX_TURNS + 2 }, (_, i) => ({ role: 'user', text: `第${i}轮${'长'.repeat(SUGGEST_TURN_CHARS)}` }));
    const turns = [{ role: 'user', text: '  ' }, { role: 'robot', text: 'x' }, ...many];
    const req = parseSuggestRequest({ turns, last_tools: Array.from({ length: SUGGEST_MAX_TOOLS + 3 }, () => 'jd_parse'), away_hours: 24 * 366 });
    expect(req.turns).toHaveLength(SUGGEST_MAX_TURNS);
    expect(req.turns?.[0]?.text.startsWith('第2轮')).toBe(true);
    expect(req.turns?.every(t => t.text.length === SUGGEST_TURN_CHARS)).toBe(true);
    expect(req.last_tools).toHaveLength(SUGGEST_MAX_TOOLS);
    expect(req.away_hours).toBeNull();
    expect(parseSuggestRequest({ away_hours: -1 }).away_hours).toBeNull();
    expect(parseSuggestRequest({ away_hours: 30.5 }).away_hours).toBe(30.5);
  });

  it('last_user / last_assistant：空白当 null，超长截断', () => {
    const req = parseSuggestRequest({ last_user: '   ', last_assistant: '长'.repeat(SUGGEST_TURN_CHARS + 1) });
    expect(req.last_user).toBeNull();
    expect(req.last_assistant).toHaveLength(SUGGEST_TURN_CHARS);
  });
});
