/**
 * 新手引导的每日提醒：五步没走完时，每天提醒一次，不进对话上下文。
 *  - 在对话页：右栏的 Mino 面板（CompanionPanel）里冒一条，面板收起时在小标上提示；
 *  - 在别的页面：推给桌面悬浮球（fb:reminder），点悬浮球回到工作台开始引导（cmd_fb_open_onboarding）。
 * 「开始引导」统一走 requestOnboardingIntro：记一个待办标记再跳到招聘概览，页面挂载后取走标记打开引导层
 * （页面懒加载，单发事件会在首次打开时丢失，同 pendingFocus 的做法）。
 */
import { useEffect, useState } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import { buildSteps } from '@/components/career/OnboardingIntro';
import { useCareerQuery } from '@/components/career/useCareerData';

import { requestNavigation } from './navModel';

const REMINDER_DAY_KEY = 'career:onboarding-reminder-day';
export const ONBOARDING_OPEN_EVENT = 'career:onboarding-open';
const ONBOARDING_TABLES = ['experience', 'claim', 'resume_master', 'mail_account', 'job', 'application', 'material'] as const;

let pendingIntro = false;

export function requestOnboardingIntro(): void {
  pendingIntro = true;
  requestNavigation({ kind: 'career-today' });
  emitEvent(ONBOARDING_OPEN_EVENT, {});
}

/** 招聘概览挂载 / 收到事件时调用：有待打开的引导就取走并返回 true。 */
export function takeOnboardingIntroRequest(): boolean {
  const had = pendingIntro;
  pendingIntro = false;
  return had;
}

export function onOnboardingIntroRequest(handler: () => void): () => void {
  return onEvent(ONBOARDING_OPEN_EVENT, () => {
    if (takeOnboardingIntroRequest()) handler();
  });
}

function dayKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export function reminderShownToday(now = new Date()): boolean {
  try { return window.localStorage.getItem(REMINDER_DAY_KEY) === dayKey(now); } catch { return false; }
}

export function markReminderShown(now = new Date()): void {
  try { window.localStorage.setItem(REMINDER_DAY_KEY, dayKey(now)); } catch { /* 存储不可用：本次会话内仍按内存状态 */ }
  emitEvent(REMINDER_DAY_KEY, {});
}

/** 还剩几步；今天已经提醒过（用户点过或关掉了）就返回 0。 */
export function useOnboardingReminder(): { remaining: number; dismiss: () => void; start: () => void } {
  const onboarding = useCareerQuery(careerApi.onboarding, ONBOARDING_TABLES);
  const [shown, setShown] = useState(() => reminderShownToday());
  useEffect(() => onEvent(REMINDER_DAY_KEY, () => setShown(reminderShownToday())), []);
  const remaining = onboarding.data ? buildSteps(onboarding.data).filter(step => !step.done).length : 0;
  const dismiss = () => { markReminderShown(); setShown(true); };
  return {
    remaining: shown ? 0 : remaining,
    dismiss,
    start: () => { dismiss(); requestOnboardingIntro(); },
  };
}
