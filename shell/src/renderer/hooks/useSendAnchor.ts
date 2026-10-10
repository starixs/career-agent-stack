/**
 * Send-anchored reading (the ChatGPT / Claude pattern): after the user sends,
 * their new message moves to the top of the viewport and the reply grows below
 * it without moving the page. The user keeps reading where they are.
 *
 * - `armAnchor()` is called by the send path instead of `scrollToBottom()`; it
 *   pauses auto-follow and remembers which user messages already existed.
 * - When the new user message appears, the hook computes a bottom tail that
 *   lets that message reach the top (content below it may be shorter than one
 *   screen), then scrolls it to the top once.
 * - As the reply grows the tail shrinks by the same amount, so the scroll
 *   height and the viewport stay still; once the reply is longer than a screen
 *   the tail is gone and the user scrolls on their own.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';

import type { ScrollToMessageOptions } from './useChatScrollController';

/** Breathing room between the top of the viewport and the anchored message. */
const TOP_GAP_PX = 16;

interface AnchorMessage { id: string; role: string }

/**
 * Extra bottom space needed so the anchored message can scroll to the top.
 * `contentHeight` excludes the current tail.
 */
export function anchorTailPx({ anchorOffset, viewportHeight, contentHeight }: { anchorOffset: number; viewportHeight: number; contentHeight: number }): number {
  return Math.max(0, Math.ceil(anchorOffset - TOP_GAP_PX + viewportHeight - contentHeight));
}

export function useSendAnchor({ messages, scrollerRef, scrollToMessage, pauseAutoScroll }: {
  messages: readonly AnchorMessage[];
  scrollerRef: MutableRefObject<HTMLElement | null>;
  scrollToMessage: (messageId: string, options?: ScrollToMessageOptions) => unknown;
  pauseAutoScroll: () => void;
}): { armAnchor: () => void; tailPx: number } {
  const knownUserIds = useRef<Set<string> | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [tailPx, setTailPx] = useState(0);
  const tailRef = useRef(0);
  const scrolledFor = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; });

  const armAnchor = useCallback(() => {
    knownUserIds.current = new Set(messagesRef.current.filter(m => m.role === 'user').map(m => m.id));
    pauseAutoScroll();
  }, [pauseAutoScroll]);

  // The new user message arrives through the session stream after the send call.
  useEffect(() => {
    const known = knownUserIds.current;
    if (!known) return;
    const fresh = [...messages].reverse().find(m => m.role === 'user' && !known.has(m.id));
    if (!fresh) return;
    knownUserIds.current = null;
    scrolledFor.current = null;
    setAnchorId(fresh.id);
  }, [messages]);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !anchorId) return;
    const el = scroller.querySelector<HTMLElement>(`[data-chat-search-scope][data-message-id="${CSS.escape(anchorId)}"]`);
    if (!el) return;
    const anchorOffset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const next = anchorTailPx({ anchorOffset, viewportHeight: scroller.clientHeight, contentHeight: scroller.scrollHeight - tailRef.current });
    if (Math.abs(next - tailRef.current) >= 1) {
      tailRef.current = next;
      setTailPx(next);
    }
    if (scrolledFor.current !== anchorId) {
      scrolledFor.current = anchorId;
      // Let the tail commit first so the message can actually reach the top.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        scrollToMessage(anchorId, { align: 'start', behavior: 'smooth' });
      }));
    }
  }, [anchorId, scrollerRef, scrollToMessage]);

  useLayoutEffect(() => { measure(); }, [measure, messages]);

  // Streaming growth changes heights without changing `messages` identity often enough.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !anchorId || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(scroller);
    for (const child of Array.from(scroller.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [anchorId, measure, scrollerRef]);

  return { armAnchor, tailPx };
}
