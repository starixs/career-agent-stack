/**
 * 本周甘特：每行一件有截止时间的事（笔试、测评、面试、网申截止……），细线从事情出现画到截止，截止处一个圆点，
 * 颜色是完成状态（状态色，配文字列，不单靠颜色）。最上面一行是每日投出数，悬停看平台构成。
 */
import type { ReactNode } from 'react';

import { DEADLINE_KIND_LABELS, PLATFORM_LABELS } from '@/components/career/careerConstants';
import type { GanttItem, GanttStatus, ReviewBoard } from '@/components/career/types';

import { formatMoment, openApplication, openApplications, shortDate, weekdayOf } from './reviewLinks';

const DAY_MS = 86_400_000;

export const GANTT_STATUS: Record<GanttStatus, { label: string; color: string }> = {
  done: { label: '已完成', color: 'var(--success)' },
  open: { label: '待完成', color: 'var(--primary)' },
  missed: { label: '已错过', color: 'var(--danger)' },
  cancelled: { label: '已取消', color: 'var(--line-2)' },
};

const GRID = 'grid grid-cols-[minmax(150px,220px)_1fr_72px] items-center gap-x-3';
/** 每天一格的竖向细线（装饰性边界）。 */
const DAY_LINES = { backgroundImage: 'linear-gradient(to right, var(--line) 1px, var(--bg-a0) 1px)', backgroundSize: 'calc(100% / 7) 100%' };

export function ReviewWeekGantt({ board, now = new Date() }: { board: ReviewBoard; now?: Date }) {
  const { week, gantt, daily, undated } = board;
  const tz = week.tz_offset_minutes;
  const wsMs = Date.parse(week.start + 'T00:00:00Z') - tz * 60_000;
  const pos = (ms: number) => Math.min(100, Math.max(0, ((ms - wsMs) / (7 * DAY_MS)) * 100));
  const nowPct = week.is_current ? pos(now.getTime()) : null;
  const todayIdx = nowPct === null ? -1 : Math.min(6, Math.floor((nowPct / 100) * 7));
  const maxDaily = Math.max(1, ...daily.map(d => d.n));
  const nowLine = nowPct !== null && <span className="pointer-events-none absolute inset-y-0 w-px bg-[var(--primary)]" style={{ left: `${nowPct}%` }} aria-hidden />;

  return (
    <div className="space-y-2">
      <Legend showNow={nowPct !== null} />
      <div className="min-w-[640px]">
        {/* 表头：星期 */}
        <div className={`${GRID} pb-1 text-xs text-[var(--muted)]`}>
          <span />
          <div className="grid grid-cols-7">
            {week.days.map((d, i) => (
              <span key={d} className={`px-1 ${i === todayIdx ? 'font-medium text-[var(--primary)]' : ''}`}>{weekdayOf(d)} <span className="tabular-nums">{shortDate(d)}</span></span>
            ))}
          </div>
          <span className="text-right">状态</span>
        </div>

        {/* 每日投出 */}
        <div className={`${GRID} border-t border-[var(--line)] py-2`}>
          <div>
            <div className="text-sm text-[var(--ink)]">每日投出</div>
            <div className="text-xs text-[var(--muted)]">本周 {board.kpis.applied} 条</div>
          </div>
          <div className="relative grid h-14 grid-cols-7" style={DAY_LINES}>
            {daily.map(d => (
              <div key={d.date} className="group relative flex items-end justify-center">
                {d.n > 0 && (
                  <button
                    type="button"
                    aria-label={`${weekdayOf(d.date)} 投出 ${d.n} 条：${d.by_platform.map(p => `${PLATFORM_LABELS[p.key] ?? p.key} ${p.n}`).join('、')}`}
                    className="flex h-full w-6 flex-col items-center justify-end outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                    onClick={() => openApplications(`${shortDate(d.date)} ${weekdayOf(d.date)}投出的`, d.application_ids)}
                  >
                    <span className="text-xs tabular-nums text-[var(--ink-2)]">{d.n}</span>
                    <span className="w-full rounded-t-[var(--radius-sm)] bg-[var(--primary)]" style={{ height: `${Math.max(3, (d.n / maxDaily) * 36)}px` }} />
                  </button>
                )}
                {d.n > 0 && (
                  <Tip below>
                    <div className="font-medium text-[var(--ink)]">{weekdayOf(d.date)} {shortDate(d.date)} · 投出 {d.n} 条</div>
                    {d.by_platform.map(p => <div key={p.key} className="flex justify-between gap-4"><span>{PLATFORM_LABELS[p.key] ?? p.key}</span><span className="tabular-nums">{p.n}</span></div>)}
                  </Tip>
                )}
              </div>
            ))}
            {nowLine}
          </div>
          <span />
        </div>

        {/* 事项 */}
        {gantt.map(item => <GanttRow key={item.id} item={item} pos={pos} wsMs={wsMs} tz={tz} nowLine={nowLine} />)}
        {gantt.length === 0 && (
          <div className="border-t border-[var(--line)] py-6 text-center text-xs text-[var(--subtle)]">
            这周没有带截止时间的事。笔试、测评、面试通知会从邮件和收件箱自动记进来。
          </div>
        )}
      </div>
      {undated.length > 0 && (
        <p className="text-xs text-[var(--muted)]">
          另有 {undated.length} 件时间待定：{undated.slice(0, 5).map(u => `${u.company_name ? `${u.company_name} ` : ''}${DEADLINE_KIND_LABELS[u.kind] ?? u.title}`).join('、')}{undated.length > 5 ? ' 等' : ''}
        </p>
      )}
    </div>
  );
}

function GanttRow({ item, pos, wsMs, tz, nowLine }: { item: GanttItem; pos: (ms: number) => number; wsMs: number; tz: number; nowLine: ReactNode }) {
  const startMs = Date.parse(item.start);
  const endMs = Date.parse(item.end);
  const from = pos(startMs);
  const to = pos(endMs);
  const endsAfter = endMs >= wsMs + 7 * DAY_MS;
  const status = GANTT_STATUS[item.status];
  const kind = DEADLINE_KIND_LABELS[item.kind] ?? '事项';
  const due = formatMoment(item.end, tz);
  const label = `${item.title}，${kind}，${item.kind === 'interview' ? '时间' : '截止'} ${due}，${status.label}`;
  const body = (
    <>
      <div className="min-w-0">
        <div className={`truncate text-sm ${item.status === 'cancelled' ? 'text-[var(--subtle)] line-through' : 'text-[var(--ink)]'}`} title={item.title}>{item.title}</div>
        <div className="truncate text-xs text-[var(--muted)]">{kind} · {due}</div>
      </div>
      <div className="group relative h-10" style={DAY_LINES}>
        <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full" style={{ left: `${from}%`, width: `${Math.max(0, to - from)}%`, background: status.color }} aria-hidden />
        {endsAfter
          ? <span className="absolute right-0 top-1/2 -translate-y-1/2 bg-[var(--bg)] pl-1.5 text-xs text-[var(--muted)]" aria-hidden>→ {due.split(' ')[0]}</span>
          : <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--bg)]" style={{ left: `${to}%`, background: status.color }} aria-hidden />}
        {nowLine}
        <Tip at={Math.min(to, 70)}>
          <div className="font-medium text-[var(--ink)]">{item.title}</div>
          <div>{kind}{item.company_name ? ` · ${item.company_name}` : ''}</div>
          <div>{item.kind === 'interview' ? '时间' : '截止'} {due}</div>
          <div>{formatMoment(item.start, tz).split(' ').slice(0, 2).join(' ')} 记下 · {status.label}</div>
        </Tip>
      </div>
      <span className="flex items-center justify-end gap-2 text-xs font-medium" style={{ color: item.status === 'cancelled' ? 'var(--muted)' : status.color }}>
        <span className="h-4 w-[3px] rounded-full" style={{ background: status.color }} aria-hidden />
        {status.label}
      </span>
    </>
  );
  const rowClass = `${GRID} w-full border-t border-[var(--line)] py-1 text-left`;
  return item.application_id ? (
    <button type="button" aria-label={label} className={`${rowClass} hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]`} onClick={() => openApplication(item.application_id!)}>
      {body}
    </button>
  ) : (
    <div role="group" aria-label={label} className={rowClass}>{body}</div>
  );
}

/** 悬停 / 聚焦时浮出的小提示（纯 CSS：父元素带 group）。 */
function Tip({ children, at, below = false }: { children: ReactNode; at?: number; below?: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute ${below ? 'top-full mt-1' : 'bottom-full mb-1'} z-[80] hidden min-w-40 whitespace-nowrap rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-xs text-[var(--ink-2)] shadow-[var(--shadow-md)] group-hover:block group-focus-within:block`}
      style={at === undefined ? undefined : { left: `${at}%` }}
    >
      {children}
    </div>
  );
}

function Legend({ showNow }: { showNow: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]" aria-label="图例">
      {(Object.keys(GANTT_STATUS) as GanttStatus[]).map(k => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: GANTT_STATUS[k].color }} aria-hidden />
          {GANTT_STATUS[k].label}
        </span>
      ))}
      <span className="flex items-center gap-1.5"><span className="h-1 w-4 rounded-full bg-[var(--muted)]" aria-hidden />从记下到截止</span>
      {showNow && <span className="flex items-center gap-1.5"><span className="h-3 w-px bg-[var(--primary)]" aria-hidden />现在</span>}
    </div>
  );
}
