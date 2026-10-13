/**
 * 首次打开的新手引导浮层：五步起步清单逐条闪入，做完的划掉，再把第一件没做的事放大，
 * 给出「开始第一步」（真的发进对话）和「跳过」。看过一次后记在 localStorage，
 * 招聘概览页头的「新手引导」随时能再打开。
 */
import { useEffect, useRef } from 'react';

import { emitEvent } from '@/api/eventBus';

import { Button, suggestToChat } from './CareerPrimitives';
import { StrikeText } from './StrikeText';
import type { CareerFocusEvent, OnboardingChecklist } from './types';

export const ONBOARDING_INTRO_KEY = 'career:onboarding-intro-seen';

export interface ChecklistStep { key: string; label: string; done: boolean; chat?: string; focus?: CareerFocusEvent['surface'] }

export function buildSteps(c: OnboardingChecklist): ChecklistStep[] {
  return [
    { key: 'experience', label: '先把经历放进来', done: Boolean(c.has_experience || c.has_confirmed_claim), chat: '帮我整理经历，我先口述一段实习' },
    { key: 'resume', label: '生成主简历', done: Boolean(c.has_master_resume), chat: '帮我生成主简历' },
    { key: 'mail', label: '绑定邮箱，让面试邀请自动进来', done: Boolean(c.has_mail_account), focus: 'inbox' },
    { key: 'job', label: '丢第一个 JD 进通知中心', done: Boolean(c.has_job), chat: '我把一个 JD 贴给你，帮我评估值不值得投' },
    { key: 'application', label: '第一条投递', done: Boolean(c.has_application), chat: '从评估过的岗位里挑一个，帮我准备第一条投递' },
  ];
}

/** 读写「看过引导」标记；存储不可用（隐私模式、预览）时当作没看过，不抛错。 */
export function readIntroSeen(): boolean {
  try { return window.localStorage.getItem(ONBOARDING_INTRO_KEY) === '1'; } catch { return false; }
}

export function markIntroSeen(): void {
  try { window.localStorage.setItem(ONBOARDING_INTRO_KEY, '1'); } catch { /* 存储不可用：本次会话内仍会关闭 */ }
}

/** 第一步：先做的那件事（没有就说明五步都做完了）。 */
export function firstPendingStep(steps: readonly ChecklistStep[]): ChecklistStep | undefined {
  return steps.find(s => !s.done);
}

export function startStep(step: ChecklistStep): void {
  if (step.chat) {
    suggestToChat(step.chat, { surface: 'today', note: `起步步骤：${step.label}` });
    return;
  }
  emitEvent('career:focus', { surface: step.focus ?? 'inbox' } satisfies CareerFocusEvent);
}

export function OnboardingIntro({ steps, onClose }: { steps: readonly ChecklistStep[]; onClose: () => void }) {
  const first = firstPendingStep(steps);
  const doneCount = steps.filter(s => s.done).length;
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const start = () => {
    if (first) startStep(first);
    onClose();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[var(--bg)] px-4" style={{ animation: 'overlayFadeIn var(--motion-base) ease-out' }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="career-intro-title"
        className="career-intro-panel w-full max-w-md rounded-[var(--radius-xl)] border-[1.5px] border-[var(--hard)] bg-[var(--paper)] p-6 shadow-hard-lg"
      >
        <h2 id="career-intro-title" className="font-human text-xl font-semibold text-[var(--ink)]">五步跑通第一条投递</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {first ? `已完成 ${doneCount} / ${steps.length}，先做下面放大的这一步。` : '五步都做完了，之后每天看招聘概览就行。'}
        </p>
        <ol className="mt-5 space-y-2">
          {steps.map((step, idx) => {
            const focused = step.key === first?.key;
            return (
              <li
                key={step.key}
                data-step={step.key}
                data-focus={focused ? 'true' : undefined}
                className={`career-intro-step flex min-h-10 items-center gap-3 rounded-md px-3 text-sm text-[var(--ink)] ${focused ? 'border-[1.5px] border-[var(--primary)] bg-[var(--paper)] shadow-hard' : 'border-[1.5px] border-transparent'}`}
                style={{ animationDelay: focused ? `${idx * 70}ms, 760ms` : `${idx * 70}ms` }}
              >
                <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums ${step.done ? 'border-[var(--success)] text-[var(--success)]' : focused ? 'border-[var(--primary)] text-[var(--primary)]' : 'border-[var(--line-2)] text-[var(--muted)]'}`}>
                  {step.done ? '✓' : idx + 1}
                </span>
                <StrikeText done={step.done} animate={step.done} delayMs={idx * 70 + 280} className={focused ? 'font-human text-base font-semibold' : ''}>
                  {step.label}
                </StrikeText>
              </li>
            );
          })}
        </ol>
        <div className="career-intro-actions mt-6 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>跳过</Button>
          {first
            ? <Button data-autofocus variant="primary" onClick={start}>开始第一步</Button>
            : <Button data-autofocus variant="primary" onClick={onClose}>知道了</Button>}
        </div>
      </div>
    </div>
  );
}
