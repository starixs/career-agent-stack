import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useWorkSurfaces, type ProgressRun } from '@/features/career-shell/workSurfaceStore';
import { Badge } from './CareerPrimitives';
import { parseLivePages, type LivePage } from './LivePageTabs';
import { useCareerQuery } from './useCareerData';
import type { BatchState, CareerTakeoverEvent } from './types';

const timeOf = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function runTitle(run: ProgressRun | undefined, batch?: BatchState | null): string {
  const named = [run?.company, run?.jobTitle].filter(Boolean).join(' · ');
  if (named) return named;
  if (run && batch?.currentActionId && run.key === `run_${batch.currentActionId}` && batch.currentTitle) return batch.currentTitle;
  return batch?.currentTitle ?? '网申任务';
}

/** 任务对应开着的哪一页：按网申 id 认；旧事件没带 id 时退回岗位名 + 公司都对上才算（同一家公司投几份不能认错）。 */
export function livePageOfRun(pages: readonly LivePage[], run: Pick<ProgressRun, 'applicationId' | 'company' | 'jobTitle'>): LivePage | undefined {
  if (run.applicationId) return pages.find(p => p.application_id === run.applicationId);
  return pages.find(p => !!run.jobTitle && p.title === run.jobTitle && (!run.company || p.company === run.company));
}

/** 单个岗位的事件流；多个 run 时先选岗位，再只看它的事件，避免 50 份进度混在一起。 */
export function TaskProgressPanel({ title, batch, takeover }: { title?: string | null; batch?: BatchState | null; takeover?: CareerTakeoverEvent | null }) {
  const { runs } = useWorkSurfaces();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 和顶上的下拉框 / 小签共用「画面正看着哪一家」：哪边切，两边和画面都跟着（2026-11-05）
  const { data: pages, reload: reloadPages } = useCareerQuery(async () => parseLivePages(await apiGetJson<unknown>('/api/career/live/pages')), ['action_queue', 'handoff', 'live_view']);
  const selected = selectedKey ? runs.find(item => item.key === selectedKey) : undefined;
  const shownApp = pages?.find(p => p.current)?.application_id;
  const shown = shownApp ? runs.find(item => item.applicationId === shownApp) : undefined;
  // 点的这份没有页面开着（已填完 / 失败）：画面切不过去，面板仍显示它的事件
  const selectedOffscreen = selected && !(pages ?? []).some(p => p.application_id === selected.applicationId) ? selected : undefined;
  const run = selectedOffscreen ?? shown ?? selected ?? runs.find(item => !item.finished) ?? runs[0];
  const latest = run?.steps.at(-1);
  const takeoverHere = !!takeover && (!run || takeover.runId === run.key);
  const waiting = takeoverHere && takeover?.state === 'paused';
  const human = takeoverHere && takeover?.state === 'human_active';
  const status = waiting ? '等你处理' : human ? '你在操作' : batch?.status === 'paused' ? '已暂停' : batch?.status === 'stopped' ? '已停止' : run?.finished ? '已完成' : run || batch?.status === 'running' ? '进行中' : '等待开始';
  const tone = waiting ? 'warning' : run?.finished || batch?.status === 'stopped' ? 'neutral' : 'success';
  const message = (takeoverHere ? takeover?.message : undefined) ?? latest?.message ?? batch?.message ?? '等待任务开始';
  const total = batch ? batch.done + batch.failed + batch.handoffs + batch.queued + (batch.running?.length ?? 0) : 0;
  const ratio = run?.progress ?? (total > 0 && batch ? Math.min(1, (batch.done + batch.failed) / total) : null);
  const events = run?.steps.slice(-5).reverse() ?? [];
  const select = (next: ProgressRun) => {
    setSelectedKey(next.key);
    const page = livePageOfRun(pages ?? [], next);
    if (!page) return;
    void apiPostJson<unknown>('/api/career/live/view', { application_id: page.application_id })
      .then(reloadPages, (error: unknown) => { console.error('[career-live] 切换任务现场 FAILED', error instanceof Error ? error.message : error); reloadPages(); });
  };
  return (
    <section aria-label="当前任务" aria-live="polite" className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--inset)] px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]" title={runTitle(run, batch)}>{run ? runTitle(run, batch) : title ?? batch?.currentTitle ?? '网申任务'}</span>
        <Badge tone={tone}>{status}</Badge>
      </div>
      {!human && <div className="mt-1 text-sm text-[var(--ink-2)]">{message}</div>}
      {ratio !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--line)]" role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
          <div className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-200" style={{ width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%` }} />
        </div>
      )}
      {runs.length > 1 && (
        <div className="mt-3 border-t border-[var(--line)] pt-2">
                    <div role="list" aria-label="并行网申任务" className="max-h-36 space-y-1 overflow-y-auto">
            {runs.map(item => (
              <button key={item.key} type="button" aria-pressed={item.key === run?.key} onClick={() => select(item)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${item.key === run?.key ? 'bg-[var(--paper)] text-[var(--ink)]' : 'text-[var(--muted)] hover:bg-[var(--hover)]'}`}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${item.finished ? 'bg-[var(--success)]' : 'bg-[var(--primary)]'}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{runTitle(item, null)}</span>
                <span className="shrink-0">{item.finished ? '已完成' : '进行中'}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {events.length > 0 && (
        <div className="mt-3 border-t border-[var(--line)] pt-2">
                    <ol className="space-y-1.5">
            {events.map((event, index) => (
              <li key={`${event.at}-${event.phase}-${index}`} className="flex items-start gap-2 text-xs">
                {index === 0 && !run?.finished
                  ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--primary)]" aria-hidden />
                  : index === 0 && run?.finished
                    ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--success)]" aria-hidden />
                    : <Circle className="mt-0.5 h-3 w-3 shrink-0 text-[var(--subtle)]" aria-hidden />}
                <span className="min-w-0 flex-1 text-[var(--ink-2)]">{event.message}</span>
                <time className="shrink-0 text-[var(--subtle)]" dateTime={new Date(event.at).toISOString()}>{timeOf.format(event.at)}</time>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
