import { describe, expect, it } from 'vitest';

import { STOLEN_FOCUS_WINDOW_MS, shouldReturnFocus } from './focusGuard';

describe('shouldReturnFocus', () => {
  const now = 100_000;
  it('产品窗口刚被抢走焦点（之前在用、几秒内失焦）→ 拿回来', () => {
    expect(shouldReturnFocus({ focused: false, focusedBeforeBlur: true, lastBlurAt: now - 1500 }, now)).toBe(true);
  });
  it('用户本来就在别的 App / 失焦很久了 / 窗口仍有焦点 → 不打扰', () => {
    expect(shouldReturnFocus({ focused: false, focusedBeforeBlur: false, lastBlurAt: now - 1000 }, now)).toBe(false);
    expect(shouldReturnFocus({ focused: false, focusedBeforeBlur: true, lastBlurAt: now - STOLEN_FOCUS_WINDOW_MS - 1 }, now)).toBe(false);
    expect(shouldReturnFocus({ focused: true, focusedBeforeBlur: true, lastBlurAt: now - 100 }, now)).toBe(false);
  });
});
