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

/** 收窄成小方块时角上的状态点：只用颜色（琥珀 = 等他，蓝 = 小芽在做，绿 = 投出了）；还在排队的没有点。 */
const CORNER_TONE: Partial<Record<LiveStatus, string>> = {
  waiting: 'bg-[var(--warning)]', ready: 'bg-[var(--warning)]', failed: 'bg-[var(--warning)]',
  filling: 'bg-[var(--primary)] motion-safe:animate-pulse', sending: 'bg-[var(--primary)] motion-safe:animate-pulse', done: 'bg-[var(--success)]',
};
function CornerDot({ status }: { status: LiveStatus }) {
  const tone = CORNER_TONE[status];
  return tone ? <span className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-[var(--side)] ${tone}`} /> : null;
}

/** 悬停 / 读屏的一句话：等他的说清等什么。 */
function statusHint(page: LivePage, status: LiveStatus): string {
  return status === 'waiting' && page.waiting ? `等你：${HANDOFF_REASON_LABELS[page.waiting] ?? page.waiting}` : LIVE_STATUS_TEXT[status];
}

/** 选中的标签固定这么宽（两行字都放得下）；其余的平分剩下的宽度，最窄只剩状态图形和一两个字。 */
const TAB_CLASS = {
  current: 'w-44 flex-none border-[var(--line)] bg-[var(--paper)]',
  other: 'min-w-11 max-w-44 flex-1 basis-0 border-transparent hover:min-w-36 hover:bg-[var(--hover)]',
};

/**
 * 标签条的排法照着 Safari 的标签栏（2026-11-06 用户：不要只做最简单的左右滑，更不能上下左右都能滑）：
 *  - 一行铺满：选中的那个展开（公司 + 岗位两行），其余的自己收窄平分剩下的宽度——十来家以内不用滑，一眼全看到；
 *  - 收窄的标签字不打省略号，右边渐隐；鼠标移上去临时展开，看清是哪一家；
 *  - 实在太多（每个已经收到最窄）才横向滚：只能横着滚，滚轮上下也当成横着滚，停下时对齐到标签边上。
 */
export function LivePageTabs({ pages, runs, onShow }: { pages: readonly LivePage[]; runs: readonly ProgressRun[]; onShow: (applicationId: string) => void }) {
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const currentId = pages.find(p => p.current)?.application_id;
  // 当前这一家滚进视野：太多要横向滚时，切过去的那一个不能在屏幕外
  useEffect(() => { currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [currentId]);
  if (!pages.length) return null;
  return (
    <div className="shrink-0 border-b border-[var(--line)]">
      {/* 滚动层压住下面那条线 1px：选中的标签底边盖住线，和下面的画面连成一片 */}
      <div role="tablist" aria-label="正在投的几家" data-testid="live-page-tabs"
        onWheel={ev => { if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) ev.currentTarget.scrollLeft += ev.deltaY; }}
        className="relative -mb-px flex snap-x snap-proximity items-stretch gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain px-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {pages.map(p => {
          const status = liveStatusOf(p, runs.find(r => r.applicationId === p.application_id));
          const hint = statusHint(p, status);
          return (
            <button key={p.application_id} ref={p.current ? currentRef : undefined} type="button" role="tab" aria-selected={p.current}
              aria-label={`${p.company}，${p.title || '网申'}，${hint}`} title={`${p.company} ${p.title}`.trim()} data-status={status}
              onClick={() => onShow(p.application_id)}
              className={`@container flex h-11 snap-start items-center gap-2 rounded-t-lg border border-b-0 px-2 text-left transition-[min-width,background-color] duration-200 ${p.current ? TAB_CLASS.current : TAB_CLASS.other}`}>
              {/* 收到最窄：只剩公司首字的小方块，状态挂在角上（相当于浏览器标签收窄后只剩网站图标）；宽一点才换成图形 + 文字 */}
              <span className="relative mx-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--line-2)] bg-[var(--inset)] text-xs font-semibold text-[var(--ink-2)] @min-[4rem]:hidden" aria-hidden>
                {Array.from(p.company)[0]}
                <CornerDot status={status} />
              </span>
              <span className="hidden @min-[4rem]:block"><LiveStatusMark status={status} /></span>
              <span className="hidden min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-0.75rem),rgb(0_0_0/0))] @min-[4rem]:block">
                <span className={`block text-sm leading-5 ${p.current ? 'font-semibold text-[var(--ink)]' : 'font-medium text-[var(--ink-2)]'}`}>{p.company}</span>
                {/* 岗位只在标签够宽时出现（选中的、鼠标移上去展开的）；收窄时只留公司 */}
                {p.title && <span className="hidden text-xs leading-4 text-[var(--muted)] @min-[7rem]:block">{p.title}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
