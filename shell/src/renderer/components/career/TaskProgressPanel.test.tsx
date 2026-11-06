import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

import type { LivePage } from './LivePageTabs';
import { TaskProgressPanel } from './TaskProgressPanel';

const didi: LivePage = { application_id: 'a_didi', company: '滴滴', title: '数据分析师', current: true, waiting: null };
const step = (message: string, phase = 'apply_batch', at = 1) => ({ message, phase, at });
const run = (steps: ReturnType<typeof step>[], extra: Partial<ProgressRun> = {}): ProgressRun => ({ key: 'run_fill', steps, progress: null, finished: false, updatedAt: 1, applicationId: 'a_didi', ...extra });
/** 流程线上每一步的样子。 */
const track = () => Array.from(screen.getByTestId('live-stage-track').querySelectorAll('li')).map(li => `${li.textContent}:${li.getAttribute('data-state')}`);

describe('网申现场画面下面：只讲选中的这一家走到哪一步（2026-11-05 滴滴投完还卡在进行中；2026-11-06 和顶上重叠）', () => {
  it('不再列一遍全部任务，也不重复公司和岗位', () => {
    render(<TaskProgressPanel page={didi} run={run([step('正在填「姓名」')])} batch={{ status: 'paused' } as never} />);
    expect(screen.queryByRole('list', { name: '并行网申任务' })).not.toBeInTheDocument();
    expect(screen.queryByText(/滴滴/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已暂停|进行中/)).not.toBeInTheDocument();
  });

  it('这一家还没轮到：流程一步都没走，说在排队，不拿别家的顶上', () => {
    render(<TaskProgressPanel page={didi} takeover={{ runId: 'run_other', state: 'paused', message: '还差 1 项要你补：请输入邮箱地址' }} />);
    expect(track()).toEqual(['打开网页:todo', '填写:todo', '你过目:todo', '投出:todo']);
    expect(screen.getByRole('status')).toHaveTextContent('这一家还在排队，轮到它就开始填');
  });

  it('停下等他登录：卡在第一步、是等他的样子，话说的是这一家要他做什么', () => {
    render(<TaskProgressPanel page={{ ...didi, waiting: 'login' }} run={run([step('请在浏览器里登录，登录成功后点交还')])} />);
    expect(track()).toEqual(['打开网页:you', '填写:todo', '你过目:todo', '投出:todo']);
    expect(screen.getByRole('status')).toHaveTextContent('请在浏览器里登录');
  });

  it('填好了等他投出：走到「你过目」；提交中走到「投出」；投出后四步都做完', () => {
    const filled = [step('正在填「姓名」'), step('必填 12/12 已填好，停在「提交」前', 'apply_batch_ready', 2)];
    const { rerender } = render(<TaskProgressPanel page={didi} run={run(filled, { finished: true, ready: true })} />);
    expect(track()).toEqual(['打开网页:done', '填写:done', '你过目:you', '投出:todo']);
    rerender(<TaskProgressPanel page={didi} run={run([...filled, step('正在提交网申', 'submit', 3)])} />);
    expect(track()).toEqual(['打开网页:done', '填写:done', '你过目:done', '投出:working']);
    rerender(<TaskProgressPanel page={didi} run={run([...filled, step('已投出', 'submit_done', 4)], { finished: true })} />);
    expect(track()).toEqual(['打开网页:done', '填写:done', '你过目:done', '投出:done']);
    expect(screen.getByRole('status')).toHaveTextContent('已投出');
  });

  it('最新一步写在上面那一行，下面只列它之前的几步，不重复', () => {
    render(<TaskProgressPanel page={didi} run={run([step('上传简历（PDF）'), step('正在填「姓名」', 'apply_batch', 2)])} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在填「姓名」');
    expect(screen.getByRole('list', { name: '刚做过的几步' })).toHaveTextContent('上传简历（PDF）');
    expect(screen.getAllByText('正在填「姓名」')).toHaveLength(1);
  });

  it('对话里随手打开网页看一眼不是一份网申：不画流程线，只说在做什么', () => {
    render(<TaskProgressPanel title="卓驭 2027 校招" run={run([step('打开卓驭校招首页', 'browse')], { applicationId: undefined })} />);
    expect(screen.queryByTestId('live-stage-track')).not.toBeInTheDocument();
    expect(screen.getByText('卓驭 2027 校招')).toBeInTheDocument();
  });
});
