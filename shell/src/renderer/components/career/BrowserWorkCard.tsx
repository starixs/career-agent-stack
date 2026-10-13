/**
 * 浏览器工作面的收起态（specs/CAREER_DESIGN.md §5.7）：对话里的一张打破式卡片，
 * 视觉锚是实时缩略，正文是正在做哪一步，右下「打开浏览器」。展开后按钮弱化为「已在右侧打开」，
 * 交接时状态点变黄并说明要你做什么。
 */
import { Globe } from 'lucide-react';
import { useCallback, useState } from 'react';

import { BreakoutCard, StepBar, type BreakoutTone } from '@/features/career-shell/BreakoutCard';
import { useWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { HANDOFF_REASON_LABELS } from './careerConstants';
import { openLiveDrawer } from './CareerLiveDrawer';
import { CareerLiveViewport } from './CareerLiveViewport';
import type { ToolUseSimple } from '@/types/chat';

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

export function BrowserWorkCard({ takeover, progress, tool }: {
  takeover: CareerTakeoverEvent | null | undefined;
  progress: CareerProgressEvent | null | undefined;
  /** The apply_* call this card hangs under; a finished call shows 已完成 without a live view. */
  tool?: ToolUseSimple;
}) {
  const { expanded } = useWorkSurfaces();
  const open = expanded === 'browser';
  // A finished tool call only owns the live state if a handoff is still open on it.
  const live = !tool || tool.isLoading === true || Boolean(takeover && takeover.state !== 'running');
  const effectiveTakeover = live ? takeover : null;
  const handoff = effectiveTakeover?.state === 'paused';
  const humanActive = effectiveTakeover?.state === 'human_active';
  const reason = effectiveTakeover?.reason ? (HANDOFF_REASON_LABELS[effectiveTakeover.reason] ?? effectiveTakeover.reason) : null;
  const done = (tool && !live) || (!effectiveTakeover && typeof progress?.progress === 'number' && progress.progress >= 1);
  const failed = done && tool?.isError === true;
  const tone: BreakoutTone = handoff || humanActive ? 'waiting' : failed ? 'error' : done ? 'idle' : 'running';
  const status = handoff
    ? '需要你本人操作'
    : humanActive ? '你在控制中'
      : done ? (failed ? '出错了，可以让小芽重试' : '已完成 · 查看') : '正在工作';
  const percent = !done && typeof progress?.progress === 'number' ? Math.round(progress.progress * 100) : null;

  const host = effectiveTakeover?.url ? hostOf(effectiveTakeover.url) : null;
  const steps = progress?.steps?.length ? progress.steps : null;

  return (
    <BreakoutCard
      testId="career-browser-card"
      anchor={!open && live ? <BrowserThumbnail /> : <IconAnchor />}
      title={progress?.company ?? '浏览器'}
      aside={joinAside(progress?.job_title, percent !== null ? `${percent}%` : null)}
      overline={handoff ? `停在这一步${reason ? `「${reason}」` : ''}，等你本人来` : host?.toUpperCase()}
      status={{ tone, text: status }}
      open={open}
      action={{ label: handoff ? '去处理' : '打开浏览器', onOpen: () => openLiveDrawer() }}
    >
      {(steps || (!done && progress?.message)) && (
        <>
          {!done && progress?.message && <p className="line-clamp-2">{progress.message}</p>}
          {steps && <div className="mt-3"><StepBar steps={steps} /></div>}
        </>
      )}
    </BreakoutCard>
  );
}

function hostOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

function joinAside(...parts: Array<string | null | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length ? kept.join(' · ') : undefined;
}

function IconAnchor() {
  return (
    <span aria-hidden="true" className="grid h-[92px] w-[70px] place-items-center rounded-[4px] bg-[var(--selected)] text-[var(--ink-2)]">
      <Globe className="h-7 w-7" strokeWidth={1.5} />
    </span>
  );
}

/** 视觉锚：实时网页缩略。 */
function BrowserThumbnail() {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const onEvent = useCallback((ev: LiveStreamEvent) => {
    if (ev.type === 'frame') setFrame(ev as LiveFrame);
  }, []);
  useLiveStream(true, onEvent);
  return (
    <div className="w-[168px] overflow-hidden rounded-[4px] border border-[var(--line-2)] bg-[var(--inset)]">
      <CareerLiveViewport frame={frame} interactive={false} placeholder="等待画面…" className="max-h-[110px]" />
    </div>
  );
}
