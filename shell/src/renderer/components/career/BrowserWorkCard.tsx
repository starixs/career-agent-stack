/**
 * 浏览器工作面的收起态（specs/CAREER_DESIGN.md §5.7）：对话里的一张工具卡，
 * 显示正在做哪一步、实时缩略和「打开浏览器」。展开后按钮弱化为「已在右侧打开」，
 * 交接时状态点变黄并说明要你做什么。
 */
import { Globe } from 'lucide-react';
import { useCallback, useState } from 'react';

import { useWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { HANDOFF_REASON_LABELS } from './careerConstants';
import { openLiveDrawer } from './CareerLiveDrawer';
import { CareerLiveViewport } from './CareerLiveViewport';
import type { BatchState, CareerProgressEvent, CareerTakeoverEvent, LiveFrame, LiveStreamEvent } from './types';
import { useLiveStream } from './useGlobalLive';

const BROWSER_PHASE = /apply|fill|browser|batch|login|form/i;

/** Whether the conversation should show the browser card right now. */
export function shouldShowBrowserCard(
  takeover: CareerTakeoverEvent | null | undefined,
  progress: CareerProgressEvent | null | undefined,
  batch: BatchState | null | undefined,
): boolean {
  if (takeover) return true;
  if (batch && batch.status !== 'idle') return true;
  return Boolean(progress && BROWSER_PHASE.test(progress.phase ?? ''));
}

export function BrowserWorkCard({ takeover, progress }: {
  takeover: CareerTakeoverEvent | null | undefined;
  progress: CareerProgressEvent | null | undefined;
}) {
  const { expanded } = useWorkSurfaces();
  const open = expanded === 'browser';
  const handoff = takeover?.state === 'paused';
  const humanActive = takeover?.state === 'human_active';
  const reason = takeover?.reason ? (HANDOFF_REASON_LABELS[takeover.reason] ?? takeover.reason) : null;
  const done = !takeover && typeof progress?.progress === 'number' && progress.progress >= 1;
  const dot = handoff || humanActive ? 'bg-[var(--warning)]' : done ? 'bg-[var(--subtle)]' : 'bg-[var(--success)]';
  const status = handoff
    ? `停在这一步${reason ? `「${reason}」` : ''} · 需要你本人操作`
    : humanActive ? '你在控制中'
      : done ? '已完成' : (progress?.message ?? '正在工作');

  return (
    <div
      data-testid="career-browser-card"
      className="w-full max-w-[380px] rounded-[10px] border border-[var(--line-2)] bg-[var(--paper)] p-3 shadow-sm"
    >
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--primary-soft)] text-[var(--primary)]">
          <Globe className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="font-human text-sm font-semibold text-[var(--ink)]">浏览器</div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
            <span className="truncate">{status}</span>
          </div>
        </div>
      </div>
      {!open && <BrowserThumbnail />}
      {open ? (
        <div className="mt-2.5 flex h-9 items-center justify-center rounded-lg border border-dashed border-[var(--line-2)] bg-[var(--inset)] text-sm text-[var(--muted)]">
          已在右侧打开 →
        </div>
      ) : (
        <button
          type="button"
          onClick={() => openLiveDrawer()}
          className="mt-2.5 flex h-9 w-full items-center justify-center rounded-lg border-[1.5px] border-[var(--hard)] bg-[var(--paper)] text-sm font-semibold text-[var(--ink)] shadow-hard transition-colors hover:bg-[var(--hover)]"
        >
          {handoff ? '去处理' : '打开浏览器'}
        </button>
      )}
    </div>
  );
}

function BrowserThumbnail() {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const onEvent = useCallback((ev: LiveStreamEvent) => {
    if (ev.type === 'frame') setFrame(ev as LiveFrame);
  }, []);
  useLiveStream(true, onEvent);
  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--inset)]">
      <CareerLiveViewport frame={frame} interactive={false} placeholder="等待画面…" className="max-h-[200px]" />
    </div>
  );
}
