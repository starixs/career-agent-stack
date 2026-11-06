/**
 * 网申现场画面下面的那一块：只讲顶上选中的这一份网申，用图形讲，像一张往下长的导图——
 *  - 主干：从他选中开投到投出的六环，走过的连成实线，正在办的那一段有东西在往前传；
 *  - 枝：走到的那一环往下分出一小枝，是这一环里的几类事（打开网址、进申请表、等你看一眼…），最后一片是现在的状态；
 *    别的走过的环点一下也能展开，看它做过什么（2026-11-06 用户：「到了每一块，它可以再往下，跟树枝一样」）；
 *  - 格子：这张表要填的格子，填好一格亮一格，等他的是琥珀色。
 * 画面上不放句子（用户：「正下面不要有任何产品文案」）。他要的是反馈感——小芽在干嘛、干到哪了——停下等他时也看得出之前做过什么。
 * 给读屏的那句话照样有（sr-only）。
 */
import { AlertTriangle, Check } from 'lucide-react';
import { useState } from 'react';

import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

import { APPLY_STAGE_NAMES, APPLY_STAGES, type ApplyCells } from '../../../shared/careerApplyStage';
import { HANDOFF_REASON_LABELS } from './careerConstants';
import type { LivePage } from './LivePageTabs';
import { LIVE_STATUS_TEXT, liveStatusOf, openStageIndex, stageCaption, stageLeaves, stagePosition, type StageLeaf, type StagePosition } from './liveStage';
import type { BatchState, CareerTakeoverEvent } from './types';

/** 格子最多画这么多个：再多一排排下去比画面还高；超过就按比例缩。 */
const MAX_CELLS = 96;

/** 给读屏的那一句：接管的话 > 浏览器第一次在准备（服务端 phase browser_down，说清要等多久，盖过旧进展）> 这份最新进展 > 批量状态。 */
export function progressMessage(takeoverMessage: string | undefined, latestMessage: string | undefined, batch?: Pick<BatchState, 'phase' | 'message'> | null): string {
  const phase: string | undefined = batch?.phase;
  const preparing = phase === 'browser_down' ? batch?.message : undefined;
  return takeoverMessage ?? preparing ?? latestMessage ?? batch?.message ?? '等待任务开始';
}

/** 这条接管说的是不是眼前这一家：有这家的进展就按任务号认；这家还没有进展、又有页面开着时不认（免得把别家的话安在它头上）。 */
function takeoverIsHere(takeover: CareerTakeoverEvent | null | undefined, run: ProgressRun | undefined, page: LivePage | undefined): takeover is CareerTakeoverEvent {
  if (!takeover) return false;
  return run ? takeover.runId === run.key : !page;
}

type NodeState = 'done' | 'todo' | StagePosition['tone'];

function ChainNode({ state, last }: { state: NodeState; last: boolean }) {
  const box = 'flex h-5 w-5 shrink-0 items-center justify-center';
  if (state === 'working') return <span className={box}><span className="h-3 w-3 rounded-full bg-[var(--primary)] ring-4 ring-[var(--primary)]/20 motion-safe:animate-pulse" aria-hidden /></span>;
  if (state === 'you') return <span className={box}><span className="h-3 w-3 rounded-full bg-[var(--warning)] ring-4 ring-[var(--warning-bg)]" aria-hidden /></span>;
  if (state === 'failed') return <span className={box}><AlertTriangle className="h-4 w-4 text-[var(--warning)]" aria-hidden /></span>;
  // 走过的一环：实心小点；最后一环走完打钩（整份投出了）
  if (state === 'done') return <span className={box}>{last ? <Check className="h-4 w-4 text-[var(--success)]" strokeWidth={3} aria-hidden /> : <span className="h-2 w-2 rounded-full bg-[var(--ink-2)]" aria-hidden />}</span>;
  return <span className={box}><span className="h-2 w-2 rounded-full border border-[var(--subtle)]" aria-hidden /></span>;
}

/** 两环之间的线：走过的实线；通向正在办的那一环的一段在往前传（live-chain-flow，见 index.css）；通向等他那一环的是琥珀色。 */
function segmentClass(index: number, position: StagePosition, hidden: boolean, late = false): string {
  if (hidden) return 'h-0.5 flex-1 opacity-0';
  if (index < position.current) return 'h-0.5 flex-1 rounded-full bg-[var(--ink-2)]';
  if (index === position.current && position.tone === 'working') return `live-chain-flow ${late ? 'live-chain-flow-late ' : ''}h-0.5 flex-1 rounded-full`;
  if (index === position.current && position.tone === 'you') return 'h-0.5 flex-1 rounded-full bg-[var(--warning)]';
  return 'h-0.5 flex-1 rounded-full bg-[var(--line-2)]';
}

/** 主干：六环。走到过的环可以点，点了它的枝在下面展开。 */
function ChainTrunk({ position, open, onOpen, label }: { position: StagePosition; open: number; onOpen: (index: number) => void; label: string }) {
  const lastIndex = APPLY_STAGES.length - 1;
  const reachedUpTo = openStageIndex(position);
  return (
    <ol aria-label={`链路：${label}`} data-testid="live-stage-track" className="flex items-start">
      {APPLY_STAGES.map((stage, i) => {
        const state: NodeState = i < position.current ? 'done' : i === position.current ? position.tone : 'todo';
        const here = i === position.current && position.tone !== 'idle';
        const reached = i <= reachedUpTo;
        return (
          <li key={stage} aria-current={here ? 'step' : undefined} data-state={state === 'idle' ? 'todo' : state} className="flex min-w-0 flex-1 flex-col items-center">
            <div className="flex w-full items-center">
              <span className={segmentClass(i, position, i === 0, true)} />
              <ChainNode state={state === 'idle' ? 'todo' : state} last={i === lastIndex} />
              {/* 右半段属于下一环：下一环走到了才亮 */}
              <span className={segmentClass(i + 1, position, i === lastIndex)} />
            </div>
            <button type="button" disabled={!reached} aria-expanded={reached ? open === i : undefined} onClick={() => onOpen(i)}
              className={`mt-1 whitespace-nowrap rounded px-1 text-xs ${reached ? 'cursor-pointer hover:bg-[var(--hover)]' : 'cursor-default'} ${open === i ? 'font-semibold text-[var(--ink)]' : state === 'done' ? 'text-[var(--ink-2)]' : 'text-[var(--subtle)]'}`}>
              {APPLY_STAGE_NAMES[stage]}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const LEAF_DOT: Record<StageLeaf['tone'], string> = {
  done: 'bg-[var(--ink-2)]', working: 'bg-[var(--primary)] motion-safe:animate-pulse', you: 'bg-[var(--warning)]', failed: 'bg-[var(--warning)]',
};
const LEAF_TEXT: Record<StageLeaf['tone'], string> = {
  done: 'text-[var(--ink-2)]', working: 'font-semibold text-[var(--primary)]', you: 'font-semibold text-[var(--warning)]', failed: 'font-semibold text-[var(--warning)]',
};

/**
 * 枝：从展开的那一环正下方垂下来，叶子一片片挂在枝上。枝放在一张半透明的小卡里（毛玻璃，live-branch-glass），
 * 展开时有一道光从左到右扫过去——光是盖在上面的一层，卡在后台停住时内容照样看得见。
 * 位置跟着那一环走：六等分的格子里从这一环起占两格，枝干正对这一环的圆点。
 */
function StageBranch({ index, leaves }: { index: number; leaves: readonly StageLeaf[] }) {
  // 最后一环右边没有地方了：小卡贴着右边放（往左长），别的环从枝干往右长
  const last = index === APPLY_STAGES.length - 1;
  const column = last ? `${index} / span 2` : `${index + 1} / span 2`;
  const stem = last ? '75%' : '25%';
  return (
    <div className="grid grid-cols-6">
      <div data-testid="live-branch" style={{ gridColumn: column }} className="flex flex-col">
        {/* 枝干上半截：从环的名字下面接到小卡 */}
        <span className="h-2 w-px bg-[var(--line-2)]" style={{ marginLeft: stem }} aria-hidden />
        <ul key={index} className={`live-branch-glass relative w-max min-w-20 rounded-lg border border-[var(--line)] py-1.5 pl-2 pr-3 ${last ? 'ml-auto' : ''}`} style={last ? undefined : { marginLeft: `calc(${stem} - 0.75rem)` }}>
          {leaves.map((leaf, i) => (
            <li key={`${leaf.label}-${i}`} data-leaf={leaf.tone} className="relative flex items-center gap-2 py-0.5 pl-3 text-xs">
              {/* 竖的是枝干，横的一小截是叶柄；最后一片下面不再有枝干 */}
              <span className={`absolute left-[3px] top-0 w-px bg-[var(--line-2)] ${i === leaves.length - 1 ? 'h-1/2' : 'h-full'}`} aria-hidden />
              <span className="absolute left-[3px] top-1/2 h-px w-2 bg-[var(--line-2)]" aria-hidden />
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${LEAF_DOT[leaf.tone]}`} aria-hidden />
              <span className={`whitespace-nowrap ${LEAF_TEXT[leaf.tone]}`}>{leaf.label}</span>
              {leaf.count && <span className="tabular-nums text-[var(--subtle)]">{leaf.count}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 格子：填好的实心、等他的琥珀、还没填的空心；小芽在填时下一格在闪。太多就按比例缩成 MAX_CELLS 格。 */
function CellGrid({ cells, working }: { cells: ApplyCells; working: boolean }) {
  const scale = cells.total > MAX_CELLS ? MAX_CELLS / cells.total : 1;
  const total = Math.round(cells.total * scale);
  const done = Math.min(total, Math.round(cells.done * scale));
  const you = Math.min(total - done, Math.max(cells.you > 0 ? 1 : 0, Math.round(cells.you * scale)));
  return (
    <div data-testid="live-cells" role="img" aria-label={`填好 ${cells.done} 格，共 ${cells.total} 格${cells.you ? `，${cells.you} 格等你` : ''}`} className="mt-3 flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap gap-[3px]">
        {Array.from({ length: total }, (_, i) => {
          const kind = i < done ? 'done' : i < done + you ? 'you' : 'todo';
          const next = working && i === done + you;
          return <span key={i} data-cell={kind} className={`h-2 w-2 rounded-[2px] ${kind === 'done' ? 'bg-[var(--ink-2)]' : kind === 'you' ? 'bg-[var(--warning)]' : next ? 'bg-[var(--primary)] motion-safe:animate-pulse' : 'border border-[var(--line-2)]'}`} />;
        })}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]" aria-hidden><b className="font-semibold text-[var(--ink)]">{cells.done}</b>/{cells.total}</span>
    </div>
  );
}

export function TaskProgressPanel({ page, run, title, batch, takeover }: {
  /** 画面正看着的那一家（顶上选中的标签）；没有网申页面开着时没有。 */
  page?: LivePage;
  /** 这一家的进展。 */
  run?: ProgressRun;
  /** 没有网申页面开着时（对话里随手浏览）用页面标题说一下在看什么。 */
  title?: string | null;
  batch?: BatchState | null;
  takeover?: CareerTakeoverEvent | null;
}) {
  // 他点开看的那一环：只在链路还停在他点的时候那一环时算数；链路往前走了，枝就跟着走到新的那一环
  const [picked, setPicked] = useState<{ index: number; at: number } | null>(null);
  const here = takeoverIsHere(takeover, run, page);
  const asked = here && takeover.state !== 'running' && takeover.state !== 'resuming' && takeover.runId !== 'live';
  const waiting = page?.waiting ?? (here && takeover.state === 'paused' ? takeover.reason ?? 'user_request' : null);
  const status = liveStatusOf({ waiting }, run);
  const latest = run?.steps.at(-1);
  // 链路只给网申用；对话里随手打开网页看一眼不是一份网申，不画
  const isApplication = !!page || !!run?.applicationId || !!waiting;
  const fallback = status === 'queued' && page ? '这一家还在排队，轮到它就开始填'
    : status === 'waiting' && !latest && waiting ? `等你：${HANDOFF_REASON_LABELS[waiting] ?? waiting}` : undefined;
  const message = progressMessage(asked ? takeover.message : undefined, fallback ?? latest?.message, batch);
  if (!isApplication) {
    return (
      <section aria-label="现在在做的事" className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--inset)] px-4 py-3">
        {title && <div className="truncate text-sm font-semibold text-[var(--ink)]" title={title}>{title}</div>}
        <p role="status" className="truncate text-xs text-[var(--muted)]" title={message}>{message}</p>
      </section>
    );
  }
  const position = stagePosition(status, waiting, run?.stage);
  const open = picked && picked.at === position.current ? picked.index : openStageIndex(position);
  return (
    <section aria-label="这一家的进展" className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--inset)] px-4 pb-3 pt-3">
      <p role="status" className="sr-only">{message}</p>
      <ChainTrunk position={position} open={open} onOpen={index => setPicked({ index, at: position.current })} label={LIVE_STATUS_TEXT[status]} />
      <StageBranch index={open} leaves={stageLeaves(APPLY_STAGES[open], position, run, stageCaption(status, waiting))} />
      {run?.cells && <CellGrid cells={run.cells} working={position.tone === 'working'} />}
    </section>
  );
}
