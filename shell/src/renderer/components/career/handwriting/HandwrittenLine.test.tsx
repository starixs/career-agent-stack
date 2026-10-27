import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HandwrittenLine } from './HandwrittenLine';
import { QuoteNote } from './QuoteNote';

describe('HandwrittenLine', () => {
  it('draws each character as clipped strokes and reads as the plain sentence', async () => {
    const onWritten = vi.fn();
    render(<HandwrittenLine text="歇一歇也算数。" playKey="test-1" onWritten={onWritten} />);
    const line = screen.getByRole('img', { name: '歇一歇也算数。' });
    await waitFor(() => expect(line.querySelectorAll('svg.hw-glyph')).toHaveLength(6));
    // 每一笔都被自己的轮廓裁剪，墨线才会长成字形
    expect(line.querySelector('path[data-hw-from]')?.getAttribute('clip-path')).toMatch(/^url\(#/);
    expect(line.querySelector('[data-hw-fade]')?.textContent).toBe('。');
    // jsdom 没有 Web Animations：直接显示终态并报告写完
    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1));
  });
});

describe('QuoteNote', () => {
  it('writes the scene line and reveals its source afterwards', async () => {
    const { container } = render(<QuoteNote scene="quiet" seed="test" />);
    expect(container.querySelector('figure')?.dataset.quoteScene).toBe('quiet');
    await waitFor(() => expect(container.querySelector('svg.hw-glyph')).not.toBeNull());
    const caption = container.querySelector('figcaption');
    if (caption) await waitFor(() => expect(caption.className).toContain('opacity-100'));
  });
});
