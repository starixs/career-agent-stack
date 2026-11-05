import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { BankMatch, QuestionAnswer, SearchQuestion } from './examSearchApi';
import { SearchResult, similarOf, sourceLabel } from './SearchResult';

const match = (over: Partial<BankMatch>): BankMatch => ({
  item_id: 'i1', stem: '以下哪项不属于尼尔森十大可用性原则', options: [], answer: 'C', explanation: '美观不是原则',
  company_name: '网易', role_title: '交互设计师', year: 2024, bank_name: 'b', origin: 'user', tier: 'same-role-company', similarity: 0.95, same: true, ...over,
});
const question = (matches: BankMatch[], over: Partial<SearchQuestion> = {}): SearchQuestion => ({ index: 0, stem: '以下哪项不属于尼尔森十大可用性原则', options: ['A. 防错', 'C. 美观至上'], qtype: 'single', matches, ...over });
const answer = (over: Partial<QuestionAnswer>): QuestionAnswer => ({ index: 0, answer: 'C', explanation: '美观不是原则', confidence: 'high', source: 'bank', ref_item_id: 'i1', ...over });

describe('搜题结果', () => {
  it('出处只标题库给的：题库原题 / 参考类似题；模型自己答的不挂出处', () => {
    expect(sourceLabel(question([match({})]), answer({}))?.text).toBe('题库原题 · 网易 · 交互设计师 · 2024');
    expect(sourceLabel(question([match({ tier: 'same-role', similarity: 0.5, same: false })]), answer({ source: 'reference' }))?.text).toBe('参考了同岗位的类似题');
    expect(sourceLabel(question([]), answer({ source: 'model', ref_item_id: null }))).toBeNull();
  });

  it('原题不算类似题；只是类似时全部列出', () => {
    const other = match({ item_id: 'i2', similarity: 0.4, same: false });
    expect(similarOf(question([match({}), other]), answer({})).map(m => m.item_id)).toEqual(['i2']);
    expect(similarOf(question([other]), answer({ source: 'reference' })).map(m => m.item_id)).toEqual(['i2']);
  });

  it('答案先行；拿不准如实标出；解析点开才看', () => {
    render(<SearchResult questions={[question([])]} answers={[answer({ source: 'model', confidence: 'low', explanation: '凭常识' })]} pending={false} />);
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByText('拿不准')).toBeInTheDocument();
    expect(screen.queryByText('凭常识')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /解析/ }));
    expect(screen.getByText('凭常识')).toBeInTheDocument();
  });

  it('还在作答的题显示「作答中」，性格题叫「建议倾向」', () => {
    render(<SearchResult questions={[question([], { qtype: 'personality' })]} answers={[]} pending />);
    expect(screen.getByText('作答中…')).toBeInTheDocument();
    expect(screen.getByText('建议倾向')).toBeInTheDocument();
  });
});
