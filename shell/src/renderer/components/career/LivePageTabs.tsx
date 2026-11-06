/**
 * 网申现场顶上的标签页：和浏览器的标签一个道理——一份网申一个标签，点哪个，画面和你的操作就落在那一家的页面上，
 * 下面的流程也跟着换成那一家的。
 *
 * 一个标签里三样东西是三个级别，用结构分开，不用「·」连成一串（2026-11-06 用户）：
 *  - 公司：认哪一家，主字；
 *  - 岗位：补充说明，第二行小字；
 *  - 状态：要不要他动手，用带颜色的图形（等他的是琥珀色实心点、小芽在做的转圈、投出了打钩）。
 * 在等他的几家排在前面（服务端排好的）；只开着一家也照样有标签（它是这一页是谁的唯一标识）。
 */
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

import { HANDOFF_REASON_LABELS } from './careerConstants';
import { LIVE_STATUS_TEXT, liveStatusOf, type LiveStatus } from './liveStage';

export interface LivePage { application_id: string; company: string; title: string; current: boolean; waiting: string | null }

/** 跨边界数据先过一遍：只认字段齐全的那几项。 */
export function parseLivePages(raw: unknown): LivePage[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { pages?: unknown }).pages) ? (raw as { pages: unknown[] }).pages : [];
  return list.flatMap(p => {
    if (!p || typeof p !== 'object') return [];
    const { application_id: id, company, title, current, waiting } = p as Record<string, unknown>;
    return typeof id === 'string' && typeof company === 'string'
      ? [{ application_id: id, company, title: typeof title === 'string' ? title : '', current: current === true, waiting: typeof waiting === 'string' && waiting ? waiting : null }]
      : [];
  });
}

/** 状态的图形：颜色说「谁的事」（琥珀 = 等他，蓝 = 小芽在做，绿 = 成了），形状说「什么事」。 */
export function LiveStatusMark({ status }: { status: LiveStatus }) {
  const box = 'flex h-3.5 w-3.5 shrink-0 items-center justify-center';
  switch (status) {
    case 'waiting':
    case 'ready':
      return <span className={box} aria-hidden><span className="h-2 w-2 rounded-full bg-[var(--warning)] ring-2 ring-[var(--warning-bg)]" /></span>;
    case 'filling':
    case 'sending':
      return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--primary)]" aria-hidden />;
    case 'done':
      return <Check className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" strokeWidth={3} aria-hidden />;
    case 'failed':
      return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]" aria-hidden />;
    case 'queued':
      return <span className={box} aria-hidden><span className="h-2 w-2 rounded-full border border-[var(--subtle)]" /></span>;
  }
}

/** 悬停 / 读屏的一句话：等他的说清等什么。 */
function statusHint(page: LivePage, status: LiveStatus): string {
  return status === 'waiting' && page.waiting ? `等你：${HANDOFF_REASON_LABELS[page.waiting] ?? page.waiting}` : LIVE_STATUS_TEXT[status];
}

export function LivePageTabs({ pages, runs, onShow }: { pages: readonly LivePage[]; runs: readonly ProgressRun[]; onShow: (applicationId: string) => void }) {
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const currentId = pages.find(p => p.current)?.application_id;
  // 当前这一家滚进视野：标签多了横向滚动，切过去的那一个不能在屏幕外
  useEffect(() => { currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [currentId]);
  if (!pages.length) return null;
  return (
    <div role="tablist" aria-label="正在投的几家" data-testid="live-page-tabs"
      className="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-[var(--line)] px-4 pt-2">
      {pages.map(p => {
        const status = liveStatusOf(p, runs.find(r => r.applicationId === p.application_id));
        const hint = statusHint(p, status);
        return (
          <button key={p.application_id} ref={p.current ? currentRef : undefined} type="button" role="tab" aria-selected={p.current}
            aria-label={`${p.company}，${p.title || '网申'}，${hint}`} title={hint} data-status={status}
            onClick={() => onShow(p.application_id)}
            className={`-mb-px flex w-40 shrink-0 items-start gap-2 rounded-t-lg border border-b-0 px-3 pb-2 pt-1.5 text-left transition-colors ${p.current
              ? 'border-[var(--line)] bg-[var(--paper)]'
              : 'border-transparent hover:bg-[var(--hover)]'}`}>
            <span className="mt-[3px]"><LiveStatusMark status={status} /></span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-sm leading-5 ${p.current ? 'font-semibold text-[var(--ink)]' : 'font-medium text-[var(--ink-2)]'}`}>{p.company}</span>
              {p.title && <span className="block truncate text-xs leading-4 text-[var(--muted)]">{p.title}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
