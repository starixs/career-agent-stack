import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { onEvent } from '@/api/eventBus';
import type { ContentBlock, Message, ToolUseSimple } from '@/types/chat';

import { buildCareerContextReminder, careerContextSurface } from '../../../shared/systemReminder';
import { PageAskBar } from './PageAskBar';
import { PageReturnCard, pageReturnOutcome, pageReturnTargets } from './PageReturnCard';
import { pageLabel, pageSurfaceId, parsePageSurface } from './pageSurface';

function msg(id: string, role: Message['role'], content: string | ContentBlock[]): Message {
  return { id, role, content, timestamp: new Date(0) } as Message;
}

function tool(name: string, over: Partial<ToolUseSimple> = {}): ContentBlock {
  return { type: 'tool_use', tool: { id: `t-${name}-${Math.random()}`, name: `mcp__career__${name}`, input: {}, ...over } as ToolUseSimple };
}

const answer = (text: string): ContentBlock => ({ type: 'text', text });

describe('page surface ids', () => {
  it('round-trips a page and its view through the hidden context', () => {
    const id = pageSurfaceId({ kind: 'career-dossier', view: 'apply' });
    const reminder = buildCareerContextReminder({ surface: id });
    expect(careerContextSurface(`${reminder}\n\n帮我筛一下`)).toBe(id);
    expect(parsePageSurface(id)).toEqual({ kind: 'career-dossier', view: 'apply' });
    expect(pageLabel({ kind: 'career-dossier', view: 'apply' })).toBe('岗位收藏');
  });

  it('ignores surfaces that are not pages', () => {
    expect(parsePageSurface('today')).toBeNull();
    expect(parsePageSurface('page:not-a-page')).toBeNull();
    expect(careerContextSurface('普通消息')).toBeNull();
  });
});

describe('return cards', () => {
  it('hang under the last assistant reply of a turn that came from a page', () => {
    const fromPage = `${buildCareerContextReminder({ surface: 'page:career-today' })}\n\n明天加个提醒`;
    const targets = pageReturnTargets([
      msg('u1', 'user', '你好'),
      msg('a1', 'assistant', '你好呀'),
      msg('u2', 'user', fromPage),
      msg('a2', 'assistant', '好的'),
      msg('a3', 'assistant', '已加上'),
      msg('u3', 'user', '谢谢'),
      msg('a4', 'assistant', '不客气'),
    ]);
    expect([...targets.keys()]).toEqual(['a3']);
    expect(targets.get('a3')?.target).toEqual({ kind: 'career-today' });
  });

  it('reads the whole turn: a deadline written in an earlier assistant message shows up as 已更新 with its title and date', () => {
    const fromPage = `${buildCareerContextReminder({ surface: 'page:career-today' })}\n\n20 号提醒我交测评`;
    const targets = pageReturnTargets([
      msg('u1', 'user', fromPage),
      msg('a1', 'assistant', [tool('deadline_add', { result: JSON.stringify({ deadline: { id: 'd1', title: '乙公司测评', due_at: '2026-10-20T18:00:00', status: 'open' } }) })]),
      msg('a2', 'assistant', [answer('记好了')]),
    ]);
    const ret = targets.get('a2')!;
    expect(ret.outcome).toMatchObject({ status: 'updated', deadlines: [{ key: 'd1', title: '乙公司测评', dueAt: '2026-10-20T18:00:00', done: false }], writes: [] });
    render(<PageReturnCard {...ret} />);
    const card = screen.getByTestId('career-page-return-card');
    expect(card).toHaveTextContent('已更新');
    expect(within(screen.getByTestId('career-page-return-preview')).getByText('乙公司测评')).toBeInTheDocument();
    expect(card).toHaveTextContent('10 月 20 日');
    expect(card).toHaveTextContent('回到招聘概览');
  });

  it('deadline_update / deadline_list results with id/title/due_at are previewed; reads alone answer', () => {
    const updated = pageReturnOutcome([msg('a1', 'assistant', [
      tool('deadline_list', { result: JSON.stringify({ deadlines: [{ id: 'd1', title: '旧', due_at: '2026-10-01', kind: 'assessment' }] }) }),
      tool('deadline_update', { result: JSON.stringify({ deadline: { id: 'd1', title: '丙公司笔试', due_at: '2026-10-22T14:00:00', kind: 'written_test' } }) }),
    ])]);
    expect(updated.status).toBe('updated');
    expect(updated.deadlines.map(d => d.title)).toEqual(['丙公司笔试']);

    const read = pageReturnOutcome([msg('a1', 'assistant', [
      tool('deadline_list', { result: JSON.stringify({ deadlines: [] }) }),
      answer('这周没有截止'),
    ])]);
    expect(read).toEqual({ status: 'answered', deadlines: [], jobs: null, writes: [] });
  });

  it('jobs board turns preview the count and the filters the assistant used', () => {
    const outcome = pageReturnOutcome([msg('a1', 'assistant', [
      tool('jobs_board', { parsedInput: { city: '上海', employment_type: 'intern', open_only: true }, result: JSON.stringify({ rows: [{ job_id: 'j1' }, { job_id: 'j2' }] }) }),
    ])]);
    expect(outcome).toMatchObject({ status: 'answered', jobs: { count: 2, filters: '上海 · 实习 · 没截止' } });
    render(<PageReturnCard target={{ kind: 'career-dossier', view: 'apply' }} outcome={outcome} />);
    expect(screen.getByTestId('career-page-return-card')).toHaveTextContent('按「上海 · 实习 · 没截止」筛出 2 个岗位');
    expect(screen.getByTestId('career-page-return-card')).toHaveTextContent('已回答');
  });

  it('jobs_board results that echo total / filters win over the row count and call input', () => {
    const outcome = pageReturnOutcome([msg('a1', 'assistant', [
      tool('jobs_board', { parsedInput: { city: '北京' }, result: JSON.stringify({ total: 37, returned: 15, filters: { city: '上海', tag: ['央国企'], open_only: true }, rows: [{ job_id: 'j1' }] }) }),
    ])]);
    expect(outcome.jobs).toEqual({ count: 37, filters: '央国企 · 上海 · 没截止' });
  });

  it('other writes get one summary line each; settings tools only count as writes when they set something', () => {
    const outcome = pageReturnOutcome([msg('a1', 'assistant', [
      tool('application_set_stage', { result: JSON.stringify({ application: { id: 'a1' } }) }),
      tool('apply_auto_mode', { parsedInput: {}, result: '{}' }),
      tool('job_prefs', { parsedInput: { cities: ['上海'] }, result: '{}' }),
    ])]);
    expect(outcome).toMatchObject({ status: 'updated', writes: ['推进了投递阶段', '改了求职条件'] });
  });

  it('a failed career tool or failed block marks the turn as an error; non-career tools do not count', () => {
    expect(pageReturnOutcome([msg('a1', 'assistant', [tool('deadline_add', { isError: true, result: 'boom' })])]).status).toBe('error');
    expect(pageReturnOutcome([msg('a1', 'assistant', [{ type: 'text', text: '…', isFailed: true }])]).status).toBe('error');
    expect(pageReturnOutcome([msg('a1', 'assistant', [{ type: 'tool_use', tool: { id: 'x', name: 'Bash', input: {}, isError: true } as ToolUseSimple }])]).status).toBe('answered');
  });

  it('collapses the preview when nothing changed', () => {
    render(<PageReturnCard target={{ kind: 'career-inbox' }} outcome={{ status: 'answered', deadlines: [], jobs: null, writes: [] }} />);
    expect(screen.getByTestId('career-page-return-card')).toHaveTextContent('已回答');
    expect(screen.queryByTestId('career-page-return-preview')).not.toBeInTheDocument();
  });
});

describe('PageAskBar', () => {
  it('sends the text into the chat with the page it came from', () => {
    const seen: unknown[] = [];
    const off = onEvent('career:chat-suggest', payload => seen.push(payload));
    render(<PageAskBar target={{ kind: 'career-dossier', view: 'line' }} placeholder="问问投递情况" />);
    fireEvent.change(screen.getByLabelText('问助理'), { target: { value: '这周投了多少' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给助理' }));
    off();
    expect(seen).toEqual([{ text: '这周投了多少', context: { surface: 'page:career-dossier:line', refs: undefined }, mode: 'send' }]);
    expect(screen.getByLabelText('问助理')).toHaveValue('');
  });

  it('does not touch the clipboard when sending', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<PageAskBar target={{ kind: 'career-today' }} placeholder="说点什么" refs={{ date: '2026-10-20' }} />);
    fireEvent.change(screen.getByLabelText('问助理'), { target: { value: '这天有什么' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给助理' }));
    expect(writeText).not.toHaveBeenCalled();
  });
});
