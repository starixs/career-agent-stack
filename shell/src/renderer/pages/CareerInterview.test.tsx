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

  it('第一次打开（什么都还没有）：准备、复盘、题库三页都用示例把做出来的样子摆出来，示例上的动作点不了', async () => {
    mockGet(true);
    render(<CareerInterview />);
    // 准备：真的「帮我准备面试」能点；下面是示例那一场的面试票和三步
    expect(await screen.findByRole('button', { name: '帮我准备面试' })).toBeEnabled();
    let sample = screen.getByTestId('sample');
    expect(within(sample).getByText('示例')).toBeInTheDocument();
    expect(within(sample).getByRole('button', { name: '帮我准备这一场' })).toBeDisabled();
    expect(within(sample).getAllByRole('button', { name: '练这一句' })[0]).toBeDisabled();
    fireEvent.click(within(sample).getByRole('tab', { name: /模拟一场/ }));
    expect(within(sample).getByRole('button', { name: '开始模拟' })).toBeDisabled();
    // 复盘：示例那一场的复盘，「按这些点练」点不了
    await openTab('复盘');
    sample = screen.getByTestId('sample');
    expect(within(sample).getByRole('heading', { name: /星河科技/ })).toBeInTheDocument();
    expect(within(sample).getByRole('button', { name: '按这些点练' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '补记一场' })).toBeEnabled();
    // 题库：示例的几道题，开始练和删除点不了，也不去读作答记录
    await openTab('题库');
    sample = await screen.findByTestId('sample');
    expect(within(sample).getByRole('button', { name: '开始练' })).toBeDisabled();
    fireEvent.click(within(sample).getByRole('button', { name: /Redis 分布式锁/ }));
    expect(within(sample).getByRole('button', { name: '删除题目' })).toBeDisabled();
    expect(vi.mocked(apiGetJson).mock.calls.some(([path]) => String(path).includes('/attempts'))).toBe(false);
    expect(apiPostJson).not.toHaveBeenCalled();
  });

  it('有自己的预测和题时不出示例', async () => {
    mockGet();
    render(<CareerInterview />);
    await openTab('准备');
    await screen.findByRole('tablist', { name: '准备的三步' });
    expect(screen.queryByTestId('sample')).toBeNull();
  });

  it('面试票：公司和轮次、岗位；没约时间的投递不显示日期和倒计时', async () => {
    mockGet();
    render(<CareerInterview />);
    await openTab('准备');
    expect(await screen.findByText('甲公司')).toBeInTheDocument();
    expect(screen.getByText('后端开发')).toBeInTheDocument();
    expect(screen.queryByText(/还有 \d+ 天|就是今天/)).toBeNull();
  });

  it('三步各一块，块上是点阵不是数字；第一步默认摊开：左边是句子（风险只用颜色、深度是一组格子），右边是选中那句的追问阶梯', async () => {
    mockGet();
    const chat = captureChat();
    render(<CareerInterview />);
    await openTab('准备');
    const first = await screen.findByRole('tab', { name: '会被问什么：高风险 1 条' });
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(within(first).getByRole('img', { name: '2 条预测，高风险 1 条' })).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: '先练几道：练过 0 道，共 1 道' })).getByRole('img', { name: '1 道题，练过 0 道' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '模拟一场：上次有点悬' })).toBeInTheDocument();
    const section = screen.getByRole('tabpanel', { name: '会被问什么' });
    // 风险不写成字，也没有图例
    expect(within(section).queryByText(/高风险|中风险|低风险/)).toBeNull();
    const claims = within(within(section).getByRole('tablist', { name: '会被深挖的句子' })).getAllByRole('tab');
    expect(claims[0]).toHaveTextContent('P99 从 800ms 到 200ms 的具体手段');
    expect(claims[0]).toHaveAttribute('aria-selected', 'true');
    expect(within(claims[0]).getByRole('img', { name: '高风险，会追问 2 层' })).toBeInTheDocument();
    // 右边是风险最高那句的追问阶梯；点别的句子换成它的
    expect(within(within(section).getByRole('list', { name: '会怎么追问' })).getByText('怎么测的')).toBeInTheDocument();
    expect(within(section).queryByText('权限模型怎么设计')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: '练这一句' }));
    expect(chat.said[0]).toMatchObject({ text: '就简历里这句话深挖我：P99 从 800ms 到 200ms 的具体手段', context: { refs: { application_id: 'a1' } } });
    fireEvent.click(claims[1]);
    expect(within(section).getByText('权限模型怎么设计')).toBeInTheDocument();
    expect(within(section).queryByText('怎么测的')).toBeNull();
    chat.off();
  });

  it('准备的是哪一场，预测、出题、模拟就带着这份投递的 id 发进对话', async () => {
    mockGet();
    const chat = captureChat();
    render(<CareerInterview />);
    await openTab('准备');
    fireEvent.click(await screen.findByRole('button', { name: '帮我准备这一场' }));
    fireEvent.click(screen.getByRole('button', { name: '重新预测' }));
    fireEvent.click(screen.getByRole('tab', { name: /^先练几道/ }));
    fireEvent.click(screen.getByRole('button', { name: '出一组题' }));
    fireEvent.click(screen.getByRole('tab', { name: /^模拟一场/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始模拟' }));
    expect(chat.said.map(event => event.text)).toEqual([
      '帮我准备甲公司的面试', '预测一下甲公司面试会深挖我简历哪里', '按甲公司 · 后端开发出一组面试题', '开始模拟甲公司一面，先从高风险的深挖点问起',
    ]);
    for (const event of chat.said) expect(event.context?.refs).toMatchObject({ application_id: 'a1', job_id: 'j1' });
    expect(chat.said[3].context?.refs).toMatchObject({ round: 'first' });
    chat.off();
  });

  it('先练几道：不让人一道道挑，一个「开始练」带着这份投递发进对话；下面的题只看练到哪了（没练过的是空圈）', async () => {
    mockGet();
    const chat = captureChat();
    render(<CareerInterview />);
    await openTab('准备');
    fireEvent.click(await screen.findByRole('tab', { name: /^先练几道/ }));
    const section = screen.getByRole('tabpanel', { name: '先练几道' });
    const list = within(section).getByRole('list', { name: '这一场的题' });
    expect(within(list).getByText('讲讲限流怎么做')).toBeInTheDocument();
    expect(within(list).getByRole('img', { name: '没练过' })).toBeInTheDocument();
    expect(within(list).queryByRole('button')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: '开始练' }));
    expect(chat.said[0]).toMatchObject({ text: '用甲公司的面试题考我，先考没练过的和分数低的', context: { refs: { application_id: 'a1', job_id: 'j1' } } });
    chat.off();
  });

  it('模拟一场：每场一枚结论章；练完的点开看卡在第几层和可以怎么答，没练完的可以接着练', async () => {
    mockGet();
    const chat = captureChat();
    render(<CareerInterview />);
    await openTab('准备');
    fireEvent.click(await screen.findByRole('tab', { name: /^模拟一场/ }));
    const done = screen.getByRole('button', { name: /一面 · 大厂/ });
    expect(within(done).getByText('有点悬')).toBeInTheDocument();
    fireEvent.click(done);
    expect(screen.getByRole('img', { name: '追到第 3 层卡住' })).toBeInTheDocument();
    expect(screen.getByText('说不清哪些是自己拍板的')).toBeInTheDocument();
    // 面试官的看法是带人像的气泡；要先核实的事是便签里的空方框
    expect(screen.getByRole('img', { name: '面试官怎么想' })).toBeInTheDocument();
    expect(screen.getByLabelText('先核实：上线时间')).toBeInTheDocument();
    const unfinished = screen.getByRole('button', { name: /二面/ });
    expect(within(unfinished).getByText('没练完')).toBeInTheDocument();
    fireEvent.click(unfinished);
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
    // 结果是哪来的不占一行字：推测出来的章是虚线框，悬停看得到来源
    expect(screen.getByTitle('推测')).toBeInTheDocument();
    // 页面上不再铺原始过程记录和标签字段
    expect(screen.queryByText('问了限流的实现')).toBeNull();
  });

  it('复盘是两栏：左边是这一轮在看什么和提问逻辑，右边一问一答；点一个考察点只看它的题，「按这些点练」带着考察点发进对话', async () => {
    const retro = {
      focus_this_round: '数字的口径',
      questions: [
        { quote: '30% 是怎么统计的？', point: '数字的口径', answer: '运营反馈的', good: [], lacking: ['没有统计周期'], stuck_layer: 2, interviewer_doubt: { evidence: '没说统计周期', alternative: '' } },
        { quote: '缓存怎么不读到旧值？', point: '缓存一致性', answer: '更新后删缓存', good: ['讲到了删缓存'], lacking: [], stuck_layer: 0 },
      ],
      logic: [{ point: '数字的口径', why: '简历里的百分比都会被追问', review: '写下周期和基线' }, { point: '缓存一致性', why: '顺着项目问基础', review: '缓存更新策略' }],
      retakes: [{ question: '30% 是怎么统计的？', answer: '按工单工时算', needs_verification: ['前后各四周的工时'] }],
      todo: { facts: ['把口径写下来'], delivery: [] },
    };
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/career/interviews/')) return { ok: true, recordings: [] };
      if (path.startsWith('/api/career/interviews')) return { ok: true, interviews: [{ ...interviews[0], retro_json: JSON.stringify(retro) }] };
      return { ok: true };
    });
    const chat = captureChat();
    render(<CareerInterview />);
    await openTab('复盘');
    expect(await screen.findByRole('img', { name: '这一轮在看' })).toBeInTheDocument();
    const qa = screen.getByRole('list', { name: '一问一答' });
    expect(within(qa).getByText('30% 是怎么统计的？')).toBeInTheDocument();
    expect(within(qa).getAllByRole('note', { name: '我答' })[0]).toHaveTextContent('运营反馈的');
    expect(within(qa).getByRole('img', { name: '追到第 2 层卡住' })).toBeInTheDocument();
    expect(within(qa).getByRole('note', { name: '可以这样答' })).toHaveTextContent('按工单工时算');
    expect(within(qa).getByText('讲到了删缓存')).toBeInTheDocument();
    // 评价不挂「优点 / 不足」小标题，用勾和点区分
    expect(screen.queryByText(/优点|不足/)).toBeNull();
    fireEvent.click(within(screen.getByRole('list', { name: '提问逻辑' })).getByRole('button', { name: /缓存一致性/ }));
    expect(within(qa).queryByText('30% 是怎么统计的？')).toBeNull();
    expect(screen.getByText('把口径写下来')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '按这些点练' }));
    expect(chat.said[0]).toMatchObject({ text: '按丙公司这场面试的考察点（数字的口径、缓存一致性）出几道题考我，再找几篇相近的面经一起练', context: { refs: { interview_id: 'i1' } } });
    chat.off();
  });

  it('新建记录调用 POST /api/career/interviews', async () => {
    mockGet(true);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, interview: { id: 'i9' } });
    render(<CareerInterview />);
    await openTab('复盘');
    expect(within(screen.getByTestId('sample')).getByText('示例')).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: /^丁公司/ }));
    // 没有录音时才说几句：次要入口，点开才出输入框
    fireEvent.click(screen.getByRole('button', { name: '没有录音，说几句' }));
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
    // 这场已经复盘过，输入收着；点开是一块能拖录音进来的框
    fireEvent.click(await screen.findByRole('button', { name: '再补一段' }));
    expect(screen.getByRole('button', { name: '把面试录音拖进来' })).toBeInTheDocument();
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
