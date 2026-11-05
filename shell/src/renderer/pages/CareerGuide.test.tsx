import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { onEvent } from '@/api/eventBus';
import { CAREER_NAVIGATE_EVENT } from '@/features/career-shell/navModel';
import CareerGuide, { CHAT_TOOLS, IDEAS, WORKBENCHES } from './CareerGuide';

function capture(event: string) {
  const seen: unknown[] = [];
  const off = onEvent(event, p => seen.push(p));
  return { seen, off };
}

describe('CareerGuide（功能市场）', () => {
  it('工具双列排开，没有「添加」按钮；教程变成点子', () => {
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    for (const item of [...WORKBENCHES, ...CHAT_TOOLS]) expect(screen.getByRole('button', { name: new RegExp(`^${item.name}`) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /添加|安装/ })).toBeNull();
    expect(screen.getByText('点子')).toBeInTheDocument();
    for (const idea of IDEAS) expect(screen.getByText(idea.text)).toBeInTheDocument();
  });

  it('大功能跳到工作台；面试助力去面试工作台', () => {
    const nav = capture(CAREER_NAVIGATE_EVENT);
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /面试助力/ }));
    expect(nav.seen).toEqual([{ kind: 'career-dossier', view: 'interview' }]);
    nav.off();
  });

  it('题库刷题并进面试助力，不再单列一张打开同一页的卡', () => {
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^题库刷题/ })).toBeNull();
    expect(screen.getByRole('button', { name: /面试助力/ })).toHaveTextContent('题库');
  });

  it('笔试助力：直接打开搜题页', () => {
    const nav = capture(CAREER_NAVIGATE_EVENT);
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /笔试助力/ }));
    expect(nav.seen).toEqual([{ kind: 'career-dossier', view: 'exam-search' }]);
    nav.off();
  });

  it('小功能和点子把话预填进对话输入框，不直接发送', () => {
    const chat = capture('career:chat-suggest');
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /岗位评估/ }));
    fireEvent.click(screen.getByRole('button', { name: '摊开卷宗' }));
    expect(chat.seen).toEqual([
      expect.objectContaining({ text: '帮我评估这个岗位，JD 是：', mode: 'prefill' }),
      expect.objectContaining({ text: '我明天面试，把这家公司的卷宗摊开：', mode: 'prefill' }),
    ]);
    chat.off();
  });

  it('网申进展直接打开投递控制页，不再只预填一句话', () => {
    const nav = capture(CAREER_NAVIGATE_EVENT);
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /网申进展/ }));
    expect(nav.seen).toEqual([{ kind: 'career-live' }]);
    nav.off();
  });

  it('复盘不走对话：直接打开「我的求职月」', () => {
    const nav = capture(CAREER_NAVIGATE_EVENT);
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '看我的求职月' }));
    expect(nav.seen).toEqual([{ kind: 'career-review' }]);
    nav.off();
  });
});
