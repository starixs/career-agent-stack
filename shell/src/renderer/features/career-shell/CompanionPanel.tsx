/**
 * 对话页右侧的伙伴面板（specs/CAREER_DESIGN.md §5.4）：上半是陪伴宠物（形象可换，名字固定「小芽」、状态、陪你第几天），
 * 下半披露它在做什么（主线体验 §6.1a，11-02）：后台在做什么全在这里，不进对话——此刻 = 主线进度、
 * 简历草稿（建档时是主角）、几个后台岗位、今天三个数、刚投出；足迹 = 回执、学会了、今天做过。
 * 要他的事只在输入框上沿的等你条（规范 §5.2）：这里头部只写一句「有 N 件等你」，和等你条读同一份数据。
 * 全部来自真实数据：/api/career/rail、/api/career/experiences、/api/career/today、/api/career/activity、/api/career/asks。
 */
import { CheckCircle2, Clock, Globe, ListTodo, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { emitEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import { useWaitingAsks } from '@/components/career/delivery/useWaitingAsks';
import { requestOpenDeck } from '@/components/career/delivery/WaitingDock';
import type { ActivityEntry, CareerFocusEvent, TodayItem } from '@/components/career/types';
import { useCareerQuery } from '@/components/career/useCareerData';
import { useConfigData } from '@/config/useConfigData';
import { MINO_DEFAULT_PET_PACK } from '@/floating-ball/defaultPetPack';
import { resolveSelectedPetPack } from '@/floating-ball/petPackLibrary';
import { PetSprite } from '@/floating-ball/PetSprite';

import { requestNavigation } from './navModel';
import { BlockRows, Learned, MainlineProgress, PoolPanel, RailHeading, Receipts, RecentReceipts, ResumeChip, ResumeDraft, TodayStrip } from './RailSections';
import { useWorkSurfaces, type ProgressRun } from './workSurfaceStore';

/** PetSprite's own box rule lives in floating-ball/fb.css, which must not load in the main window. */
const PET_SPRITE_BOX = 'h-[82px] w-[76px] bg-no-repeat';

const TODAY_TABLES = ['deadline', 'action_queue', 'handoff', 'application', 'inbox_item', 'application_history', 'mail_account'] as const;
const ACTIVITY_TABLES = ['task', 'application_history', 'action_queue', 'application'] as const;
const RAIL_TABLES = ['experience', 'claim', 'resume_master', 'resume_tailored', 'action_queue', 'application', 'application_history', 'handoff', 'kv', 'mail_account', 'task', 'job'] as const;
const EXPERIENCE_TABLES = ['experience', 'claim'] as const;

type CompanionTab = 'now' | 'todo' | 'trail';

/** 伙伴的名字：形象包可以换，名字不跟形象包走。 */
export const COMPANION_NAME = '小芽';
/** 这台电脑第一次打开伙伴面板的时间，用来算「陪你第 N 天」；只存本机。 */
const FIRST_SEEN_KEY = 'career.companionFirstSeenAt';
const DAY_MS = 86_400_000;
/** 待办里不再列的：要他处理的事只在等你条（规范 §5.2）。 */
const ASK_KINDS: ReadonlySet<TodayItem['kind']> = new Set(['handoff', 'review']);

/** 第一次见面的时间：读不到就记下现在；本机存储不可用时返回 null（不显示天数）。 */
function firstSeenAt(now: number): number | null {
  try {
    const stored = Number(window.localStorage.getItem(FIRST_SEEN_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
    window.localStorage.setItem(FIRST_SEEN_KEY, String(now));
    return now;
  } catch (error) {
    console.warn('[career] companion: 本机存储不可用，不显示陪伴天数', error);
    return null;
  }
}

/** 按本地日历日算第几天（同一天是第 1 天）。 */
export function companionDay(firstAt: number | null, now = Date.now()): number | null {
  if (firstAt === null) return null;
  const day = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  return Math.max(1, Math.round((day(now) - day(firstAt)) / DAY_MS) + 1);
}

/** 头部那一句：只数要他的事，和等你条同一个数。 */
export function waitingSummary(count: number): string {
  return count > 0 ? `有 ${count} 件等你` : '没有要你的事';
}

function localMidnightIso(now = new Date()): string {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return midnight.toISOString();
}

/** Remaining-time label + status colour (§6.2 截止紧迫度). */
export function deadlineLabel(dueAt: string | null | undefined, now = Date.now()): { text: string; tone: 'danger' | 'warning' | 'muted' } | null {
  if (!dueAt) return null;
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return null;
  const hours = (due - now) / 3_600_000;
  if (hours < 0) return { text: '已逾期', tone: 'danger' };
  if (hours < 24) return { text: `剩 ${Math.max(1, Math.round(hours))} 小时`, tone: 'danger' };
  if (hours < 72) return { text: `剩 ${Math.round(hours / 24)} 天`, tone: 'warning' };
  const date = new Date(due);
  return { text: `${date.getMonth() + 1} 月 ${date.getDate()} 日`, tone: 'muted' };
}

const TONE_CLASS = { danger: 'text-[var(--danger)]', warning: 'text-[var(--warning)]', muted: 'text-[var(--muted)]' } as const;

function StatusTag({ text, tone }: { text: string; tone: keyof typeof TONE_CLASS }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap border-l-[3px] border-current pl-2 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {text}
    </span>
  );
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function CompanionPanel() {
  const { config } = useConfigData();
  const [pack, setPack] = useState(MINO_DEFAULT_PET_PACK);
  useEffect(() => {
    let cancelled = false;
    void resolveSelectedPetPack(config.floatingBallPetId).then(next => { if (!cancelled) setPack(next); });
    return () => { cancelled = true; };
  }, [config.floatingBallPetId]);

  const { runs, takeover } = useWorkSurfaces();
  const activeRun = runs.find(run => !run.finished) ?? null;
  const handoff = takeover?.state === 'paused';

  const today = useCareerQuery(careerApi.today, TODAY_TABLES);
  const [since] = useState(localMidnightIso);
  const activity = useCareerQuery(() => careerApi.activity(since), ACTIVITY_TABLES);
  const items = today.data?.items ?? [];
  const entries = activity.data ?? [];
  const rail = useCareerQuery(careerApi.rail, RAIL_TABLES);
  const experiences = useCareerQuery(careerApi.experiences, EXPERIENCE_TABLES);
  const [draftOpen, setDraftOpen] = useState(false);
  const waiting = useWaitingAsks();
  const [day] = useState(() => companionDay(firstSeenAt(Date.now())));

  const [tab, setTab] = useState<CompanionTab>('now');

  const status = handoff
    ? { dot: 'bg-[var(--warning)]', text: '等你处理一下' }
    : activeRun
      ? { dot: 'bg-[var(--success)]', text: activeRun.steps[activeRun.steps.length - 1]?.message ?? '正在工作' }
      : { dot: 'bg-[var(--success)]', text: '在你身边' };
  const animation = handoff ? 'waiting' : activeRun ? 'running' : 'idle';

  const todos = items.filter(item => !ASK_KINDS.has(item.kind));
  const summary = waitingSummary(waiting.asks.length);

  return (
    <aside
      className="flex h-full w-[300px] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--side)]"
      aria-label="伙伴面板"
      data-companion-panel
    >
      <div className="relative flex shrink-0 flex-col items-center gap-1 px-5 pb-3 pt-4">
        <div className="relative grid h-20 w-20 place-items-center rounded-full bg-[var(--paper)] shadow-[0_0_0_4px_var(--paper),0_0_0_6px_var(--line-2)]">
          <PetSprite pack={pack} animation={animation} playback="loop" title={COMPANION_NAME} className={PET_SPRITE_BOX} />
{/* 换形象：设置里的桌面宠物内测先收起（face-slim 等你定），入口一起收 */}
        </div>
        <div className="mt-2 font-human text-xl font-semibold text-[var(--ink)]" data-testid="companion-name">{COMPANION_NAME}</div>
        <div className="flex max-w-full items-center gap-1.5 text-sm text-[var(--muted)]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${status.dot}`} aria-hidden="true" />
          <span className="truncate">{status.text}</span>
          {day !== null && <span className="shrink-0">· 陪你第 {day} 天</span>}
        </div>
        <div className="mt-1.5 rounded-sm bg-[var(--mint)] px-3 py-1.5 font-human text-sm text-[var(--ink-2)]" data-testid="companion-summary">{summary}</div>
      </div>

      <div role="tablist" aria-label="伙伴面板视图" className="mx-4 grid shrink-0 grid-cols-3 rounded-[10px] bg-[var(--inset)] p-[3px]">
        {([
          ['now', '此刻', Sparkles],
          ['todo', '待办', ListTodo],
          ['trail', '足迹', Clock],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex h-[30px] items-center justify-center gap-1 rounded-lg font-human text-sm transition-colors ${
              tab === id ? 'bg-[var(--paper)] text-[var(--ink)] shadow-[0_1px_0_var(--line-2)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />{label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {tab === 'now' && !rail.data && (
          <p className="mx-1 mt-4 text-xs text-[var(--subtle)]" data-testid="rail-placeholder">{rail.error ? '这里暂时没读到，过一会儿再看。' : '在准备…'}</p>
        )}
        {tab === 'now' && rail.data && (
          <>
            <MainlineProgress stage={rail.data.stage} />
            {/* 右栏随阶段换主角（§6.7）：建档时简历草稿是主角；建档完收成一枚小块，点一下临时展开 */}
            {rail.data.stage === 'profile'
              ? (<><RailHeading>你的简历，正在长</RailHeading><ResumeDraft experiences={experiences.data ?? []} /></>)
              : (<><ResumeChip count={(experiences.data ?? []).length} open={draftOpen} onToggle={() => setDraftOpen(v => !v)} />{draftOpen && <div className="mt-2"><ResumeDraft experiences={experiences.data ?? []} /></div>}</>)}
            {rail.data.stage === 'direction' && (<><RailHeading>按你的方向，岗位库里</RailHeading><PoolPanel pool={rail.data.pool} /></>)}
            <RailHeading>正在做</RailHeading>
            {activeRun && <NowSection run={activeRun} handoff={handoff} />}
            <BlockRows blocks={rail.data.blocks} handoff={handoff} />
            <TodayStrip today={rail.data.today} />
            <RecentReceipts receipts={rail.data.receipts} />
          </>
        )}
        {tab === 'todo' && (
          <>
            <SectionHeading count={todos.length}>接下来</SectionHeading>
            <TodoList items={todos} loading={today.loading && !today.data} />
          </>
        )}
        {tab === 'trail' && (
          <>
            <RailHeading count={rail.data?.receipts.length}>回执</RailHeading>
            <Receipts receipts={rail.data?.receipts ?? []} />
            <RailHeading count={rail.data?.learned.length}>学会了</RailHeading>
            <Learned learned={rail.data?.learned ?? []} onChanged={rail.reload} />
            <SectionHeading count={entries.length}>今天做过</SectionHeading>
            <TrailList entries={entries} loading={activity.loading && !activity.data} />
          </>
        )}
      </div>
    </aside>
  );
}

function SectionHeading({ children, count }: { children: string; count?: number }) {
  return (
    <h3 className="mx-1 mb-1.5 mt-4 flex items-center gap-1.5 font-human text-sm font-semibold text-[var(--ink-2)]">
      {children}
      {typeof count === 'number' && count > 0 && <span className="font-sans text-xs font-normal text-[var(--muted)]">{count}</span>}
    </h3>
  );
}

function NowSection({ run, handoff }: { run: ProgressRun | null; handoff: boolean }) {
  if (!run) {
    return (
      <p className="mx-1 text-xs text-[var(--subtle)]">
        {handoff ? '浏览器停在需要你本人操作的一步，打开浏览器栏处理。' : '现在没有在跑的任务。'}
      </p>
    );
  }
  const steps = run.steps.slice(-4);
  return (
    <div className="border-l-[3px] border-[var(--primary)] py-0.5 pl-3">
      <ul className="flex flex-col gap-0.5 text-xs">
        {steps.map((step, index) => {
          const current = index === steps.length - 1 && !run.finished;
          return (
            <li key={`${step.at}-${index}`} className={`flex items-center gap-1.5 ${current ? 'font-medium text-[var(--primary)]' : 'text-[var(--muted)]'}`}>
              {current
                ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" aria-hidden="true" />}
              <span className="min-w-0 truncate">{step.message}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 点一条待办去它该去的地方：投递相关 → 那条投递的档案；待批准 → 等你卡组（不跳岗位库）；
 * 收件箱 → 收件箱；需要你接手 → 展开浏览器侧栏；其余 → 今日。
 */
export function openTodoItem(item: TodayItem): void {
  const { type, id } = item.ref;
  if (item.kind === 'handoff') { emitEvent('career:focus', { surface: 'live_drawer' }); return; }
  if (item.kind === 'review' || type === 'action') { requestOpenDeck(); return; }
  if (type === 'application') { emitEvent('career:focus', { surface: 'dossier', application_id: id } satisfies CareerFocusEvent); return; }
  if (type === 'job') { emitEvent('career:focus', { surface: 'dossier', job_id: id } satisfies CareerFocusEvent); return; }
  // 邮箱连接失效：去通知中心，连接中心里点那张卡直接进拿授权码的引导
  if (item.kind === 'mail_auth') { emitEvent('career:focus', { surface: 'inbox' } satisfies CareerFocusEvent); return; }
  if (item.kind === 'inbox' || type === 'inbox_item') { emitEvent('career:focus', { surface: 'inbox', id: type === 'inbox_item' ? id : null } satisfies CareerFocusEvent); return; }
  requestNavigation({ kind: 'career-today' });
}

function TodoList({ items, loading }: { items: readonly TodayItem[]; loading: boolean }) {
  if (loading) return <p className="mx-1 text-xs text-[var(--subtle)]">加载中…</p>;
  if (items.length === 0) return <p className="mx-1 text-xs text-[var(--subtle)]">今天没有要赶的事。</p>;
  return (
    <ul className="flex flex-col">
      {items.map(item => {
        const deadline = deadlineLabel(item.due_at);
        return (
          <li key={`${item.ref.type}:${item.ref.id}:${item.kind}`}>
            <button
              type="button"
              onClick={() => openTodoItem(item)}
              title="打开"
              className="flex w-full items-start gap-2.5 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
            >
              <span className="mt-1 h-4 w-4 shrink-0 rounded-[5px] border-[1.5px] border-[var(--line-2)] bg-[var(--paper)]" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-human text-sm text-[var(--ink)]">{item.title}</span>
                {item.detail && <span className="block truncate text-xs text-[var(--muted)]">{item.detail}</span>}
              </span>
              {deadline && <StatusTag text={deadline.text} tone={deadline.tone} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const ACTIVITY_ICON = { task: Sparkles, stage: CheckCircle2, action: Globe } as const;

function TrailList({ entries, loading }: { entries: readonly ActivityEntry[]; loading: boolean }) {
  if (loading) return <p className="mx-1 text-xs text-[var(--subtle)]">加载中…</p>;
  if (entries.length === 0) return <p className="mx-1 text-xs text-[var(--subtle)]">今天还没有记录。</p>;
  return (
    <ul className="flex flex-col">
      {entries.map(entry => {
        const Icon = ACTIVITY_ICON[entry.kind];
        return (
          <li key={entry.id} className="flex gap-2.5 px-1 py-1.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--inset)] text-[var(--muted)]">
              <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="font-human text-sm font-semibold text-[var(--ink)]">{entry.title}</div>
              {entry.detail && <div className="truncate text-xs text-[var(--muted)]">{entry.detail}</div>}
              <div className="text-xs text-[var(--subtle)]">{timeOf(entry.at)}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

