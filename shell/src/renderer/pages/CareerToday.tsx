/**
 * 招聘概览：左边一整月的月历，右边是选中那天的待办（默认今天）。
 * 每天最多三类待办——待批准 / 需要你处理 / 提醒——各占一行，只写第一件；那天这一类还有没做完的，圆点点亮，全做完变灰。
 * 页面只做非 AI 动作（批准 / 完成 / 关闭），完成时把这一行「划掉」；要助理做的事一律通过 ChatActionButton 发进对话。
 * 以后要做的事在底部的输入框（PageAskBar）里跟小芽说（deadline_add）。
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { ACTION_KIND_LABELS } from '@/components/career/careerConstants';
import { Button, CareerPage, ChatActionButton, ErrorRow, LoadingRow } from '@/components/career/CareerPrimitives';
import { onOnboardingIntroRequest, takeOnboardingIntroRequest } from '@/features/career-shell/onboardingReminder';
import { PageAskBar } from '@/features/career-shell/PageAskBar';
import { isManualSendKind, manualSendText } from '@/components/career/manualSendActions';
import { ManualSendText } from '@/components/career/ManualSendText';
import { OnboardingIntro, buildSteps, markIntroSeen, readIntroSeen } from '@/components/career/OnboardingIntro';
import { StrikeText } from '@/components/career/StrikeText';
import {
  CATEGORY_COLORS, CATEGORY_LABELS, TODO_CATEGORIES, buildTodos, groupByDate, localDateKey, mergeCompleted, monthGrid, summarizeDay,
} from '@/components/career/todoCalendar';
import type { CalendarTodo, TodoCategory } from '@/components/career/todoCalendar';
import type { CareerFocusEvent, TodayItemKind } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

const TODAY_TABLES = ['deadline', 'action_queue', 'handoff', 'application', 'inbox_item', 'application_history'] as const;
const ONBOARDING_TABLES = ['experience', 'claim', 'resume_master', 'mail_account', 'job', 'application', 'material'] as const;
const ACTION_TABLES = ['action_queue'] as const;
const DEADLINE_TABLES = ['deadline'] as const;
const ACTIVITY_TABLES = ['action_queue', 'task', 'application_history'] as const;

const KIND_LABELS: Record<TodayItemKind, string> = {
  deadline: '截止', review: '待批准', handoff: '需要你', interview_today: '今日面试', stale: '静默', inbox: '通知', followup: '跟进',
};
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;
const STRIKE_MS = 700;

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

function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const weekday = WEEKDAYS[(new Date(y, m - 1, d).getDay() + 6) % 7];
  return `${m} 月 ${d} 日 · 周${weekday}`;
}

export default function CareerToday({ onOpenChat, embedded = false }: CareerPageProps) {
  const now = new Date();
  const todayKey = localDateKey(now);
  const [cursor, setCursor] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const [selected, setSelected] = useState(todayKey);
  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const gridStartIso = grid[0].toISOString();

  const today = useCareerQuery(careerApi.today, TODAY_TABLES);
  const pending = useCareerQuery(careerApi.pendingActions, ACTION_TABLES);
  const confirming = useCareerQuery(() => careerApi.actionsNeedingUser().catch(() => []), ACTION_TABLES);
  const deadlines = useCareerQuery(() => careerApi.deadlines(), DEADLINE_TABLES);
  const activity = useCareerQuery(() => careerApi.activity(gridStartIso).catch(() => []), ACTIVITY_TABLES);
  const onboarding = useCareerQuery(careerApi.onboarding, ONBOARDING_TABLES);

  // 翻到别的月份时补拉那段时间的活动记录（已完成的动作）。
  const activityReload = activity.reload;
  const lastGridStart = useRef(gridStartIso);
  useEffect(() => {
    if (lastGridStart.current === gridStartIso) return;
    lastGridStart.current = gridStartIso;
    activityReload();
  }, [gridStartIso, activityReload]);

  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'today') return;
    topRef.current?.scrollIntoView?.({ block: 'start' });
  }), []);

  // 本次会话里刚划掉的项：服务端刷新后它们可能从今日队列消失，这里留住，保持已完成样式。
  const [completed, setCompleted] = useState<ReadonlyMap<string, CalendarTodo>>(() => new Map());
  const [justDone, setJustDone] = useState<ReadonlySet<string>>(() => new Set());
  // 「再等等」只在本次会话里隐藏，不改服务端状态。
  const [snoozed, setSnoozed] = useState<ReadonlySet<string>>(() => new Set());

  const todos = useMemo(() => {
    const built = buildTodos({
      today: today.data?.items, pending: pending.data, confirming: confirming.data,
      deadlines: deadlines.error ? null : deadlines.data, activity: activity.data,
    });
    return mergeCompleted(built, completed).filter(t => !snoozed.has(t.key));
  }, [today.data, pending.data, confirming.data, deadlines.data, deadlines.error, activity.data, completed, snoozed]);
  const byDate = useMemo(() => groupByDate(todos), [todos]);
  const todayOpen = (byDate.get(todayKey) ?? []).filter(t => !t.done).length;

  const reloadAll = () => { today.reload(); pending.reload(); confirming.reload(); deadlines.reload(); activity.reload(); };
  const markDone = (todo: CalendarTodo, note: string) => {
    setCompleted(prev => new Map(prev).set(todo.key, { ...todo, done: true, note }));
    setJustDone(prev => new Set(prev).add(todo.key));
    window.setTimeout(() => setJustDone(prev => { const next = new Set(prev); next.delete(todo.key); return next; }), STRIKE_MS);
    reloadAll();
  };
  const snooze = (todo: CalendarTodo) => setSnoozed(prev => new Set(prev).add(todo.key));

  // 首次打开自动弹出新手引导（五步都做完就不打扰）；页头「新手引导」随时再开。
  const steps = useMemo(() => (onboarding.data ? buildSteps(onboarding.data) : null), [onboarding.data]);
  const [seenAtMount] = useState(readIntroSeen);
  const [introDismissed, setIntroDismissed] = useState(false);
  // 从 Mino 面板 / 桌面悬浮球的每日提醒点进来：直接打开引导。
  const [introRequested, setIntroRequested] = useState(takeOnboardingIntroRequest);
  const introOpen = !!steps && (introRequested || (!seenAtMount && !introDismissed && steps.some(s => !s.done)));
  const closeIntro = () => { markIntroSeen(); setIntroDismissed(true); setIntroRequested(false); };
  useEffect(() => onOnboardingIntroRequest(() => setIntroRequested(true)), []);

  const shiftMonth = (delta: number) => setCursor(c => {
    const d = new Date(c.year, c.month + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const goToday = () => { setCursor({ year: now.getFullYear(), month: now.getMonth() }); setSelected(todayKey); };
  const selectDay = (date: Date) => {
    setSelected(localDateKey(date));
    if (date.getMonth() !== cursor.month) setCursor({ year: date.getFullYear(), month: date.getMonth() });
  };

  const waitingCount = today.data?.waiting.count ?? 0;
  const subtitle = today.data ? `今天 ${todayOpen} 件没做完${waitingCount > 0 ? ` · ${waitingCount} 家在等回音` : ''}` : undefined;
  const loadError = today.error ?? pending.error;

  return (
    <div className="relative h-full min-h-0">
      <CareerPage
        embedded={embedded}
        title="招聘概览"
        subtitle={subtitle}
        actions={steps && <Button variant="ghost" size="sm" onClick={() => setIntroRequested(true)}>新手引导</Button>}
      >
        <div ref={topRef} className="flex min-h-full flex-col">
          <div className="flex flex-1 flex-col gap-6 px-6 pt-5 lg:flex-row">
            <section aria-label="月历" className="min-w-0 flex-1">
              {loadError && <ErrorRow message={loadError} onRetry={reloadAll} />}
              {today.loading && !today.data && <LoadingRow />}
              <MonthGrid
                title={`${cursor.year} 年 ${cursor.month + 1} 月`}
                nav={(
                  <>
                    <Button variant="ghost" size="sm" aria-label="上个月" onClick={() => shiftMonth(-1)}><ChevronLeft className="h-4 w-4" strokeWidth={1.75} /></Button>
                    <Button variant="secondary" size="sm" onClick={goToday}>今天</Button>
                    <Button variant="ghost" size="sm" aria-label="下个月" onClick={() => shiftMonth(1)}><ChevronRight className="h-4 w-4" strokeWidth={1.75} /></Button>
                  </>
                )}
                grid={grid}
                month={cursor.month}
                todayKey={todayKey}
                selected={selected}
                byDate={byDate}
                onSelect={selectDay}
              />
              <Legend />
            </section>
            <DaySidebar
              dateKey={selected}
              isToday={selected === todayKey}
              todos={byDate.get(selected) ?? []}
              justDone={justDone}
              onDone={markDone}
              onSnooze={snooze}
              onChanged={reloadAll}
              onOpenChat={onOpenChat}
            />
          </div>
          <PageAskBar target={{ kind: 'career-today' }} refs={{ date: selected }} placeholder="比如「10 月 20 日提醒我交测评」，或者问问今天先做哪件" />
        </div>
      </CareerPage>
      {introOpen && steps && <OnboardingIntro steps={steps} onClose={closeIntro} />}
    </div>
  );
}

// 一本挂在墙上的月历：顶上一排装订环，底下错开两张墨线纸露出厚度（硬边层次，跟按钮同一套语言），最底一张带柔阴影。
function MonthGrid({ title, nav, grid, month, todayKey, selected, byDate, onSelect }: {
  title: string; nav: ReactNode;
  grid: Date[]; month: number; todayKey: string; selected: string; byDate: Map<string, CalendarTodo[]>; onSelect: (date: Date) => void;
}) {
  const sheet = 'rounded-[var(--radius-lg)] border-[1.5px] border-[var(--ink)]';
  return (
    <div className="relative pb-2 pr-2 pt-2.5">
      <div aria-hidden className={`absolute bottom-0 left-2 right-0 top-[18px] bg-[var(--inset)] shadow-[var(--shadow-md)] ${sheet}`} />
      <div aria-hidden className={`absolute bottom-1 left-1 right-1 top-[14px] bg-[var(--paper)] ${sheet}`} />
      <div className={`relative overflow-hidden bg-[var(--paper)] shadow-[var(--shadow-sm)] ${sheet}`}>
        <div className="relative flex items-center gap-2 border-b-[1.5px] border-[var(--ink)] px-4 pb-2.5 pt-6">
          <BindingRow className="inset-x-0 top-1.5">{() => <span className="h-2.5 w-2.5 rounded-full bg-[var(--bg)] shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)]" />}</BindingRow>
          <h2 className="font-human text-xl font-semibold tabular-nums text-[var(--ink)]">{title}</h2>
          <div className="ml-auto flex items-center gap-1">{nav}</div>
        </div>
        <div className="grid grid-cols-7 border-b border-[var(--line-2)] bg-[var(--inset)]">
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`py-1.5 text-center font-human text-xs ${i >= 5 ? 'text-[var(--seal)]' : 'text-[var(--muted)]'}`}>{`周${w}`}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((date, i) => {
            const key = localDateKey(date);
            return (
              <DayCell
                key={key}
                date={date}
                inMonth={date.getMonth() === month}
                isToday={key === todayKey}
                isSelected={key === selected}
                weekend={i % 7 >= 5}
                lastCol={i % 7 === 6}
                lastRow={i >= 35}
                todos={byDate.get(key) ?? []}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </div>
      <BindingRow className="left-0 right-2 top-0">{() => <span className="h-5 w-2 rounded-full border-[1.5px] border-[var(--ink)] bg-[var(--line-2)]" />}</BindingRow>
    </div>
  );
}

const BINDING_RINGS = 12;

// 装订环和纸上的孔共用一套排布，环正好压在孔上。
function BindingRow({ className, children }: { className: string; children: () => ReactNode }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute flex justify-around px-10 ${className}`}>
      {Array.from({ length: BINDING_RINGS }, (_, i) => <span key={i} className="flex w-2 justify-center">{children()}</span>)}
    </div>
  );
}

function DayCell({ date, inMonth, isToday, isSelected, weekend, lastCol, lastRow, todos, onSelect }: {
  date: Date; inMonth: boolean; isToday: boolean; isSelected: boolean; weekend: boolean; lastCol: boolean; lastRow: boolean; todos: CalendarTodo[]; onSelect: (date: Date) => void;
}) {
  const summary = summarizeDay(todos);
  const open = todos.filter(t => !t.done).length;
  const label = `${date.getMonth() + 1}月${date.getDate()}日${isToday ? '（今天）' : ''}${todos.length ? `，${open} 件没做完，共 ${todos.length} 件` : ''}`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isSelected}
      data-date={localDateKey(date)}
      onClick={() => onSelect(date)}
      className={`flex min-h-[104px] min-w-0 flex-col gap-1 p-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)] ${lastCol ? '' : 'border-r'} ${lastRow ? '' : 'border-b'} border-[var(--line)] ${isSelected ? 'bg-[var(--selected)] shadow-[inset_0_0_0_1.5px_var(--ink)]' : 'hover:bg-[var(--hover)]'}`}
    >
      <span
        className={`inline-flex h-6 min-w-6 items-center justify-center self-start rounded-full px-1 text-xs tabular-nums ${isToday ? 'bg-[var(--primary)] font-semibold text-[var(--on-primary)]' : inMonth ? `font-medium ${weekend ? 'text-[var(--seal)]' : 'text-[var(--ink)]'}` : 'text-[var(--subtle)]'}`}
      >
        {date.getDate()}
      </span>
      {summary.map(s => (
        <span key={s.category} data-category={s.category} data-lit={s.lit ? 'true' : 'false'} className="flex min-w-0 items-center gap-1.5 text-xs">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.lit ? CATEGORY_COLORS[s.category] : 'var(--line-2)' }} />
          <span className={`min-w-0 flex-1 truncate ${s.lit ? 'text-[var(--ink-2)]' : 'text-[var(--subtle)] line-through'}`}>{s.first.item.title}</span>
          {s.count > 1 && <span className="shrink-0 tabular-nums text-[var(--muted)]">{`+${s.count - 1}`}</span>}
        </span>
      ))}
    </button>
  );
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
      {TODO_CATEGORIES.map(c => (
        <span key={c} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: CATEGORY_COLORS[c] }} />
          {CATEGORY_LABELS[c]}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--line-2)]" />
        都做完了
      </span>
    </div>
  );
}

function DaySidebar({ dateKey, isToday, todos, justDone, onDone, onSnooze, onChanged, onOpenChat }: {
  dateKey: string; isToday: boolean; todos: CalendarTodo[]; justDone: ReadonlySet<string>;
  onDone: (todo: CalendarTodo, note: string) => void; onSnooze: (todo: CalendarTodo) => void; onChanged: () => void; onOpenChat: () => void;
}) {
  const open = todos.filter(t => !t.done).length;
  const groups = TODO_CATEGORIES
    .map(category => ({
      category,
      // 排序不看完成与否：划掉的那行留在原位，不跳走。
      items: todos.filter(t => t.category === category).sort((a, b) => a.item.priority - b.item.priority || (a.item.due_at ?? '').localeCompare(b.item.due_at ?? '')),
    }))
    .filter(g => g.items.length > 0);
  return (
    <aside aria-label="当天待办" className="w-full shrink-0 rounded-[var(--radius-lg)] bg-[var(--side)] p-4 lg:w-[320px] lg:self-start">
      <div className="flex items-baseline gap-2">
        <h2 className="font-human text-lg font-semibold text-[var(--ink)]">{dayLabel(dateKey)}</h2>
        {isToday && <span className="text-xs font-medium text-[var(--primary)]">今天</span>}
      </div>
      <p className="mt-0.5 text-xs text-[var(--muted)]">
        {todos.length === 0 ? '这一天没有待办' : open === 0 ? `${todos.length} 件都划掉了` : `${open} 件没做完${todos.length > open ? ` · 已划掉 ${todos.length - open} 件` : ''}`}
      </p>
      {todos.length === 0 && (
        <p className="mt-4 text-sm text-[var(--muted)]">要加一件，直接在下面跟小芽说，比如「10 月 20 日提醒我交测评」。</p>
      )}
      <div className="mt-4 space-y-4">
        {groups.map(group => (
          <section key={group.category} aria-label={CATEGORY_LABELS[group.category]}>
            <CategoryHeading category={group.category} items={group.items} />
            <ul className="divide-y divide-[var(--line)]">
              {group.items.map(todo => (
                <TodoRow key={todo.key} todo={todo} animate={justDone.has(todo.key)} onDone={onDone} onSnooze={onSnooze} onChanged={onChanged} onOpenChat={onOpenChat} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}

function CategoryHeading({ category, items }: { category: TodoCategory; items: CalendarTodo[] }) {
  const open = items.filter(t => !t.done).length;
  return (
    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--muted)]">
      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: open > 0 ? CATEGORY_COLORS[category] : 'var(--line-2)' }} />
      {CATEGORY_LABELS[category]}
      <span className="tabular-nums">{open > 0 ? `${open} / ${items.length}` : items.length}</span>
    </div>
  );
}

function TodoRow({ todo, animate, onDone, onSnooze, onChanged, onOpenChat }: {
  todo: CalendarTodo; animate: boolean; onDone: (todo: CalendarTodo, note: string) => void; onSnooze: (todo: CalendarTodo) => void; onChanged: () => void; onOpenChat: () => void;
}) {
  const act = useCareerAction();
  const { item, action } = todo;
  const due = todo.done ? null : formatDue(item.due_at);
  const refs = { [`${item.ref.type}_id`]: item.ref.id };
  const complete = (fn: () => Promise<unknown>, note: string) => act.run(async () => { await fn(); onDone(todo, note); });

  const payload = action ? safeJson<Record<string, unknown>>(action.payload_json, {}) : {};
  const isSendMail = action?.kind === 'send_mail';
  const isReview = item.kind === 'review' && !todo.confirmSubmit;
  // 待投清单里没开始的填表：不是「批准」，而是「开始填写」（填到提交前会停下等你确认）
  const isFill = action?.kind === 'fill_form';
  // 招呼语 / 开放题回答批准后不由产品发送，而是变成「等你发出去」的一行（manualSend）。
  const approvedNote = action && isManualSendKind(action.kind) ? '已批准，待你发送' : '已批准';
  const sendText = todo.manualSend && action ? manualSendText(action) : null;
  const deadlineDone = (item.kind === 'deadline' || item.kind === 'interview_today') && item.ref.type === 'deadline';
  const applicationId = todo.applicationId ?? (item.ref.type === 'application' ? item.ref.id : null);
  const openDossier = () => emitEvent('career:focus', { surface: 'dossier', application_id: applicationId } satisfies CareerFocusEvent);
  const carried = !todo.done && todo.originDate && todo.originDate !== todo.date ? todo.originDate.slice(5).replace('-', '/') : null;
  const meta = [
    action ? ACTION_KIND_LABELS[action.kind] ?? action.kind : KIND_LABELS[item.kind] ?? item.kind,
    isSendMail && typeof payload.to === 'string' ? `收件人：${payload.to}` : null,
    item.detail ?? null,
  ].filter(Boolean).join(' · ');

  return (
    <li data-todo={todo.key} data-done={todo.done ? 'true' : 'false'} className="py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <StrikeText done={todo.done} animate={animate} className={`min-w-0 flex-1 ${todo.done ? '' : 'font-medium text-[var(--ink)]'}`}>{item.title}</StrikeText>
        {todo.done && todo.note && <span className="shrink-0 text-xs text-[var(--subtle)]">{todo.note}</span>}
        {due && <span className={`shrink-0 text-xs tabular-nums ${due === '已过期' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`}>{due}</span>}
        {!due && carried && <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]">{`${carried} 起`}</span>}
      </div>
      {meta && !todo.done && <div className="mt-0.5 truncate text-xs text-[var(--muted)]" title={meta}>{meta}</div>}
      {act.error && <div className="mt-1.5"><ErrorRow message={act.error} onRetry={onChanged} /></div>}
      {!todo.done && sendText && action && <ManualSendText text={sendText} actionId={action.id} onSent={note => onDone(todo, note)} />}
      {!todo.done && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {isReview && (
            <>
              <Button variant="primary" size="sm" busy={act.busy} onClick={() => void complete(() => careerApi.reviewActions([item.ref.id], 'approved'), isFill ? '开始填写' : approvedNote)}>{isSendMail ? '批准并发送' : isFill ? '开始填写' : '批准'}</Button>
              <Button variant="ghost" size="sm" busy={act.busy} onClick={() => void complete(() => careerApi.reviewActions([item.ref.id], 'rejected'), isFill ? '已移出' : '不发了')}>{isFill ? '移出清单' : '不发了'}</Button>
            </>
          )}
          {todo.confirmSubmit && (
            <>
              <Button variant="primary" size="sm" busy={act.busy} onClick={() => void complete(() => careerApi.confirmSubmit(item.ref.id, true), '已投递')}>已投递成功</Button>
              <Button variant="ghost" size="sm" busy={act.busy} onClick={() => void complete(() => careerApi.confirmSubmit(item.ref.id, false), '重新审核')}>没投出去</Button>
            </>
          )}
          {deadlineDone && (
            <Button variant="primary" size="sm" busy={act.busy} onClick={() => void complete(() => careerApi.setDeadlineStatus(item.ref.id, 'done'), '已完成')}>完成</Button>
          )}
          {item.kind === 'interview_today' && (
            <ChatActionButton size="sm" variant="ghost" text="帮我准备这场面试" context={{ surface: 'today', refs: applicationId ? { application_id: applicationId } : refs }} />
          )}
          {item.kind === 'stale' && (
            <>
              <Button size="sm" busy={act.busy} onClick={() => void complete(() => careerApi.closeSilent(item.ref.id), '已关闭')}>关闭这条线</Button>
              <Button variant="ghost" size="sm" onClick={() => onSnooze(todo)}>再等等</Button>
            </>
          )}
          {item.kind === 'inbox' && (
            <Button size="sm" onClick={() => emitEvent('career:focus', { surface: 'inbox', id: item.ref.type === 'inbox_item' ? item.ref.id : null } satisfies CareerFocusEvent)}>去通知中心</Button>
          )}
          {item.kind === 'handoff' && !todo.confirmSubmit && !todo.manualSend && (
            <Button variant="primary" size="sm" onClick={onOpenChat}>打开对话接手</Button>
          )}
          {item.suggest && item.kind !== 'interview_today' && (
            <ChatActionButton size="sm" variant="ghost" text={item.suggest} context={{ surface: 'today', refs }} />
          )}
          {applicationId && item.kind !== 'review' && (
            <Button variant="ghost" size="sm" onClick={openDossier}>在投递记录里看</Button>
          )}
        </div>
      )}
    </li>
  );
}
