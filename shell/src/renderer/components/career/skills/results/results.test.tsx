import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson } from '@/api/apiFetch';

import { QuestionBankPanel } from '../../QuestionBankPanel';
import type { GapPlan, QuestionItem } from '../../types';

import { GapPlans } from './GapPlans';
import { MockReport } from './MockReport';

describe('模拟面试报告', () => {
  it('一句话一张卡：卡在第几层和「可以这样答」在同一张卡里；没对上哪句话的答案单独列', () => {
    render(<MockReport report={{
      diagnosis: [
        { claim: '主导三层配置体系', broke_at_layer: 3, issue: '说不清哪些是自己拍板的', interviewer_thought: '「主导」可能说大了' },
        { claim: '请求削减 80%', broke_at_layer: 2, issue: '没有对比口径' },
      ],
      reference_answers: [
        { claim: '主导三层配置体系', answer: '我负责规则配置层', needs_verification: ['上线时间'] },
        { claim: '别的话', answer: '这句没有对应的卡' },
      ],
    }} />);
    const list = screen.getByRole('list', { name: '卡在哪' });
    const cards = within(list).getAllByRole('listitem').filter(item => item.parentElement === list);
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole('img', { name: '追到第 3 层卡住' })).toBeInTheDocument();
    expect(within(cards[0]).getByRole('note', { name: '可以这样答' })).toHaveTextContent('我负责规则配置层');
    expect(within(cards[0]).getByRole('img', { name: '面试官怎么想' })).toBeInTheDocument();
    expect(within(cards[0]).getByLabelText('先核实：上线时间')).toBeInTheDocument();
    expect(within(cards[1]).queryByRole('note')).toBeNull();
    // 没配上的那条不丢，也不重复
    expect(screen.getAllByRole('note', { name: '可以这样答' })).toHaveLength(2);
    expect(screen.getByText('这句没有对应的卡')).toBeInTheDocument();
  });
});

describe('差距计划', () => {
  it('第一层是一根比例条和补齐要几小时；第二层逐条列，没有内容的那栏不出现', () => {
    const plan: GapPlan = {
      id: 'g1', job_id: null, direction_id: null, created_at: '2026-11-03',
      gaps_json: JSON.stringify({ have: ['Java 后端经验', 'Redis'], need_evidence: ['高并发的量化结果'], missing: [] }),
      actions_json: JSON.stringify([{ title: '补压测记录', acceptance: '有前后对比', est_hours: 4 }, { title: '做延迟消息练习', hours: 8 }, '再看一遍 JD']),
    };
    render(<GapPlans plans={[plan]} targets={{ jobs: [], directions: [] }} />);
    expect(screen.getByRole('img', { name: '岗位要求：已具备 2，需补证据 1' })).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('小时补齐')).toBeInTheDocument();
    expect(screen.getByText('高并发的量化结果')).toBeInTheDocument();
    expect(screen.getByText('再看一遍 JD')).toBeInTheDocument();
  });
});

describe('题库', () => {
  beforeEach(() => { vi.mocked(apiGetJson).mockReset(); });

  it('题干在前；练得怎样是分数环，没练过是空圈；不把内部分类名摆出来', async () => {
    const base: QuestionItem = {
      id: 'q1', question_key: 'k1', kind: 'interview', category: 'project', content: '讲一个你做过的最复杂的项目', reference: null, probe_points_json: JSON.stringify(['职责边界']), jd_requirement: null,
      company_name: '甲公司', title: null, job_id: null, source: 'generated', sources_json: '[]', tags_json: '[]',
      seen_count: 0, attempt_count: 2, last_attempt_score: 52, best_attempt_score: 70, first_seen_at: null, last_seen_at: null, updated_at: '2026-11-01',
    };
    const fresh: QuestionItem = { ...base, id: 'q2', question_key: 'k2', content: '为什么想来我们公司', attempt_count: 0, last_attempt_score: null, best_attempt_score: null, probe_points_json: '[]' };
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, questions: [base, fresh] });
    render(<QuestionBankPanel />);
    const first = (await screen.findByText('讲一个你做过的最复杂的项目')).closest('li');
    if (!first) throw new Error('题目行没渲染出来');
    expect(within(first).getByRole('img', { name: '上次 52 分' })).toBeInTheDocument();
    expect(within(first).getByText('面试 · 甲公司')).toBeInTheDocument();
    expect(within(first).getByText('职责边界')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '没练过' })).toBeInTheDocument();
    expect(screen.queryByText(/project/)).toBeNull();
    expect(screen.queryByText(/题库（/)).toBeNull();
  });
});
