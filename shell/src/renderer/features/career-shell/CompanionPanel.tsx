/**
 * 对话页右侧的伙伴面板（specs/CAREER_DESIGN.md §5.4）：上半是陪伴宠物（形象、名字、状态），
 * 下半披露它在做什么——正在做（进度步骤）、接下来（今日队列）、今天做过（活动记录）。
 * 全部来自真实数据：career:progress 事件、/api/career/today、/api/career/activity。
 */
import { CheckCircle2, Clock, Globe, ListTodo, Loader2, Pencil, Settings, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { emitEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import type { ActivityEntry, CareerFocusEvent, TodayItem } from '@/components/career/types';
import { useCareerQuery } from '@/components/career/useCareerData';
import { useConfigData } from '@/config/useConfigData';
import { MINO_DEFAULT_PET_PACK } from '@/floating-ball/defaultPetPack';
import { resolveSelectedPetPack } from '@/floating-ball/petPackLibrary';
import { PetSprite } from '@/floating-ball/PetSprite';

import { requestNavigation } from './navModel';
import { useWorkSurfaces, type ProgressRun } from './workSurfaceStore';

/** PetSprite's own box rule lives in floating-ball/fb.css, which must not load in the main window. */
const PET_SPRITE_BOX = 'h-[82px] w-[76px] bg-no-repeat';

const TODAY_TABLES = ['deadline', 'action_queue', 'handoff', 'application', 'inbox_item', 'application_history'] as const;
const ACTIVITY_TABLES = ['task', 'application_history', 'action_queue', 'application'] as const;

type CompanionTab = 'now' | 'todo' | 'trail';

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

  const [tab, setTab] = useState<CompanionTab>('now');
  const openPetSettings = () => requestNavigation({ kind: 'settings', section: 'desktop-pet' });

  const status = handoff
    ? { dot: 'bg-[var(--warning)]', text: '等你处理一下' }
    : activeRun
      ? { dot: 'bg-[var(--success)]', text: activeRun.steps[activeRun.steps.length - 1]?.message ?? '正在工作' }
      : { dot: 'bg-[var(--success)]', text: '在你身边' };
  const animation = handoff ? 'waiting' : activeRun ? 'running' : 'idle';

  const urgent = items.filter(item => item.priority <= 1).length;
  const summary = !today.data
    ? null
    : items.length === 0
      ? '今天没有要赶的事'
      : urgent > 0 ? `今天 ${items.length} 件事，${urgent} 件急` : `今天 ${items.length} 件事，都不急`;

  return (
    <aside
      className="flex h-full w-[360px] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--side)]"
      aria-label="伙伴面板"
      data-companion-panel
    >
      <div className="relative flex shrink-0 flex-col items-center gap-1.5 px-5 pb-4 pt-6">
        <button
          type="button"
          onClick={openPetSettings}
          aria-label="伙伴设置"
          className="absolute right-4 top-5 grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <Settings className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <div className="relative grid h-28 w-28 place-items-center rounded-full bg-[var(--paper)] shadow-[0_0_0_4px_var(--paper),0_0_0_6px_var(--line-2)]">
          <PetSprite pack={pack} animation={animation} playback="loop" title={pack.displayName} className={PET_SPRITE_BOX} />
          <button
            type="button"
            onClick={openPetSettings}
            aria-label="换形象"
            className="absolute bottom-1 right-0 grid h-[30px] w-[30px] place-items-center rounded-full border-[1.5px] border-[var(--hard)] bg-[var(--paper)] text-[var(--ink)]"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-2 font-human text-xl font-semibold text-[var(--ink)]">{pack.displayName}</div>
        <div className="flex max-w-full items-center gap-1.5 text-sm text-[var(--muted)]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${status.dot}`} aria-hidden="true" />
          <span className="truncate">{status.text}</span>
        </div>
        {summary && (
          <div className="mt-1.5 rounded-sm bg-[var(--mint)] px-3 py-1.5 font-human text-sm text-[var(--ink-2)]">{summary}</div>
        )}
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
        {tab === 'now' && (
          <>
            <SectionHeading>正在做</SectionHeading>
            <NowSection run={activeRun} handoff={handoff} />
            <SectionHeading count={items.length}>接下来</SectionHeading>
            <TodoList items={items.slice(0, 3)} loading={today.loading && !today.data} />
            <SectionHeading>今天做过</SectionHeading>
            <TrailList entries={entries.slice(0, 3)} loading={activity.loading && !activity.data} />
          </>
        )}
        {tab === 'todo' && (
          <>
            <SectionHeading count={items.length}>接下来</SectionHeading>
            <TodoList items={items} loading={today.loading && !today.data} />
          </>
        )}
        {tab === 'trail' && (
          <>
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
 * 点一条待办去它该去的地方：投递相关 → 那条投递的档案；待批准 → 岗位收藏里的审批卡；
 * 收件箱 → 收件箱；需要你接手 → 展开浏览器侧栏；其余 → 今日。
 */
export function openTodoItem(item: TodayItem): void {
  const { type, id } = item.ref;
  if (item.kind === 'handoff') { emitEvent('career:focus', { surface: 'live_drawer' }); return; }
  if (item.kind === 'review' || type === 'action') { requestNavigation({ kind: 'career-dossier', view: 'apply' }); return; }
  if (type === 'application') { emitEvent('career:focus', { surface: 'dossier', application_id: id } satisfies CareerFocusEvent); return; }
  if (type === 'job') { emitEvent('career:focus', { surface: 'dossier', job_id: id } satisfies CareerFocusEvent); return; }
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

/** 展开工作面时伙伴缩成的浮动头像，浮在对话区左上角，带一句当前状态。 */
export function CompanionChip() {
  const { config } = useConfigData();
  const [pack, setPack] = useState(MINO_DEFAULT_PET_PACK);
  useEffect(() => {
    let cancelled = false;
    void resolveSelectedPetPack(config.floatingBallPetId).then(next => { if (!cancelled) setPack(next); });
    return () => { cancelled = true; };
  }, [config.floatingBallPetId]);
  const { runs, takeover } = useWorkSurfaces();
  const activeRun = runs.find(run => !run.finished) ?? null;
  const handoff = takeover?.state === 'paused' || takeover?.state === 'human_active';
  const text = handoff ? '等你处理一下' : activeRun?.steps[activeRun.steps.length - 1]?.message ?? '在你身边';
  return (
    <div
      className="pointer-events-none absolute left-4 top-14 z-20 flex max-w-[260px] items-center gap-2 rounded-full border-[1.5px] border-[var(--hard)] bg-[var(--paper)] py-1 pl-1 pr-3 shadow-hard"
      data-companion-chip
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--inset)]">
        <span className="origin-center scale-[0.4]">
          <PetSprite pack={pack} animation={handoff ? 'waiting' : activeRun ? 'running' : 'idle'} playback="loop" className={PET_SPRITE_BOX} />
        </span>
      </span>
      <span className="min-w-0">
        <span className="block font-human text-sm font-semibold leading-[18px] text-[var(--ink)]">{pack.displayName}</span>
        <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${handoff ? 'bg-[var(--warning)]' : 'bg-[var(--success)]'}`} aria-hidden="true" />
          <span className="truncate">{text}</span>
        </span>
      </span>
    </div>
  );
}
