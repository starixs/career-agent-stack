import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType, ToolUseSimple } from '@/types/chat';

vi.mock('@/context/ImagePreviewContext', () => ({ useImagePreview: () => ({ openPreview: vi.fn() }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/context/FileActionContext', () => ({
  useFileAction: () => ({ workspacePath: '/workspace', openFileTarget: vi.fn() }),
}));
vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { CareerCardsContext } from '@/context/CareerCardsContext';
import type { CareerCard } from '@/components/career/types';

import Message from './Message';

// 求职流程卡片挂在产生它的那次工具调用所在的回复下面，而不是堆在对话底部。

function assistantWithTool(toolId: string): MessageType {
  return {
    id: `assistant-${toolId}`,
    role: 'assistant',
    timestamp: new Date('2026-10-03T08:00:00Z'),
    content: [
      { type: 'tool_use', tool: { id: toolId, name: 'mcp__career__experience_add', input: {}, result: '{}' } as unknown as ToolUseSimple },
      { type: 'text', text: '已经记下来了，请在下面确认。' },
    ],
  };
}

const claims: CareerCard = {
  id: 'claims:e1', kind: 'claims_confirm', title: '确认「字节实习」里的 1 条说法', createdAt: '2026-10-03T08:00:00Z',
  data: { experience_title: '字节实习', claims: [{ id: 'c1', text: '主导召回重构' }] }, toolUseId: 'toolu_a', state: 'pending',
};

function renderWith(message: MessageType, cards: CareerCard[], setState = vi.fn()) {
  render(
    <CareerCardsContext.Provider value={{ cards, setState }}>
      <Message message={message} />
    </CareerCardsContext.Provider>,
  );
  return setState;
}

describe('Message — 锚定的求职卡片', () => {
  it('卡片渲染在它的工具调用所在的回复里', () => {
    renderWith(assistantWithTool('toolu_a'), [claims]);
    expect(screen.getByTestId('career-inline-cards')).toBeInTheDocument();
    expect(screen.getByTestId('career-card-claims_confirm')).toHaveTextContent('主导召回重构');
  });

  it('别的回复不渲染这张卡片', () => {
    renderWith(assistantWithTool('toolu_other'), [claims]);
    expect(screen.queryByTestId('career-inline-cards')).not.toBeInTheDocument();
  });

  it('完成后折叠成一行；稍后再说 → dismissed', () => {
    const setState = renderWith(assistantWithTool('toolu_a'), [claims]);
    fireEvent.click(screen.getByRole('button', { name: '稍后再说' }));
    expect(setState).toHaveBeenCalledWith('claims:e1', 'dismissed');
  });

  it('已完成的卡片只剩一行"已完成"', () => {
    renderWith(assistantWithTool('toolu_a'), [{ ...claims, state: 'completed' }]);
    expect(screen.getByTestId('career-card-collapsed-claims_confirm')).toHaveTextContent('已完成：确认「字节实习」里的 1 条说法');
    expect(screen.queryByTestId('career-card-claims_confirm')).not.toBeInTheDocument();
  });
});
