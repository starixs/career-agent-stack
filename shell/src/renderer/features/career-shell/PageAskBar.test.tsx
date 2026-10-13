import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { onEvent } from '@/api/eventBus';
import type { Message } from '@/types/chat';

import { buildCareerContextReminder, careerContextSurface } from '../../../shared/systemReminder';
import { PageAskBar } from './PageAskBar';
import { pageReturnTargets } from './PageReturnCard';
import { pageLabel, pageSurfaceId, parsePageSurface } from './pageSurface';

function msg(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: new Date(0) } as Message;
}

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
    expect([...targets.entries()]).toEqual([['a3', { kind: 'career-today' }]]);
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
});
