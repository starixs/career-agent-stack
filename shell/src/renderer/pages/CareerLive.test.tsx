import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

// 直播流用桩：暴露一个 push() 让测试往页面里灌事件
const live = vi.hoisted(() => ({ handler: null as null | ((ev: unknown) => void), status: 'open' as const }));
vi.mock('@/components/career/useGlobalLive', () => ({
  useLiveStream: (_frames: boolean, onEvent: (ev: unknown) => void) => { live.handler = onEvent; return { status: live.status, detail: null }; },
  globalBaseUrl: async () => '',
}));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { CAREER_NAVIGATE_EVENT } from '@/features/career-shell/navModel';
import CareerLive from './CareerLive';
import { applicationStats, hasBatchWork } from './CareerLiveModel';

const push = (ev: unknown) => { live.handler?.(ev); };
const snapshot = { type: 'snapshot', ts: 1, productSessionId: 's', browser: { hasBrowser: true, control: 'agent', reason: null, url: 'https://x.com/apply', title: '网申', channel: 'chrome' }, batch: { status: 'running', updatedAt: '', done: 2, failed: 0, handoffs: 1, queued: 3, todayCount: 2, phase: 'driving', message: '正在填写：B 公司 算法实习生', currentTitle: 'B 公司 算法实习生' }, openHandoffs: 1 };

describe('CareerLive', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset(); vi.mocked(apiPostJson).mockReset();
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, openHandoffs: 1 });
    live.handler = null;
  });

  it('渲染快照、批量进度与帧；接管 / 交回调用 Global 现场控制接口', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, control: { control: 'human' } });
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot);
    expect(await screen.findByText('正在填写：B 公司 算法实习生')).toBeInTheDocument();
    expect(screen.queryByText(/已填好 2 · 失败 0/)).not.toBeInTheDocument();
    expect(screen.getByText('正在填写：B 公司 算法实习生')).toBeInTheDocument();
    expect(screen.getByText('助理在操作')).toBeInTheDocument();
    push({ type: 'frame', data: 'QUJD', width: 1280, height: 800, ts: 2 });
    await waitFor(() => expect(screen.getByAltText('浏览器实时画面')).toHaveAttribute('src', 'data:image/jpeg;base64,QUJD'));
    fireEvent.click(screen.getByRole('button', { name: '接管' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/control', { control: 'human', reason: 'user_request' }));
    expect(await screen.findByRole('button', { name: '交回，继续' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '交回，继续' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/control', { control: 'agent', reason: undefined }));
  });

  it('批量控制：暂停 / 停止 / 开始 调用 batch 命令接口；接管事件显示用户该做什么', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, batch: { ...snapshot.batch, status: 'paused' } });
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot);
    fireEvent.click(await screen.findByRole('button', { name: '暂停' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/batch/command', { cmd: 'pause' }));
    expect(await screen.findByRole('button', { name: '开始 / 继续' })).toBeInTheDocument();
    push({ type: 'career:takeover', ts: 3, runId: 'run_1', state: 'paused', reason: 'captcha', message: '请拖动滑块完成验证，然后点"交还"继续' });
    expect(await screen.findByRole('status')).toHaveTextContent('请拖动滑块');
    expect(screen.getByText(/等你处理：/)).toBeInTheDocument();
  });

  it('投递总览按真实申请状态统计，已结束或未投递不混入成功数', () => {
    expect(applicationStats([
      { stage: 'evaluated' }, { stage: 'needs_user' }, { stage: 'applied' },
      { stage: 'rejected' }, { stage: 'discarded' }, { stage: 'skip' },
    ] as never, 1)).toEqual({ total: 6, active: 1, waiting: 1, submitted: 2, closed: 2 });
  });
  it('还在填的（pending）算进行中，不算已投出；已投出与服务端 SENT 同口径', () => {
    expect(applicationStats([
      { stage: 'pending' }, { stage: 'applied' }, { stage: 'responded' }, { stage: 'interview' },
      { stage: 'offer' }, { stage: 'hired' }, { stage: 'rejected' },
    ] as never)).toMatchObject({ total: 7, active: 1, submitted: 6 });
  });

  it('hasBatchWork：在跑 / 暂停 / 还排着才算有在投的', () => {
    const base = { status: 'idle', updatedAt: '', done: 0, failed: 0, handoffs: 0, queued: 0, todayCount: 0 } as const;
    expect(hasBatchWork(null)).toBe(false);
    expect(hasBatchWork({ ...base })).toBe(false);
    expect(hasBatchWork({ ...base, queued: 2 })).toBe(true);
    expect(hasBatchWork({ ...base, status: 'paused' })).toBe(true);
  });

  it('没有在投的：不给「开始 / 继续」，给「去挑一批」：回对话、让小芽放一张勾选表', async () => {
    const nav: unknown[] = [];
    const off = onEvent(CAREER_NAVIGATE_EVENT, p => nav.push(p));
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push({ ...snapshot, batch: { ...snapshot.batch, status: 'idle', queued: 0, lastError: 'Error: driver timeout' } });
    expect(await screen.findByText('现在没有在投的。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始 / 继续' })).toBeNull();
    expect(screen.queryByText(/driver timeout/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '去挑一批' }));
    expect(nav).toEqual([{ kind: 'chat' }]);
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/jobs/propose', {}));
    off();
  });

  it('批量出过错：只给一句人话，不露原始错误', async () => {
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push({ ...snapshot, batch: { ...snapshot.batch, lastError: 'TypeError: cannot read x' } });
    expect(await screen.findByText('上一批有一家没填成，我会再试')).toBeInTheDocument();
    expect(screen.queryByText(/TypeError/)).toBeNull();
  });

  it('邮件申请也在这页：带「邮件」小签；选中时画面的位置换成它的邮件往来，回到画面再换回来', async () => {
    const mailApp = { id: 'app_jd', job_id: 'j1', resume_tailored_id: 'r1', stage: 'responded', next_action: null, next_action_due: null, blocker_reason: null,
      retry_strategy: null, submission_evidence: 'mail:mm_out', answers_used_json: '[]', page_url: null, created_at: '', updated_at: '2026-11-05T00:00:00.000Z',
      title: '用户运营实习生', company_name: '京东', apply_email: 'jdcampus@jd.example' };
    const webApp = { ...mailApp, id: 'app_web', submission_evidence: null, apply_email: null, company_name: '小鹏' };
    const waitingApp = { ...mailApp, id: 'app_mt', stage: 'pending', submission_evidence: null, company_name: '美团', title: '产品运营实习生' };
    const ask = { id: 'mail_m_mt', kind: 'review', title: '美团 · 邮件写好了', application_ids: ['app_mt'], companies: [{ company_id: null, name: '美团' }],
      sources: [{ type: 'action', id: 'm_mt' }], due_at: null, overdue: false, mail: { purpose: 'apply', action_ids: ['m_mt'] } };
    const thread = { application_id: 'app_jd', company: '京东', role: '用户运营实习生', items: [
      { id: 'o1', direction: 'out', purpose: 'apply', counterpart: 'jdcampus@jd.example', subject: '周子航-北邮-用户运营', body: '您好', attachments: [], at: '2026-10-29T02:00:00.000Z', action_id: null, kind: null },
      { id: 'i1', direction: 'in', purpose: null, counterpart: '王莉 <wangli@jd.example>', subject: 'Re', body: '想确认到岗时间', attachments: [], at: '2026-11-05T02:00:00.000Z', action_id: null, kind: null },
    ] };
    vi.mocked(apiGetJson).mockImplementation(async (url: string) => {
      if (url === '/api/career/applications') return { ok: true, applications: [mailApp, webApp, waitingApp] };
      if (url.startsWith('/api/career/asks')) return { ok: true, asks: [ask], run: null };
      if (url.startsWith('/api/career/mail-apply/thread')) return { ok: true, thread };
      return { ok: true, openHandoffs: 0 };
    });
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot);
    const list = await screen.findByRole('list', { name: '邮件投递' });
    expect(list).toHaveTextContent('邮件');
    expect(list).not.toHaveTextContent('小鹏');
    // 等你条上有邮件等他的那份：状态字「等你过目」，钢笔蓝；只请求一次 asks，不逐份取往来
    const waitingState = await within(screen.getByRole('button', { name: /美团 · 产品运营实习生/ })).findByText('等你过目');
    expect(waitingState).toHaveClass('is-ask');
    expect(within(screen.getByRole('button', { name: /京东 · 用户运营实习生/ })).getByText('已发出')).not.toHaveClass('is-ask');
    expect(vi.mocked(apiGetJson).mock.calls.filter(([u]) => String(u).startsWith('/api/career/mail-apply/thread'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /京东 · 用户运营实习生/ }));
    const pane = await screen.findByTestId('mail-live-pane');
    expect(await screen.findByTestId('mail-thread')).toHaveTextContent('想确认到岗时间');
    expect(pane).toHaveTextContent('已发出');
    expect(apiGetJson).toHaveBeenCalledWith('/api/career/mail-apply/thread?application_id=app_jd');
    fireEvent.click(screen.getByRole('button', { name: '回到画面' }));
    expect(screen.queryByTestId('mail-live-pane')).toBeNull();
  });

  it('没有浏览器时给出引导文案，不显示批量噪声', async () => {
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push({ ...snapshot, browser: { ...snapshot.browser, hasBrowser: false, control: 'none' }, batch: null });
    expect(await screen.findByText(/浏览器还没有打开/)).toBeInTheDocument();
    expect(screen.queryByText(/批量：/)).not.toBeInTheDocument();
  });
});
