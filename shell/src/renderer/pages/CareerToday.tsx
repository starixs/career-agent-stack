/**
 * 今日：首次使用清单 → 今天只做三件事 → 等待中。
 * 页面只展示状态与做非 AI 动作（批准 / 完成 / 关闭）；要助理做的事一律通过 ChatActionButton 真的发进对话。
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { ACTION_KIND_LABELS, STAGE_LABELS } from '@/components/career/careerConstants';
import { Badge, Button, CareerPage, Card, ChatActionButton, ErrorRow, LoadingRow, SectionTitle } from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type { ActionQueueItem, ApplicationStage, CareerFocusEvent, OnboardingChecklist, TodayItem, TodayItemKind } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

const TODAY_TABLES = ['deadline', 'action_queue', 'handoff', 'application', 'inbox_item', 'application_history'] as const;
const ONBOARDING_TABLES = ['experience', 'claim', 'resume_master', 'mail_account', 'job', 'application', 'material'] as const;
const ACTION_TABLES = ['action_queue'] as const;

const KIND_LABELS: Record<TodayItemKind, string> = {
  deadline: '截止', review: '待批准', handoff: '需要你', interview_today: '今日面试', stale: '静默', inbox: '收件箱', followup: '跟进',
};
const KIND_TONES: Record<TodayItemKind, BadgeTone> = {
  deadline: 'warning', review: 'accent', handoff: 'error', interview_today: 'info', stale: 'neutral', inbox: 'info', followup: 'neutral',
};

/** 相对到期时间：已过期 / 今天 HH:mm / 明天 / x 天后。解析失败时原样返回。 */
export function formatDue(dueAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return dueAt;
  if (due.getTime() < now.getTime()) return '已过期';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOf(due) - startOf(now)) / 86_400_000);
  if (dayDiff <= 0) {
    const hh = String(due.getHours()).padStart(2, '0');
    const mm = String(due.getMinutes()).padStart(2, '0');
    return `今天 ${hh}:${mm}`;
  }
  if (dayDiff === 1) return '明天';
  return `${dayDiff} 天后`;
}

interface ChecklistStep { key: string; label: string; done: boolean; chat?: string; focus?: CareerFocusEvent['surface'] }

function buildSteps(c: OnboardingChecklist): ChecklistStep[] {
  return [
    { key: 'experience', label: '先把经历放进来', done: Boolean(c.has_experience || c.has_confirmed_claim), chat: '帮我整理经历，我先口述一段实习' },
    { key: 'resume', label: '生成主简历', done: Boolean(c.has_master_resume), chat: '帮我生成主简历' },
    { key: 'mail', label: '绑定邮箱，让面试邀请自动进来', done: Boolean(c.has_mail_account), focus: 'inbox' },
    { key: 'job', label: '丢第一个 JD 进收件箱', done: Boolean(c.has_job), chat: '我把一个 JD 贴给你，帮我评估值不值得投' },
    { key: 'application', label: '第一条投递', done: Boolean(c.has_application), chat: '从评估过的岗位里挑一个，帮我准备第一条投递' },
  ];
}

export default function CareerToday({ onOpenChat, embedded = false }: CareerPageProps) {
  const today = useCareerQuery(careerApi.today, TODAY_TABLES);
  const onboarding = useCareerQuery(careerApi.onboarding, ONBOARDING_TABLES);
  const pending = useCareerQuery(careerApi.pendingActions, ACTION_TABLES);
  const topRef = useRef<HTMLDivElement>(null);
  // 「再等等」只在本次会话里隐藏，不改服务端状态。
  const [snoozed, setSnoozed] = useState<Set<string>>(new Set());

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'today') return;
    topRef.current?.scrollIntoView?.({ block: 'start' });
  }), []);

  const steps = useMemo(() => (onboarding.data ? buildSteps(onboarding.data) : null), [onboarding.data]);
  const checklistDone = steps ? steps.every(s => s.done) : false;
  const items = useMemo(() => (today.data?.items ?? []).filter(it => !snoozed.has(`${it.ref.type}:${it.ref.id}`)), [today.data, snoozed]);
  const actionById = useMemo(() => new Map((pending.data ?? []).map(a => [a.id, a])), [pending.data]);
  const topThree = items.slice(0, 3);
  const rest = items.slice(3);

  const reloadAll = () => { today.reload(); pending.reload(); };
  const snooze = (item: TodayItem) => setSnoozed(prev => new Set(prev).add(`${item.ref.type}:${item.ref.id}`));

  return (
    <CareerPage embedded={embedded} title="今日" subtitle="今天只做三件事，其余交给等待" examples={['帮我看看今天该做什么', '帮我准备明天的面试', '帮我看看接下来该投什么']}>
      <div ref={topRef} className="space-y-5 px-4 py-3">
        {today.error && <ErrorRow message={today.error} onRetry={today.reload} />}
        {today.loading && !today.data && <LoadingRow />}

        {steps && !checklistDone && <ChecklistCard steps={steps} />}

        {today.data && (
          <section>
            <SectionTitle extra={today.data.pending_review > 0 ? <Badge tone="accent">待批准 {today.data.pending_review}</Badge> : null}>今天只做三件事</SectionTitle>
            {topThree.length === 0 && checklistDone && (
              <Card>
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <div className="text-sm text-[var(--ink)]">今天没有必须做的事。</div>
                  <div className="text-xs text-[var(--subtle)]">等待中的投递不需要你盯着；有新动静会自动出现在这里。</div>
                  <ChatActionButton text="帮我看看接下来该投什么" context={{ surface: 'today' }} variant="secondary" />
                </div>
              </Card>
            )}
            {topThree.length === 0 && !checklistDone && (
              <div className="text-xs text-[var(--subtle)]">先完成上面的起步步骤，之后每天这里最多只放三件事。</div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {topThree.map(item => (
                <TodayItemCard key={`${item.ref.type}:${item.ref.id}:${item.kind}`} item={item} action={actionById.get(item.ref.id)} prominent onChanged={reloadAll} onSnooze={snooze} onOpenChat={onOpenChat} />
              ))}
            </div>
            {rest.length > 0 && <RestList items={rest} actionById={actionById} onChanged={reloadAll} onSnooze={snooze} onOpenChat={onOpenChat} />}
          </section>
        )}

        {today.data && <WaitingRow waiting={today.data.waiting} />}
      </div>
    </CareerPage>
  );
}

function ChecklistCard({ steps }: { steps: ChecklistStep[] }) {
  const [open, setOpen] = useState(true);
  const doneCount = steps.filter(s => s.done).length;
  return (
    <Card
      title={(
        <button type="button" onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-1 text-sm font-medium text-[var(--ink)]">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          起步：五步跑通第一条投递
        </button>
      )}
      extra={<span className="text-xs text-[var(--muted)]">{`已完成 ${doneCount} / ${steps.length}`}</span>}
    >
      {open && (
        <ol className="space-y-2">
          {steps.map((step, idx) => (
            <li key={step.key} className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${step.done ? 'border-[var(--success)]/30 bg-[var(--success-bg)] text-[var(--success)]' : 'border-[var(--line)] text-[var(--muted)]'}`}>
                {step.done ? '✓' : idx + 1}
              </span>
              <span className={step.done ? 'text-[var(--subtle)] line-through' : 'text-[var(--ink)]'}>{step.label}</span>
              {!step.done && step.chat && <ChatActionButton text={step.chat} context={{ surface: 'today', note: `起步步骤：${step.label}` }} variant="secondary" />}
              {!step.done && step.focus && (
                <Button variant="secondary" onClick={() => emitEvent('career:focus', { surface: step.focus ?? 'inbox' } satisfies CareerFocusEvent)}>去收件箱绑定</Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function RestList({ items, actionById, onChanged, onSnooze, onOpenChat }: {
  items: TodayItem[]; actionById: Map<string, ActionQueueItem>; onChanged: () => void; onSnooze: (item: TodayItem) => void; onOpenChat: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button type="button" onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink)]">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        其他待办 ({items.length})
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {items.map(item => (
            <li key={`${item.ref.type}:${item.ref.id}:${item.kind}`}>
              <TodayItemCard item={item} action={actionById.get(item.ref.id)} onChanged={onChanged} onSnooze={onSnooze} onOpenChat={onOpenChat} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TodayItemCard({ item, action, prominent = false, onChanged, onSnooze, onOpenChat }: {
  item: TodayItem; action?: ActionQueueItem; prominent?: boolean; onChanged: () => void; onSnooze: (item: TodayItem) => void; onOpenChat: () => void;
}) {
  const act = useCareerAction();
  const due = formatDue(item.due_at);
  const refs = { [`${item.ref.type}_id`]: item.ref.id };
  const run = (fn: () => Promise<unknown>) => act.run(async () => { await fn(); onChanged(); });

  const payload = action ? safeJson<Record<string, unknown>>(action.payload_json, {}) : {};
  const isSendMail = action?.kind === 'send_mail';

  return (
    <Card variant={item.kind === 'review' ? 'approval' : 'plain'}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={KIND_TONES[item.kind] ?? 'neutral'}>{KIND_LABELS[item.kind] ?? item.kind}</Badge>
        {action && <Badge tone="neutral">{ACTION_KIND_LABELS[action.kind] ?? action.kind}</Badge>}
        {due && <span className={`text-xs ${due === '已过期' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`}>{due}</span>}
      </div>
      <div className={`mt-1 break-words font-medium text-[var(--ink)] ${prominent ? 'text-sm' : 'text-xs'}`}>{item.title}</div>
      {item.detail && <div className="mt-0.5 break-words text-xs text-[var(--muted)]">{item.detail}</div>}
      {isSendMail && (typeof payload.subject === 'string' || typeof payload.to === 'string') && (
        <div className="mt-1 rounded-md bg-[var(--inset)] px-2 py-1 text-xs text-[var(--muted)]">
          {typeof payload.to === 'string' && <div>收件人：{payload.to}</div>}
          {typeof payload.subject === 'string' && <div>主题：{payload.subject}</div>}
        </div>
      )}
      {item.kind === 'stale' && (
        <div className="mt-0.5 text-xs text-[var(--subtle)]">超过静默阈值仍无回音；关闭这条线不会删除记录，之后对方来信会自动重新打开。</div>
      )}
      {act.error && <ErrorRow message={act.error} />}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {item.kind === 'review' && (
          <>
            <Button variant="primary" busy={act.busy} onClick={() => void run(() => careerApi.reviewActions([item.ref.id], 'approved'))}>{isSendMail ? '批准并发送' : '批准'}</Button>
            <Button variant="danger" busy={act.busy} onClick={() => void run(() => careerApi.reviewActions([item.ref.id], 'rejected'))}>拒绝</Button>
          </>
        )}
        {(item.kind === 'deadline' || item.kind === 'interview_today') && item.ref.type === 'deadline' && (
          <Button variant="primary" busy={act.busy} onClick={() => void run(() => careerApi.setDeadlineStatus(item.ref.id, 'done'))}>完成</Button>
        )}
        {(item.kind === 'deadline' || item.kind === 'interview_today' || item.kind === 'followup') && item.ref.type === 'application' && (
          <Button variant="secondary" onClick={() => emitEvent('career:focus', { surface: 'dossier', application_id: item.ref.id } satisfies CareerFocusEvent)}>打开卷宗</Button>
        )}
        {item.kind === 'interview_today' && (
          <ChatActionButton text="帮我准备这场面试" context={{ surface: 'today', refs: item.ref.type === 'application' ? { application_id: item.ref.id } : refs }} />
        )}
        {item.kind === 'stale' && (
          <>
            <Button variant="danger" busy={act.busy} onClick={() => void run(() => careerApi.closeSilent(item.ref.id))}>关闭这条线</Button>
            <Button variant="ghost" onClick={() => onSnooze(item)}>再等等</Button>
          </>
        )}
        {item.kind === 'inbox' && (
          <Button variant="secondary" onClick={() => emitEvent('career:focus', { surface: 'inbox', id: item.ref.type === 'inbox_item' ? item.ref.id : null } satisfies CareerFocusEvent)}>去收件箱</Button>
        )}
        {item.kind === 'handoff' && (
          <Button variant="primary" onClick={onOpenChat}>打开对话接手</Button>
        )}
        {item.suggest && item.kind !== 'interview_today' && (
          <ChatActionButton text={item.suggest} context={{ surface: 'today', refs }} variant={item.kind === 'inbox' || item.kind === 'followup' ? 'primary' : 'secondary'} />
        )}
      </div>
    </Card>
  );
}

function WaitingRow({ waiting }: { waiting: { count: number; by_stage: Array<{ stage: string; n: number }> } }) {
  return (
    <section>
      <SectionTitle>等待中（{waiting.count}）</SectionTitle>
      <div className="flex flex-wrap items-center gap-1.5">
        {waiting.by_stage.length === 0 && <span className="text-xs text-[var(--subtle)]">暂时没有在等回音的投递。</span>}
        {waiting.by_stage.map(s => (
          <Badge key={s.stage} tone="neutral">{STAGE_LABELS[s.stage as ApplicationStage] ?? s.stage} {s.n}</Badge>
        ))}
      </div>
      <div className="mt-1.5 text-xs text-[var(--subtle)]">等待不需要你做任何事；超过阈值会自动出现在上面，你不用天天刷邮箱。</div>
    </section>
  );
}
