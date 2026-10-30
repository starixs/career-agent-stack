/**
 * 投递切面前端（世界模型 §7.1 情景 B、C）：等你条、卡组、批次卡、回来卡按服务端数据渲染，处理按源落库。
 * 数据形状同服务端 /api/career/asks · away（服务端测试见 server/career/delivery-slice.unit.test.ts）。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';

import { applicationTrack } from './applicationTrack';
import { dueText, whenText } from './askText';
import { BatchWall } from './BatchWall';
import type { AskView, AwayView, CompanyMark, RunView } from './deliveryApi';
import { OPEN_DECK_EVENT, ReturnCard, spanText } from './ReturnCard';
import { WaitingDock } from './WaitingDock';

const mark = (name: string, logo?: string, fill?: string): CompanyMark => ({ company_id: null, name, ...(logo ? { logo } : {}), ...(fill ? { fill } : {}) });
const NOW = new Date('2026-10-28T10:30:00+08:00');
const WIDE = ['DeepSeek', '中兴通讯', '中电福富', '元戎启行', '字节跳动', '拼多多', '摩尔线程', '智元', '科大讯飞', '理想汽车', '腾讯混元', '阿里巴巴', '荣耀', '长飞', '联发科技', '大疆', '普渡机器人'];

function run(done: number, over: Partial<RunView> = {}): RunView {
  const items = [...['美团', '京东', '华为'].map((c, i) => ({ application_id: `t${i}`, job_id: `jt${i}`, role: 'AI应用开发', company: mark(c, c === '美团' ? 'mt' : undefined, c === '美团' ? '#ffd100' : undefined), star: true, state: 'wait' as const })),
    ...WIDE.map((c, i) => ({ application_id: `w${i}`, job_id: `jw${i}`, role: '算法类', company: mark(c), star: false, state: (i < done ? 'done' : 'wait') as 'done' | 'wait' }))];
  return { total: 20, done, running: 0, asking: 0, failed: 0, items, ...over };
}

const ASK_INFO: AskView = {
  id: 'hnd_1', kind: 'info', title: '证件号码', application_ids: Array.from({ length: 20 }, (_, i) => `a${i}`),
  companies: WIDE.map(c => mark(c)), sources: Array.from({ length: 20 }, (_, i) => ({ type: 'handoff' as const, id: `hnd_${i + 1}` })),
  action_ids: Array.from({ length: 20 }, (_, i) => `act_${i}`), due_at: null, overdue: false,
  fields: [{ label: '证件号码', vault_field: 'idNumber', sensitive: true, fillable: true }],
};
const ASK_LOGIN: AskView = { id: 'hnd_login', kind: 'login', title: '2 个网站要你登录', application_ids: ['m1', 'm2'], companies: [mark('摩尔线程'), mark('智元')], sources: [{ type: 'handoff', id: 'hnd_login' }, { type: 'handoff', id: 'hnd_l2' }], due_at: null, overdue: false };
const ASK_JFY: AskView = {
  id: 'ddl_jfy', kind: 'deadline', title: '九方云 · 在线测评', application_ids: ['j1'], companies: [mark('九方云')], sources: [{ type: 'deadline', id: 'ddl_jfy' }],
  due_at: '2026-10-29T15:59:00.000Z', overdue: false, deadline_kind: 'assessment', source: { inbox_item_id: 'inb1', received_at: '2026-10-28T02:28:00.000Z' },
};

function serve(asks: AskView[], r: RunView | null) {
  vi.mocked(apiGetJson).mockImplementation(async (url: string) => (url.startsWith('/api/career/asks') ? { ok: true, asks, run: r } : { ok: true }));
}

describe('情景 B · 关键期的周二：等你条与卡组', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(apiPutJson).mockReset().mockResolvedValue({ ok: true, item: {} });
  });

  it('没有要你的事、这批在投：等你条只写「没有要你的事」和「投出 0 / 20」', async () => {
    serve([], run(0));
    render(<WaitingDock />);
    expect(await screen.findByText('投出 0 / 20')).toBeInTheDocument();
    expect(screen.getByText('没有要你的事')).toBeInTheDocument();
  });

  it('什么都没有：整条不出现', async () => {
    serve([], null);
    render(<WaitingDock />);
    await waitFor(() => expect(apiGetJson).toHaveBeenCalled());
    expect(screen.queryByTestId('waiting-dock')).toBeNull();
  });

  it('等你 3：最急的期限写在条上；点开卡组一次一张，→ 切到下一张，Esc 收起后焦点回到等你条', async () => {
    serve([ASK_JFY, ASK_INFO, ASK_LOGIN], run(3));
    render(<WaitingDock />);
    const open = await screen.findByRole('button', { name: /等你\s*3/ });
    expect(open).toHaveTextContent(dueText(ASK_JFY)!);
    fireEvent.click(open);
    const deck = screen.getByTestId('waiting-deck');
    expect(within(deck).getByText('九方云 · 在线测评')).toBeInTheDocument();
    expect(within(deck).getByText(/来自邮件/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(within(screen.getByTestId('waiting-deck')).getByText('证件号码')).toBeInTheDocument();
    expect(screen.getByText('用于这批 20 家，只存在本机')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('waiting-deck')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /等你\s*3/ }));
  });

  it('证件号码填一次：服务端存进本机、整批交给后台接着填；不发话给助理，这件从卡组里拿走', async () => {
    serve([ASK_INFO, ASK_LOGIN], run(0));
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, saved: ['证件号码'], resumed: ASK_INFO.action_ids, still_waiting: 0 });
    const sent: unknown[] = [];
    const off = onEvent('career:chat-suggest', p => { sent.push(p); });
    render(<WaitingDock />);
    fireEvent.click(await screen.findByRole('button', { name: /等你\s*2/ }));
    const go = screen.getByRole('button', { name: '填好' });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('证件号码'), { target: { value: '110101200001011234' } });
    serve([ASK_LOGIN], run(0));
    fireEvent.click(go);
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/asks/hnd_1/fill', { values: { 证件号码: '110101200001011234' } }));
    await waitFor(() => expect(within(screen.getByTestId('waiting-deck')).getByText('2 个网站要你登录')).toBeInTheDocument());
    expect(sent).toEqual([]);
    expect(apiPutJson).not.toHaveBeenCalled();
    off();
  });

  it('海投填好的几家合成一件：点「一键投出」一次批准全部提交', async () => {
    const all: AskView = { id: 'act_s1', kind: 'review', title: '3 家填好了', detail: '必填都填好并核对过，没有要你看的项', application_ids: ['a1', 'a2', 'a3'],
      companies: [mark('DeepSeek'), mark('中兴通讯'), mark('大疆')], sources: ['act_s1', 'act_s2', 'act_s3'].map(id => ({ type: 'action' as const, id })),
      due_at: null, overdue: false, review: { required_filled: null, required_total: null, gaps: 0 } };
    serve([all], null);
    render(<WaitingDock />);
    fireEvent.click(await screen.findByRole('button', { name: /等你\s*1/ }));
    expect(screen.getByText('投出后撤不回')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '一键投出' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', expect.objectContaining({ ids: ['act_s1', 'act_s2', 'act_s3'], decision: 'approved' })));
  });

  it('「N 个网站要你登录」点「去登录」：开始登录之旅（服务端一家一家带你过）并打开旁边的浏览器现场', async () => {
    serve([ASK_LOGIN], null);
    render(<WaitingDock />);
    fireEvent.click(await screen.findByRole('button', { name: /等你\s*1/ }));
    expect(screen.getByText('一家一家带你过，登上了自动切下一家')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去登录' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/asks/hnd_login/login-journey', {}));
  });

  it('「晚点」只是挪到最后（登录的顺带停下登录之旅），不落库', async () => {
    serve([ASK_LOGIN, ASK_INFO], null);
    render(<WaitingDock />);
    fireEvent.click(await screen.findByRole('button', { name: /等你\s*2/ }));
    fireEvent.click(screen.getByRole('button', { name: '晚点' }));
    await waitFor(() => expect(within(screen.getByTestId('waiting-deck')).getByText('证件号码')).toBeInTheDocument());
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/asks/hnd_login/login-journey', { cancel: true });
    expect(apiPutJson).not.toHaveBeenCalled();
  });

  it('批次卡：标星的 3 家中海报在前，其余小海报成格；美团铺品牌色；悬停排队的可以说「这家我要看」', () => {
    const onWatch = vi.fn();
    render(<BatchWall run={run(10, { asking: 3 })} onWatch={onWatch} />);
    expect(screen.getByText('投 20 家')).toBeInTheDocument();
    expect(screen.getByText('3 等你')).toBeInTheDocument();
    const posters = screen.getAllByTestId('company-poster');
    expect(posters[0]).toHaveClass('cd-p-md', 'cd-p-fill');
    expect(posters[3]).toHaveClass('cd-p-sm');
    expect(posters[3]).toHaveAttribute('data-state', 'done');
    fireEvent.click(screen.getAllByRole('button', { name: '这家我要看' })[0]);
    expect(onWatch).toHaveBeenCalledWith('jw10');
  });
});

describe('情景 C · 两天没开，回来', () => {
  const AWAY: AwayView = {
    since: '2026-10-28T13:00:00.000Z', asks: [{ ...ASK_JFY, due_at: '2026-10-30T15:59:00.000Z' }, ASK_LOGIN],
    sent: [mark('美团', 'mt', '#ffd100'), mark('京东', 'jd')],
    replies: [{ kind: 'interview', label: '面试邀请', n: 1, companies: [mark('百度')] }, { kind: 'exam', label: '笔试 / 测评', n: 2, companies: [mark('九方云'), mark('讯飞', 'xf')] }, { kind: 'rejection', label: '不合适', n: 2, companies: [mark('拼多多'), mark('京东')] }],
    quiet: 13,
  };

  it('最急的一件放最大，点「从最急的开始」打开卡组并定位到它；下面几行只给数字和公司；末尾一句没回音的', () => {
    const opened: string[] = [];
    const off = onEvent<{ id: string }>(OPEN_DECK_EVENT, p => opened.push(p.id));
    render(<ReturnCard away={AWAY} onStart={id => emitEvent(OPEN_DECK_EVENT, { id })} />);
    const card = screen.getByTestId('return-card');
    expect(within(card).getByRole('heading', { name: '九方云 · 在线测评' })).toBeInTheDocument();
    expect(card).toHaveTextContent('还有 1 件等你');
    expect(card).toHaveTextContent('面试邀请');
    expect(card).toHaveTextContent('其余 13 家还没回音。');
    fireEvent.click(screen.getByRole('button', { name: '从最急的开始' }));
    expect(opened).toEqual(['ddl_jfy']);
    off();
  });

  it('回来卡发出的「从最急的开始」：等你条打开卡组并停在那件', async () => {
    serve([ASK_LOGIN, ASK_JFY], null);
    render(<WaitingDock />);
    await screen.findByRole('button', { name: /等你\s*2/ });
    act(() => emitEvent(OPEN_DECK_EVENT, { id: 'ddl_jfy' }));
    expect(within(screen.getByTestId('waiting-deck')).getByText('九方云 · 在线测评')).toBeInTheDocument();
  });

  it('没有要你的事：只说一句', () => {
    render(<ReturnCard away={{ ...AWAY, asks: [], sent: [], replies: [], quiet: 5 }} />);
    expect(screen.getByText('没有要你做的事')).toBeInTheDocument();
  });
});

describe('字和路', () => {
  it('期限措辞：今晚 / 明天 / 周几；面试不说截止；没有自己期限的写网申截止', () => {
    expect(whenText('2026-10-28T23:59:00+08:00', NOW)).toBe('今晚 23:59');
    expect(whenText('2026-10-29T18:00:00+08:00', NOW)).toBe('明天 18:00');
    expect(dueText({ ...ASK_JFY, due_at: '2026-11-01T14:00:00+08:00', deadline_kind: 'interview' }, NOW)).toBe('周日 14:00');
    expect(dueText({ ...ASK_INFO, due_at: '2026-10-29T15:59:00+08:00' }, NOW)).toBe('网申 明天 15:59 截止');
    expect(spanText('2026-10-28T13:00:00.000Z', Date.parse('2026-10-30T10:00:00.000Z'))).toBe('2 天');
  });

  it('申请对象卡上的路：投出（墨）→ 面试邀请等你确认（蓝）→ 没到的灰', () => {
    const ask: AskView = { ...ASK_JFY, id: 'd2', kind: 'deadline', title: '京东 · 一面', deadline_kind: 'interview', sources: [{ type: 'deadline', id: 'd2' }] };
    const track = applicationTrack({
      application: { stage: 'interview' } as never,
      history: [{ from_stage: 'approved', to_stage: 'applied', note: null, created_at: '2026-10-27T02:00:00.000Z' }],
      deadlines: [{ id: 'd2', kind: 'interview', title: '京东 · AI 一面', due_at: '2026-10-31T06:00:00.000Z', status: 'open' } as never],
    }, [ask], NOW);
    expect(track.map(n => [n.label, !!n.on, !!n.ask])).toEqual([['投出', true, false], ['一面', false, true]]);
  });
});
