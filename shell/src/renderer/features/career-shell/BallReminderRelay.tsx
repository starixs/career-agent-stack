/**
 * 不在对话页时，把新手引导的每日提醒推给桌面悬浮球（fb:reminder）；在对话页由 Mino 面板自己提醒。
 * 悬浮球没开时 relay 会失败，静默忽略。点悬浮球 → cmd_fb_open_onboarding → 主窗口收到 fb:open-onboarding。
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect } from 'react';

import { isTauriEnvironment } from '@/utils/browserMock';

import { useOnboardingReminder } from './onboardingReminder';

export const FB_REMINDER_EVENT = 'fb:reminder';
export interface FbReminderPayload { count: number; text: string | null }

export function BallReminderRelay({ activeView }: { activeView: string | undefined }) {
  const { remaining } = useOnboardingReminder();
  const onChatPage = activeView === 'chat' || activeView === 'launcher';
  const count = onChatPage ? 0 : remaining;
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const payload: FbReminderPayload = { count, text: count > 0 ? `还有 ${count} 步新手任务没走完，点我继续` : null };
    void invoke('cmd_fb_relay', { target: 'ball', event: FB_REMINDER_EVENT, payload }).catch(() => { /* 悬浮球没开 */ });
  }, [count]);
  return null;
}
