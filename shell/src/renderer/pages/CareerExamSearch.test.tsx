import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExamSearchRecord } from '@/components/career/exam-search/examSearchApi';

const api = vi.hoisted(() => ({
  recognize: vi.fn(), answer: vi.fn(), sessions: vi.fn(), session: vi.fn(), removeSession: vi.fn(), contexts: vi.fn(),
  live: vi.fn(), startLive: vi.fn(), endLive: vi.fn(), capture: vi.fn(), removeShot: vi.fn(), sendShots: vi.fn(),
}));
vi.mock('@/components/career/exam-search/examSearchApi', () => ({ examSearchApi: api }));
const updateConfig = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ config: { floatingBallDevGate: true, floatingBallEnabled: true }, updateConfig }) }));

import CareerExamSearch from './CareerExamSearch';

const session = { id: 'exm_1', company_name: '网易', role_title: '交互设计师', live_at: null, created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z' };
const record = (id: string, stem: string, over: Partial<ExamSearchRecord> = {}): ExamSearchRecord => ({
  id, session_id: 'exm_1', company_name: '网易', role_title: '交互设计师', input_kind: 'text', input_text: stem, material: null,
  questions: [{ index: 0, stem, options: [], qtype: 'single', matches: [] }], answers: [], status: 'recognized', error: null, answering: false,
  created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z', ...over,
});
const answered = (r: ExamSearchRecord, answer: string): ExamSearchRecord => ({
  ...r, status: 'answered', answers: [{ index: 0, answer, explanation: '', confidence: 'high', source: 'model', ref_item_id: null }],
});

function pasteText(text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { items: [], getData: () => text } });
  act(() => { window.dispatchEvent(event); });
}

describe('笔试助力页', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.sessions.mockResolvedValue([]);
    api.contexts.mockResolvedValue([]);
    api.live.mockResolvedValue({ session: null, shots: [] });
  });

  it('每次粘贴是这场的一步：左栏是题、右栏是答案，箭头前后翻，同一场接着记', async () => {
    const first = record('exs_1', '尼尔森原则不包括哪项');
    const second = record('exs_2', '数列 2, 4, 8 下一项');
    api.recognize.mockResolvedValueOnce({ search: first, session }).mockResolvedValueOnce({ search: second, session });
    api.answer.mockImplementation((id: string) => Promise.resolve(id === 'exs_1' ? answered(first, 'C') : answered(second, '16')));
    render(<CareerExamSearch />);

    pasteText('尼尔森原则不包括哪项');
    expect(await screen.findByText('C')).toBeInTheDocument();
    pasteText('数列 2, 4, 8 下一项');
    expect(await screen.findByText('16')).toBeInTheDocument();
    expect(api.recognize).toHaveBeenLastCalledWith(expect.objectContaining({ session_id: 'exm_1', text: '数列 2, 4, 8 下一项' }));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '上一次' }));
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByLabelText('粘进来的题目')).toHaveTextContent('尼尔森原则不包括哪项');
    expect(screen.getByText('C')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });

  it('这场还没有题：右栏摆一道示例题和答案（标一次「示例」），左栏粘贴入口照旧，不计数、不进记录', async () => {
    render(<CareerExamSearch />);
    const answerPane = screen.getByLabelText('答案');
    const sample = within(answerPane).getByTestId('sample');
    expect(sample).toHaveTextContent('示例');
    expect(sample).toHaveTextContent('找规律填数');
    expect(within(sample).getByText('A')).toBeInTheDocument();
    expect(answerPane).not.toHaveTextContent('答案会出现在这里');
    // 示例里只有翻看用的「解析」，没有重试、发出这类动作
    expect(within(sample).getAllByRole('button').map(b => b.textContent)).toEqual(['解析']);
    fireEvent.click(within(sample).getByRole('button', { name: '解析' }));
    expect(sample).toHaveTextContent('30 + 12 = 42');
    expect(screen.getByLabelText('粘进来的题目')).toHaveTextContent('复制题目，按');
    expect(screen.getByText('0 / 0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始这场' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '新的一场' })).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: '记录' }));
    expect(screen.queryByText(/找规律填数/)).toBeNull();
    await waitFor(() => expect(api.sessions).toHaveBeenCalled());
    expect(api.recognize).not.toHaveBeenCalled();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('第一道真题一进来，示例整块消失', async () => {
    const first = record('exs_1', '尼尔森原则不包括哪项');
    api.recognize.mockResolvedValueOnce({ search: first, session });
    api.answer.mockResolvedValue(answered(first, 'C'));
    render(<CareerExamSearch />);
    expect(screen.getByTestId('sample')).toBeInTheDocument();
    pasteText('尼尔森原则不包括哪项');
    expect(screen.queryByTestId('sample')).toBeNull();
    expect(await screen.findByText('C')).toBeInTheDocument();
    expect(screen.queryByText(/找规律填数/)).toBeNull();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
  });

  it('截图那一步：认完题后左栏按认出的材料、题干、选项统一排版', async () => {
    const shot = record('exs_3', '2024 年营收同比增长多少', {
      input_kind: 'image', input_text: null, material: '2023 年营收 100，2024 年营收 120',
      questions: [{ index: 0, stem: '2024 年营收同比增长多少', options: ['A. 10%', 'B. 20%'], qtype: 'single', matches: [] }],
    });
    api.sessions.mockResolvedValue([{ ...session, updated_at: new Date().toISOString(), search_count: 1, question_count: 1, first_stem: shot.questions[0].stem }]);
    api.session.mockResolvedValue({ session, searches: [answered(shot, 'B')] });
    render(<CareerExamSearch />);
    const source = await screen.findByLabelText('粘进来的题目');
    await waitFor(() => expect(source).toHaveTextContent('2023 年营收 100'));
    expect(source).toHaveTextContent('单选2024 年营收同比增长多少');
    expect(source).toHaveTextContent('B. 20%');
  });

  it('记录按场列出，点开回到那场的最后一步', async () => {
    api.sessions.mockResolvedValue([{ ...session, updated_at: '2026-10-01T00:00:00Z', search_count: 1, question_count: 1, first_stem: '老题' }]);
    api.session.mockResolvedValue({ session, searches: [answered(record('exs_9', '老题'), 'B')] });
    render(<CareerExamSearch />);
    fireEvent.click(screen.getByRole('tab', { name: '记录' }));
    fireEvent.click(await screen.findByText('网易 · 交互设计师'));
    await waitFor(() => expect(screen.getByText('B')).toBeInTheDocument());
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
  });

  it('开始这场后显示宠物挂着的截图，一口气发出去，答案进这场', async () => {
    const shots = [{ id: 'shot_1', thumb: 'data:image/jpeg;base64,AA', captured_at: '' }, { id: 'shot_2', thumb: 'data:image/jpeg;base64,BB', captured_at: '' }];
    const liveSession = { ...session, live_at: '2026-11-05T10:00:00Z' };
    api.startLive.mockResolvedValue({ session: liveSession, shots });
    const sent = record('exs_5', '跨两张图的题', { input_kind: 'image', input_text: null });
    api.sendShots.mockResolvedValue({ search: sent, session: liveSession });
    api.answer.mockResolvedValue(answered(sent, 'D'));
    render(<CareerExamSearch />);

    fireEvent.click(await screen.findByRole('button', { name: '开始这场' }));
    expect(await screen.findByText('正在考')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /截图/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /发出去 · 2 张/ }));
    expect(await screen.findByText('D')).toBeInTheDocument();
    expect(api.sendShots).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('粘进来的题目')).toHaveTextContent('跨两张图的题');
  });
});
