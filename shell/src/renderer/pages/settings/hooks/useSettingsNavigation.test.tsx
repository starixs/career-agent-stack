import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSettingsNavigation } from './useSettingsNavigation';

describe('useSettingsNavigation', () => {
  it('keeps the requested section after the navigation intent is consumed', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ section, nonce }: { section?: string; nonce?: number }) => useSettingsNavigation({ initialSection: section, navigationNonce: nonce }),
      { initialProps: { section: 'proxy', nonce: 1 } as { section?: string; nonce?: number } },
    );
    act(() => { vi.runAllTimers(); });
    expect(result.current.activeSection).toBe('proxy');

    // The tab clears its intent once consumed; the page must not fall back to another section.
    rerender({ section: undefined, nonce: undefined });
    act(() => { vi.runAllTimers(); });
    expect(result.current.activeSection).toBe('proxy');
    vi.useRealTimers();
  });

  it('defaults to general when opened without a section', () => {
    const { result } = renderHook(() => useSettingsNavigation({}));
    expect(result.current.activeSection).toBe('general');
  });
});
