import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { buildPrepTargets, suggestedTab } from '@/components/career/interview/prepTargets';
import type { DossierSummary, Interview } from '@/components/career/types';
import CareerInterview from './CareerInterview';

const NOW = '2026-11-05T08:00:00.000Z';

const interviews: Interview[] = [
  {
    id: 'i1', application_id: null, company_name: '丙公司', title: '后端工程师', round: 'first', date: '2026-09-28',
    interviewer_role_guess: '技术负责人', transcript: '问了限流的实现', tags_json: JSON.stringify(['限流', '系统设计']),
    retro_json: JSON.stringify({ went_well: ['表达清晰'], improve: ['量化结果'] }), result: 'no_feedback_inferred', result_source: 'inferred',
    created_at: '2026-09-28', updated_at: '2026-09-28',
  },
  {
    id: 'i2', application_id: null, company_name: '丁公司', title: '算法工程师', round: 'hr', date: '2026-09-20',
    interviewer_role_guess: null, transcript: null, tags_json: '[]', retro_json: null, result: 'advanced', result_source: 'official',
    created_at: '2026-09-20', updated_at: '2026-09-20',
  },
];
const report = {
  verdict: 'borderline',
  diagnosis: [{ claim: '主导配置体系开发', broke_at_layer: 3, issue: '说不清哪些是自己拍板的', interviewer_thought: '「主导」可能说大了' }],
  reference_answers: [{ claim: '主导配置体系开发', answer: '我负责规则配置层', needs_verification: ['上线时间'] }],
  todo: ['把「主导」改成真正负责的那一层'],
};
const mocks = [
  { id: 'm1', job_id: null, resume_tailored_id: null, mode: 'probe', company_type: '大厂', round: 'first', turns_json: JSON.stringify([{}, {}]), report_json: JSON.stringify(report), created_at: '2026-09-25', updated_at: '2026-09-25' },
  { id: 'm2', job_id: null, resume_tailored_id: null, mode: 'probe', company_type: null, round: 'second', turns_json: '[]', report_json: null, created_at: '2026-09-26', updated_at: '2026-09-26' },
];
const predictions = [
  { id: 'p2', resume_tailored_id: null, claim_id: null, statement: '负责权限模块', target_type: 'project', expected_chain_json: JSON.stringify(['权限模型怎么设计']), risk: 'low', created_at: '2026-09-25' },
  { id: 'p1', resume_tailored_id: null, claim_id: null, statement: 'P99 从 800ms 到 200ms 的具体手段', target_type: 'data', expected_chain_json: JSON.stringify(['怎么测的', '基线是什么']), risk: 'high', created_at: '2026-09-25' },
];
const dossiers = [{ application_id: 'a1', job_id: 'j1', company_name: '甲公司', title: '后端开发', stage: 'interview', closed: false }];
const questions = [{ id: 'q1', kind: 'interview', content: '讲讲限流怎么做', job_id: 'j1', company_name: '甲公司', attempt_count: 0, last_attempt_score: null, probe_points_json: '[]', source: 'generated' }];

function mockGet(empty = false) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/interviews/')) return { ok: true, recordings: [] };
    if (path.startsWith('/api/career/interviews')) return { ok: true, interviews: empty ? [] : interviews };
    if (path.startsWith('/api/career/mock-interviews')) return { ok: true, mockInterviews: empty ? [] : mocks };
    if (path.startsWith('/api/career/probe-predictions')) return { ok: true, predictions: empty ? [] : predictions };
    if (path.startsWith('/api/career/dossiers')) return { ok: true, dossiers: empty ? [] : dossiers };
    if (path.startsWith('/api/career/questions')) return { ok: true, questions: empty ? [] : questions };
    return { ok: true };
  });
}

function captureChat() {
  const said: Array<{ text: string; mode?: string; context?: { refs?: Record<string, unknown> } }> = [];
  const off = onEvent('career:chat-suggest', (event: (typeof said)[number]) => { said.push(event); });
  return { said, off };
}

const openTab = async (name: string) => fireEvent.click(await screen.findByRole('tab', { name }));

describe('面试助力 · 准备', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('什么都没有时也能一键开始：没有空话，也不报错', async () => {
    mockGet(true);
    const chat = captureChat();
    render(<CareerInterview />);
    fireEvent.click(await screen.findByRole('button', { name: '帮我准备面试' }));
    expect(chat.said[0]).toMatchObject({ text: '帮我准备面试', mode: 'send' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    chat.off();
  });

  it('预测追问按风险从高到低排，最要紧的一条直接摊开追问链', async () => {
    mockGet();
    render(<CareerInterview />);
    await openTab('准备');
    const section = await screen.findByRole('region', { name: '会被深挖的' });
    expect(within(section).getByText('高风险 1 · 低风险 1')).toBeInTheDocument();
    const rows = within(section).getAllByRole('button').filter(button => button.hasAttribute('aria-expanded'));
    expect(rows[0]).toHaveTextContent('P99 从 800ms 到 200ms 的具体手段');
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true');
    expect(within(section).getByText('怎么测的')).toBeInTheDocument();
    expect(within(section).queryByText('权限模型怎么设计')).toBeNull();
  });

  it('选好准备哪一场，预测、出题、模拟都带着这份投递的 id 发进对话', async () => {
    mockGet();
    const chat = captureChat();
    render(<CareerInterview />);
    await openTab('准备');
    fireEvent.click(await screen.findByRole('button', { name: '帮我准备这一场' }));
    fireEvent.click(screen.getByRole('button', { name: '重新预测' }));
    fireEvent.click(screen.getByRole('button', { name: '出一组题' }));
    fireEvent.click(screen.getByRole('button', { name: '开始模拟' }));
    expect(chat.said.map(event => event.text)).toEqual([
      '帮我准备甲公司的面试', '预测一下甲公司面试会深挖我简历哪里', '按甲公司 · 后端开发出一组面试题', '开始模拟甲公司一面，先从高风险的深挖点问起',
    ]);
    for (const event of chat.said) expect(event.context?.refs).toMatchObject({ application_id: 'a1', job_id: 'j1' });
    expect(chat.said[3].context?.refs).toMatchObject({ round: 'first' });
    chat.off();
  });

  it('先练这几道：这个岗位的题，点「练这道」带着题目 id', async () => {
    mockGet();
    const chat = captureChat();
    render(<CareerInterview />);
    await openTab('准备');
    const section = await screen.findByRole('region', { name: '先练这几道' });
    expect(within(section).getByText('讲讲限流怎么做')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: '练这道' }));
    expect(chat.said[0]).toMatchObject({ text: '用这道题考我：讲讲限流怎么做', context: { refs: { question_id: 'q1' } } });
    chat.off();
  });

  it('模拟面试：练完的看面试官视角的复盘，没练完的可以接着练', async () => {
    mockGet();
    const chat = captureChat();
    render(<CareerInterview />);
    await openTab('准备');
    fireEvent.click(await screen.findByRole('button', { name: /深挖追问 · 一面 · 大厂/ }));
    expect(screen.getByText('这场有点悬')).toBeInTheDocument();
    expect(screen.getByText('追到第 3 层：说不清哪些是自己拍板的')).toBeInTheDocument();
    expect(screen.getByText('先核实：上线时间')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /深挖追问 · 二面/ }));
    fireEvent.click(screen.getByRole('button', { name: '接着练' }));
    expect(chat.said[0]).toMatchObject({ context: { refs: { mock_interview_id: 'm2' } } });
    chat.off();
  });
});

describe('面试助力 · 复盘', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('有面完还没复盘的、又没有马上要面的：一进来就是复盘', async () => {
    mockGet();
    render(<CareerInterview />);
    expect(await screen.findByRole('tab', { name: '复盘' })).toHaveAttribute('aria-selected', 'true');
  });

  it('渲染记录列表（结果与来源）、过程记录和复盘', async () => {
    mockGet();
    render(<CareerInterview />);
    expect((await screen.findAllByText('无反馈（推测）')).length).toBeGreaterThan(0);
    expect(screen.getByText('推测')).toBeInTheDocument();
    expect(screen.getByText('进入下一轮')).toBeInTheDocument();
    expect(screen.getByText('问了限流的实现')).toBeInTheDocument();
    expect(screen.getByText('表达清晰')).toBeInTheDocument();
    expect(screen.getByText('限流')).toBeInTheDocument();
  });

  it('技能约定结构的复盘按「问了什么卡在哪 / 重答一遍 / 要补的」摆出来', async () => {
    const retro = {
      focus_this_round: '数字的口径',
      questions: [{ quote: '30% 是怎么统计的？', intent: '核对数字来源', stuck_layer: 2, interviewer_doubt: { evidence: '没说统计周期', alternative: '' } }],
      retakes: [{ question: '30% 是怎么统计的？', answer: '按工单工时算', needs_verification: ['前后各四周的工时'] }],
      todo: { facts: ['把口径写下来'], delivery: [] },
    };
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/career/interviews/')) return { ok: true, recordings: [] };
      if (path.startsWith('/api/career/interviews')) return { ok: true, interviews: [{ ...interviews[0], retro_json: JSON.stringify(retro) }] };
      return { ok: true };
    });
    render(<CareerInterview />);
    await openTab('复盘');
    expect(await screen.findByText('数字的口径')).toBeInTheDocument();
    expect(screen.getByText('追到第 2 层卡住：没说统计周期')).toBeInTheDocument();
    expect(screen.getByText('按工单工时算')).toBeInTheDocument();
    expect(screen.getByText('先核实：前后各四周的工时')).toBeInTheDocument();
    expect(screen.getByText('把口径写下来')).toBeInTheDocument();
  });

  it('新建记录调用 POST /api/career/interviews', async () => {
    mockGet(true);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, interview: { id: 'i9' } });
    render(<CareerInterview />);
    await openTab('复盘');
    expect(screen.getByText('还没有面试记录')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '补记一场' }));
    fireEvent.change(screen.getByLabelText('公司'), { target: { value: '戊公司' } });
    fireEvent.click(screen.getByRole('button', { name: '轮次' }));
    fireEvent.click(screen.getByRole('button', { name: '终面' }));
    fireEvent.change(screen.getByLabelText('标签（逗号分隔）'), { target: { value: '系统设计, 项目' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(apiPostJson).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/career/interviews');
    expect(body).toMatchObject({ company_name: '戊公司', round: 'final', result: 'none', result_source: 'none' });
    expect(JSON.parse(body.tags_json as string)).toEqual(['系统设计', '项目']);
  });

  it('我约了一场面试：电话约的也能记，时间按本地时间转成 ISO 发给 /interviews/book', async () => {
    mockGet(true);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, application_id: 'a1', interview_id: 'i9', deadline_id: 'd1' });
    render(<CareerInterview />);
    await openTab('复盘');
    fireEvent.click(screen.getByRole('button', { name: '我约了一场面试' }));
    fireEvent.change(screen.getByPlaceholderText('如 百度'), { target: { value: '小红书' } });
    fireEvent.change(screen.getByLabelText('面试时间'), { target: { value: '2026-11-04T15:00' } });
    fireEvent.click(screen.getByRole('button', { name: '记下来' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(apiPostJson).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/career/interviews/book');
    expect(body).toMatchObject({ company_name: '小红书', round: '一面', when: new Date('2026-11-04T15:00').toISOString() });
  });

  it('说几句就在这一页复盘，不绕到对话', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, interview: interviews[1] });
    const chat = captureChat();
    render(<CareerInterview />);
    fireEvent.click(await screen.findByText('丁公司 · 算法工程师'));
    fireEvent.change(screen.getByLabelText('说几句复盘'), { target: { value: '被问了为什么转算法，答得有点虚' } });
    fireEvent.click(screen.getByRole('button', { name: '开始复盘' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/interviews/i2/retro', { words: '被问了为什么转算法，答得有点虚' }));
    chat.off();
    expect(chat.said).toHaveLength(0);
  });

  it('传一段录音，base64 发到这场面试的 recordings', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, recording: { id: 'r1', interview_id: 'i1', name: '一面.m4a', mime: 'audio/mp4', size: 5, status: 'awaiting_asr', uploaded_at: '2026-11-06' } });
    render(<CareerInterview />);
    fireEvent.click(await screen.findByRole('button', { name: '传录音' }));
    const file = new File(['audio'], '一面.m4a', { type: 'audio/mp4' });
    fireEvent.change(screen.getByLabelText('选择录音文件'), { target: { files: [file] } });
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(apiPostJson).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/career/interviews/i1/recordings');
    expect(body).toMatchObject({ name: '一面.m4a', mime: 'audio/mp4', data: Buffer.from('audio').toString('base64') });
  });
});

describe('准备哪一场', () => {
  const upcoming: Interview = { ...interviews[1], id: 'i3', application_id: 'a1', company_name: '甲公司', round: 'second', date: '2026-11-07T06:00:00.000Z' };
  const today: Interview = { ...upcoming, id: 'i4', date: '2026-11-05' };
  const apps = dossiers as unknown as DossierSummary[];

  it('还没面的排最前（当天的也算），同一份投递不重复列；没有面试就列投过的岗位', () => {
    const targets = buildPrepTargets([interviews[0], upcoming], apps, NOW);
    expect(targets.map(target => target.key)).toEqual(['itv:i3']);
    expect(targets[0]).toMatchObject({ label: '甲公司 · 二面 · 11 月 7 日', round: 'second', refs: { interview_id: 'i3', application_id: 'a1', job_id: 'j1' } });
    expect(buildPrepTargets([today], apps, NOW)[0].key).toBe('itv:i4');
    expect(buildPrepTargets([], apps, NOW).map(target => target.key)).toEqual(['app:a1']);
  });

  it('一进来先看哪页：有马上要面的看准备；只有面完没复盘的看复盘', () => {
    expect(suggestedTab([interviews[1], upcoming], NOW)).toBe('prep');
    expect(suggestedTab([interviews[1]], NOW)).toBe('retro');
    expect(suggestedTab([interviews[0]], NOW)).toBe('prep');
    expect(suggestedTab([], NOW)).toBe('prep');
  });
});
