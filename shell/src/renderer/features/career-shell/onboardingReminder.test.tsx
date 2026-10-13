import { beforeEach, describe, expect, it, vi } from 'vitest';

import { onEvent } from '@/api/eventBus';

import { CAREER_NAVIGATE_EVENT } from './navModel';
import { markReminderShown, onOnboardingIntroRequest, reminderShownToday, requestOnboardingIntro, takeOnboardingIntroRequest } from './onboardingReminder';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: i => [...map.keys()][i] ?? null,
    removeItem: key => { map.delete(key); },
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

describe('onboarding daily reminder', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    Object.defineProperty(window, 'localStorage', { value: globalThis.localStorage, configurable: true });
    takeOnboardingIntroRequest();
  });

  it('is shown at most once per day', () => {
    const day = new Date(2026, 9, 13, 9);
    expect(reminderShownToday(day)).toBe(false);
    markReminderShown(day);
    expect(reminderShownToday(new Date(2026, 9, 13, 22))).toBe(true);
    expect(reminderShownToday(new Date(2026, 9, 14, 8))).toBe(false);
  });

  it('starting it navigates to 招聘概览 and leaves a one-shot request the page picks up', () => {
    const navigations: unknown[] = [];
    const offNav = onEvent(CAREER_NAVIGATE_EVENT, target => navigations.push(target));
    const opened = vi.fn();
    const offOpen = onOnboardingIntroRequest(opened);
    requestOnboardingIntro();
    offNav();
    offOpen();
    expect(navigations).toEqual([{ kind: 'career-today' }]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(takeOnboardingIntroRequest()).toBe(false);
  });

  it('a page mounted after the request still finds it', () => {
    requestOnboardingIntro();
    expect(takeOnboardingIntroRequest()).toBe(true);
    expect(takeOnboardingIntroRequest()).toBe(false);
  });
});
