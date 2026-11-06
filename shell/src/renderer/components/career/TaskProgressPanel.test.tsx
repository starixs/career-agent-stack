import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

import type { LivePage } from './LivePageTabs';
import { TaskProgressPanel } from './TaskProgressPanel';

const didi: LivePage = { application_id: 'a_didi', company: '滴滴', title: '数据分析师', current: true, waiting: null };
const step = (message: string, phase = 'apply_batch', at = 1) => ({ message, phase, at });
const run = (steps: ReturnType<typeof step>[], extra: Partial<ProgressRun> = {}): ProgressRun => ({ key: 'run_fill', steps, progress: null, finished: false, updatedAt: 1, applicationId: 'a_didi', ...extra });
/** 链路上每一环的样子（按环的顺序）。 */
const chain = () => Array.from(screen.getByTestId('live-stage-track').querySelectorAll('li')).map(li => li.getAttribute('data-state'));
/** 画面上看得见的字（去掉只给读屏的那句）。 */
const visibleText = (root: HTMLElement) => { const c = root.cloneNode(true) as HTMLElement; c.querySelectorAll('.sr-only').forEach(n => n.remove()); return c.textContent ?? ''; };

describe('网申现场画面下面：这一家走到链路哪一环，用图形讲（2026-11-06 用户：不放文案、更多是图形结构）', () => {
  it('画面上没有句子：只有六环的名字和当前一环下面四五个字；要他做什么留给「等你」卡，读屏照样有一句', () => {
    const { container } = render(<TaskProgressPanel page={{ ...didi, waiting: 'login' }} run={run([step('请在浏览器里登录（扫码 / 账号密码 / 短信码均可），登录成功后点"交还"继续')], { stage: 'open' })} />);
    expect(visibleText(container)).toBe('选中定制简历打开网页等你登录填写你过目投出');
    expect(screen.getByRole('status')).toHaveTextContent('请在浏览器里登录');
    expect(screen.queryByRole('list', { name: '刚做过的几步' })).not.toBeInTheDocument();
  });

  it('链路从他选中开投算起：排队时只有「选中」走完；定制简历、打开网页、填写一环环往前', () => {
    const { rerender } = render(<TaskProgressPanel page={didi} takeover={{ runId: 'run_other', state: 'paused', message: '别家的话' }} />);
    expect(chain()).toEqual(['done', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(screen.getByRole('status')).toHaveTextContent('这一家还在排队');
    rerender(<TaskProgressPanel page={didi} run={run([step('按岗位改简历')], { stage: 'tailor', kind: 'resume' })} />);
    expect(chain()).toEqual(['done', 'working', 'todo', 'todo', 'todo', 'todo']);
    expect(screen.getByTestId('live-stage-caption')).toHaveTextContent('改简历');
    rerender(<TaskProgressPanel page={didi} run={run([step('正在填「姓名」')], { stage: 'fill', kind: 'field' })} />);
    expect(chain()).toEqual(['done', 'done', 'done', 'working', 'todo', 'todo']);
    expect(screen.getByTestId('live-stage-caption')).toHaveTextContent('填格子');
  });

  it('停下等他：那一环是等他的样子，小字说等他做哪一下；填好了走到「你过目」；提交走到「投出」；投出后六环都走完', () => {
    const { rerender } = render(<TaskProgressPanel page={{ ...didi, waiting: 'missing_info' }} run={run([step('还差 2 项要你补')], { stage: 'fill' })} />);
    expect(chain()).toEqual(['done', 'done', 'done', 'you', 'todo', 'todo']);
    expect(screen.getByTestId('live-stage-caption')).toHaveTextContent('等你补几项');
    rerender(<TaskProgressPanel page={didi} run={run([step('必填 12/12 已填好', 'apply_batch_ready')], { finished: true, ready: true, stage: 'review' })} />);
    expect(chain()).toEqual(['done', 'done', 'done', 'done', 'you', 'todo']);
    rerender(<TaskProgressPanel page={didi} run={run([step('正在提交网申', 'submit')], { stage: 'send' })} />);
    expect(chain()).toEqual(['done', 'done', 'done', 'done', 'done', 'working']);
    rerender(<TaskProgressPanel page={didi} run={run([step('已投出', 'submit_done')], { finished: true, stage: 'send' })} />);
    expect(chain()).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  });

  it('格子：填好的、等他的、还没填的各是各的样子；太多就按比例缩', () => {
    const { rerender } = render(<TaskProgressPanel page={{ ...didi, waiting: 'missing_info' }} run={run([step('还差 2 项')], { stage: 'fill', cells: { total: 10, done: 7, you: 2 } })} />);
    const kinds = () => Array.from(screen.getByTestId('live-cells').querySelectorAll('[data-cell]')).map(c => c.getAttribute('data-cell'));
    expect(kinds()).toEqual([...Array<string>(7).fill('done'), 'you', 'you', 'todo']);
    expect(screen.getByRole('img', { name: '填好 7 格，共 10 格，2 格等你' })).toBeInTheDocument();
    rerender(<TaskProgressPanel page={didi} run={run([step('正在填')], { stage: 'fill', cells: { total: 400, done: 200, you: 0 } })} />);
    expect(kinds()).toHaveLength(96);
    expect(kinds().filter(k => k === 'done')).toHaveLength(48);
  });

  it('对话里随手打开网页看一眼不是一份网申：不画链路，只有一行在做什么', () => {
    render(<TaskProgressPanel title="卓驭 2027 校招" run={run([step('打开卓驭校招首页', 'browse')], { applicationId: undefined })} />);
    expect(screen.queryByTestId('live-stage-track')).not.toBeInTheDocument();
    expect(screen.getByText('卓驭 2027 校招')).toBeInTheDocument();
  });
});
