/**
 * 邮件投递工作台（2026-11-06）：已确认的几样搬到自己的一页——开始条、「N 封邮件写好了」、选中那份的四步路 + 整封邮件 / 往来、右边一列。
 * 还没有自己的邮件申请时主区只摆一张预设的「邮件写好了」（同卡组单封的版式，按钮不可点，不写「示例」）。数据按合同造（boardFixtures.ts），接口用 apiFetch 替身。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { CAREER_NAVIGATE_EVENT } from '@/features/career-shell/navModel';

import type { MailBoardView } from '../../shared/careerMailApply';
import type { AskView } from '@/components/career/delivery/deliveryApi';
import {
  boardRow, EMPTY_BOARD, FULL_BOARD, READY_ROWS, SENT_ROWS, SETUP, WAITING_DRAFTS, WAITING_ROWS,
} from '@/components/career/mail-apply/boardFixtures';
import { failedMailAsk, FOLLOWUPS, mailAsk, SINGLE } from '@/components/career/mail-apply/testFixtures';
import CareerMailApply from './CareerMailApply';

const REVIEW = '/api/career/actions/review';
const FAILED = failedMailAsk({ stage: 'send', reauth: true }, ['m_hw']);

function serve(board: MailBoardView, asks: AskView[] = [FAILED]) {
  vi.mocked(apiGetJson).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/career/mail-apply/board')) return { ok: true, board };
    if (url.startsWith('/api/career/mail-apply/drafts')) {
      const ids = decodeURIComponent(url.split('ids=')[1] ?? '').split(',');
      return { ok: true, drafts: [...WAITING_DRAFTS, ...FOLLOWUPS].filter(d => ids.includes(d.action_id)) };
    }
    if (url.startsWith('/api/career/asks')) return { ok: true, asks, run: null };
    if (url.startsWith('/api/career/mail-apply/thread')) return { ok: true, thread: { application_id: 's_zj', company: '字节跳动', role: '产品经理实习生', items: [
      { id: 'o', direction: 'out', purpose: 'apply', counterpart: 'campus@zj.example', subject: '投递', body: '您好', attachments: [], at: '2026-11-05T02:00:00.000Z', action_id: null, kind: null },
    ] } };
    return { ok: true };
  });
}

const side = () => screen.getByRole('list', { name: '邮件申请' });
const pane = () => screen.getByTestId('mail-pane');

beforeEach(() => {
  vi.mocked(apiGetJson).mockReset();
  vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true });
});

describe('第一次打开：只摆一张预设的「邮件写好了」，不给空白页', () => {
  it('主区是卡组单封那一张：公司海报 + 标题 + 整封邮件 + 发出 / 不投这家（都点不了）；没有右边一列、没有四步路、没有「示例」', async () => {
    serve(EMPTY_BOARD, []);
    render(<CareerMailApply />);
    const card = await screen.findByTestId('mail-preset');
    expect(within(card).getByRole('heading')).toHaveTextContent('星河科技 · 邮件写好了');
    expect(within(card).getByTestId('company-poster')).toBeInTheDocument();
    expect(within(card).getByLabelText('正文')).toBeDisabled();
    expect(within(card).getByRole('button', { name: '发出' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: '不投这家' })).toBeDisabled();
    expect(screen.queryByRole('list', { name: '邮件申请' })).toBeNull();
    expect(screen.queryByRole('list', { name: '走到哪一步' })).toBeNull();
    expect(screen.queryByText(/示例/)).toBeNull();
    // 开始条照常能用
    expect(screen.getByLabelText('贴一段写着投递邮箱的岗位')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: '发出' }));
    expect(apiPostJson).not.toHaveBeenCalled();
  });

  it('有了第一份真的，预设那一张整块消失', async () => {
    serve({ ...FULL_BOARD, rows: SENT_ROWS }, []);
    render(<CareerMailApply />);
    expect(await within(await screen.findByRole('list', { name: '邮件申请' })).findByText('字节跳动')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-preset')).toBeNull();
    expect(screen.queryByText('星河科技')).toBeNull();
  });
});

describe('有几封在等他', () => {
  it('主区顶上是和卡组里同一张「N 封邮件写好了」；右边一列等他过目的排最前、公司名钢笔蓝', async () => {
    serve(FULL_BOARD, [mailAsk([SINGLE]), FAILED]);
    render(<CareerMailApply />);
    expect(await screen.findByTestId('ask-card-mail')).toHaveTextContent('美团 · 邮件写好了');
    const lines = within(side()).getAllByRole('listitem');
    expect(lines.slice(0, WAITING_ROWS.length).every(li => li.classList.contains('is-waiting'))).toBe(true);
    // 默认看的那份不是表里已经摊开的那封
    expect(within(pane()).getByRole('heading')).toHaveTextContent('京东');
  });

  it('选中投递那封：整封邮件和两个按钮就在主区，点「发出」就是批准这一封', async () => {
    serve(FULL_BOARD, [FAILED]);
    render(<CareerMailApply />);
    fireEvent.click(within(await screen.findByTestId('mail-line-a_mt')).getByRole('button'));
    fireEvent.click(await within(pane()).findByRole('button', { name: '发出' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(REVIEW, { ids: ['m_mt'], decision: 'approved' }));
  });

  it('被退回那封：收件人标红，「改好了，重发」不可点；没发出去那件是失败卡「重新连邮箱」', async () => {
    serve(FULL_BOARD, [FAILED]);
    render(<CareerMailApply />);
    fireEvent.click(within(await screen.findByTestId('mail-line-a_bo')).getByRole('button'));
    expect(await within(pane()).findByRole('button', { name: '改好了，重发' })).toBeDisabled();
    expect(within(pane()).getByLabelText('收件人')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(within(screen.getByTestId('mail-line-a_hw')).getByRole('button'));
    expect(await within(pane()).findByRole('button', { name: '重新连邮箱' })).toBeInTheDocument();
  });

  it('选中一份已发出的：四步路走完，下面是邮件往来', async () => {
    serve({ ...FULL_BOARD, rows: SENT_ROWS }, []);
    render(<CareerMailApply />);
    expect(await within(await screen.findByTestId('mail-pane')).findByTestId('mail-thread')).toBeInTheDocument();
    expect(within(pane()).getAllByRole('listitem').filter(li => li.classList.contains('on'))).toHaveLength(4);
  });
});

describe('开始条', () => {
  it('收着时是勾上那几家的公司小签；点开一家公司默认只勾一个岗；「写这 N 封」开始写', async () => {
    serve({ ...FULL_BOARD, rows: READY_ROWS }, []);
    render(<CareerMailApply />);
    const toggle = await screen.findByRole('button', { name: '选岗位：已勾 3 家' });
    expect(within(toggle).getAllByTestId('company-poster')).toHaveLength(3);
    fireEvent.click(toggle);
    expect(screen.getByRole('checkbox', { name: '选 阿里巴巴 产品运营实习生' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选 阿里巴巴 数据运营实习生' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '写这 3 封' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/jobs/apply', { job_ids: ['job_r_xhs', 'job_r_dw', 'job_r_al'] }));
  });

  it('贴进来：没有明写投递邮箱就在框下面说；成功就加进去并勾上', async () => {
    const pasted = boardRow({ key: 'r_new', co: '小米', role: '产品实习生', station: 'ready' });
    serve({ ...FULL_BOARD, rows: READY_ROWS }, []);
    vi.mocked(apiPostJson).mockRejectedValueOnce(new Error('这段里没找到投递邮箱'));
    render(<CareerMailApply />);
    const box = await screen.findByLabelText('贴一段写着投递邮箱的岗位');
    fireEvent.change(box, { target: { value: '有问题可联系 hr@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: '加进来' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('这段里没找到投递邮箱');
    serve({ ...FULL_BOARD, rows: [pasted, ...READY_ROWS] }, []);
    vi.mocked(apiPostJson).mockResolvedValueOnce({ ok: true, row: pasted });
    fireEvent.change(box, { target: { value: '简历发送至 hr@mi.com' } });
    fireEvent.click(screen.getByRole('button', { name: '加进来' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail-apply/jobs', { text: '简历发送至 hr@mi.com' }));
    expect(await screen.findByRole('button', { name: '选岗位：已勾 4 家' })).toBeInTheDocument();
  });

  it('还没有简历：主按钮是「先放一份简历」，点了去简历那一页', async () => {
    serve({ rows: READY_ROWS, setup: { ...SETUP, has_resume: false } }, []);
    const nav: unknown[] = [];
    const off = onEvent(CAREER_NAVIGATE_EVENT, p => nav.push(p));
    render(<CareerMailApply />);
    fireEvent.click(await screen.findByRole('button', { name: '先放一份简历' }));
    expect(nav).toEqual([{ kind: 'career-material', view: 'resume' }]);
    expect(screen.queryByRole('button', { name: /写这/ })).toBeNull();
    off();
  });
});
