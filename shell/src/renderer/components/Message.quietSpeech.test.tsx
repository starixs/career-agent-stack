import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

vi.mock('@/context/ImagePreviewContext', () => ({ useImagePreview: () => ({ openPreview: vi.fn() }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/context/FileActionContext', () => ({
  useFileAction: () => ({ workspacePath: '/workspace', openFileTarget: vi.fn() }),
}));

import Message from './Message';

const TIMESTAMP = new Date('2026-11-02T08:00:00Z');

function toolTurn(isLoading: boolean): MessageType {
  return {
    id: 'assistant-quiet',
    role: 'assistant',
    timestamp: TIMESTAMP,
    content: [
      { type: 'thinking', thinking: '先看看今天有什么', isComplete: true },
      { type: 'tool_use', tool: { id: 't1', name: 'mcp__career__today_queue', input: {}, inputJson: '{}', isLoading, result: isLoading ? undefined : '{}' } },
    ],
  } as MessageType;
}

describe('Message — 对话里不显示工具调用和思考过程', () => {
  it('shows only one plain-language line while a tool is still running', () => {
    render(<Message message={toolTurn(true)} isLoading />);
    expect(screen.getByTestId('quiet-work-line')).toHaveTextContent('看今天的待办');
    expect(screen.queryByText('先看看今天有什么')).not.toBeInTheDocument();
  });

  it('shows nothing for a finished tool group', () => {
    render(<Message message={toolTurn(false)} />);
    expect(screen.queryByTestId('quiet-work-line')).not.toBeInTheDocument();
    expect(screen.queryByText('看今天的待办')).not.toBeInTheDocument();
  });

  it('splits a reply into short speech blocks and drops token / duration meta', () => {
    render(
      <Message
        message={{ id: 'a2', role: 'assistant', timestamp: TIMESTAMP, content: '收到。\n\n用哪个？', durationMs: 134_000, usage: { inputTokens: 10, outputTokens: 2 } } as MessageType}
      />,
    );
    expect(screen.getAllByTestId('speech-block')).toHaveLength(2);
    expect(screen.queryByText(/tokens|本轮耗时/)).not.toBeInTheDocument();
  });
});
