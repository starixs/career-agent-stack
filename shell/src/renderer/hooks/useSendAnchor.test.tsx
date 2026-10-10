import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { anchorTailPx, useSendAnchor } from './useSendAnchor';

describe('anchorTailPx', () => {
  it('adds just enough tail for the question to reach the top', () => {
    // question at 1200px in an 1400px-tall list, 700px viewport: needs 1200 - 16 + 700 - 1400 = 484
    expect(anchorTailPx({ anchorOffset: 1200, viewportHeight: 700, contentHeight: 1400 })).toBe(484);
  });
  it('needs no tail once the reply below the question is longer than a screen', () => {
    expect(anchorTailPx({ anchorOffset: 1200, viewportHeight: 700, contentHeight: 2200 })).toBe(0);
  });
});

describe('useSendAnchor', () => {
  it('pauses auto-follow on send and scrolls only the new question to the top', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 0; });
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'u2');
    scroller.appendChild(row);
    document.body.appendChild(scroller);
    const scrollToMessage = vi.fn();
    const pauseAutoScroll = vi.fn();
    const scrollerRef = { current: scroller };
    const initial = [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }];
    const { result, rerender } = renderHook(({ messages }) => useSendAnchor({ messages, scrollerRef, scrollToMessage, pauseAutoScroll }), { initialProps: { messages: initial } });

    act(() => result.current.armAnchor());
    expect(pauseAutoScroll).toHaveBeenCalledTimes(1);
    expect(scrollToMessage).not.toHaveBeenCalled();

    // the sent question arrives through the stream
    rerender({ messages: [...initial, { id: 'u2', role: 'user' }] });
    expect(scrollToMessage).toHaveBeenCalledWith('u2', { align: 'start', behavior: 'smooth' });

    // the reply streaming in does not scroll again
    scrollToMessage.mockClear();
    rerender({ messages: [...initial, { id: 'u2', role: 'user' }, { id: 'a2', role: 'assistant' }] });
    expect(scrollToMessage).not.toHaveBeenCalled();

    scroller.remove();
    raf.mockRestore();
  });
});
