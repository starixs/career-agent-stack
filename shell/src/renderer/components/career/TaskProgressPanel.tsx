/**
 * 网申现场画面下面的那一块：只讲顶上选中的这一份网申——走到流程的哪一步、现在在做什么 / 要他做什么、刚做过哪几步。
 *
 * 切换哪一家在顶上的标签（LivePageTabs），这里不再列一遍全部任务，也不再重复公司和岗位（2026-11-06 用户：「这块你重叠了」）。
 * 走到哪一步用一条四个节点的流程线画出来（liveStage.ts），不用一个「进行中」字样的标签。
 */
import { AlertTriangle, Check, Loader2 } from 'lucide-react';

import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

import { HANDOFF_REASON_LABELS } from './careerConstants';
import type { LivePage } from './LivePageTabs';
import { LIVE_STAGES, LIVE_STATUS_TEXT, liveStatusOf, stagePosition, type StagePosition } from './liveStage';
import type { BatchState, CareerTakeoverEvent } from './types';

const timeOf = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** 下面最多列几条刚做过的步骤：再多就把画面挤小了。 */
const RECENT_STEPS = 5;

/** 面板上那一行：接管的话 > 浏览器第一次在准备（服务端 phase browser_down，说清要等多久，盖过旧进展）> 这份最新进展 > 批量状态。 */
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

function StageNode({ state, last }: { state: NodeState; last: boolean }) {
  const box = 'flex h-5 w-5 shrink-0 items-center justify-center';
  if (state === 'working') return <span className={box}><Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" aria-hidden /></span>;
  if (state === 'you') return <span className={box}><span className="h-3 w-3 rounded-full bg-[var(--warning)] ring-4 ring-[var(--warning-bg)]" aria-hidden /></span>;
  if (state === 'failed') return <span className={box}><AlertTriangle className="h-4 w-4 text-[var(--warning)]" aria-hidden /></span>;
  // 做完的一步：实心小点；最后一步做完打钩（整份投出了）
  if (state === 'done') return <span className={box}>{last ? <Check className="h-4 w-4 text-[var(--success)]" strokeWidth={3} aria-hidden /> : <span className="h-2 w-2 rounded-full bg-[var(--ink-2)]" aria-hidden />}</span>;
  return <span className={box}><span className="h-2 w-2 rounded-full border border-[var(--subtle)]" aria-hidden /></span>;
}

/** 流程线：四个节点，走过的连成实线，当前这一步的图形和颜色说清是小芽在做、等他、还是没做成。 */
function StageTrack({ position, label }: { position: StagePosition; label: string }) {
  const lastIndex = LIVE_STAGES.length - 1;
  const line = (reached: boolean, hidden: boolean) => `h-px flex-1 ${hidden ? 'opacity-0' : reached ? 'bg-[var(--ink-2)]' : 'bg-[var(--line-2)]'}`;
  return (
    <ol aria-label={`流程：${label}`} data-testid="live-stage-track" className="flex items-start">
      {LIVE_STAGES.map((name, i) => {
        const state: NodeState = i < position.current ? 'done' : i === position.current ? position.tone : 'todo';
        const here = i === position.current;
        return (
          <li key={name} aria-current={here ? 'step' : undefined} data-state={state} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <div className="flex w-full items-center">
              <span className={line(i <= position.current, i === 0)} />
              <StageNode state={state} last={i === lastIndex} />
              <span className={line(i < position.current, i === lastIndex)} />
            </div>
            <span className={`text-xs ${here ? `font-semibold ${state === 'you' || state === 'failed' ? 'text-[var(--warning)]' : 'text-[var(--ink)]'}` : state === 'done' ? 'text-[var(--ink-2)]' : 'text-[var(--subtle)]'}`}>{name}</span>
          </li>
        );
      })}
    </ol>
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
  const here = takeoverIsHere(takeover, run, page);
  const asked = here && takeover.state !== 'running' && takeover.state !== 'resuming' && takeover.runId !== 'live';
  const waiting = page?.waiting ?? (here && takeover.state === 'paused' ? takeover.reason ?? 'user_request' : null);
  const status = liveStatusOf({ waiting }, run);
  const latest = run?.steps.at(-1);
  // 流程线只给网申用；对话里随手打开网页看一眼不是一份网申，不画
  const isApplication = !!page || !!run?.applicationId || !!waiting;
  const fallback = status === 'queued' && page ? '这一家还在排队，轮到它就开始填'
    : status === 'waiting' && !latest && waiting ? `等你：${HANDOFF_REASON_LABELS[waiting] ?? waiting}` : undefined;
  const message = progressMessage(asked ? takeover.message : undefined, fallback ?? latest?.message, batch);
  // 最新一步已经写在上面那一行了，下面只列它之前的几步
  const steps = run?.steps ?? [];
  const earlier = (latest && message === latest.message ? steps.slice(0, -1) : steps).slice(-RECENT_STEPS).reverse();
  return (
    <section aria-label="这一家的进展" className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--inset)] px-4 py-3">
      {!page && title && <div className="mb-2 truncate text-sm font-semibold text-[var(--ink)]" title={title}>{title}</div>}
      {isApplication && <StageTrack position={stagePosition(status, waiting)} label={LIVE_STATUS_TEXT[status]} />}
      <p role="status" className={`${isApplication ? 'mt-3 ' : ''}text-sm text-[var(--ink)]`}>{message}</p>
      {earlier.length > 0 && (
        <ol aria-label="刚做过的几步" className="mt-2 space-y-1 border-t border-[var(--line)] pt-2">
          {earlier.map((event, index) => (
            // 几点几分几秒不上页面：顺序已经说明先后，要查时间悬停看
            <li key={`${event.at}-${index}`} className="truncate text-xs text-[var(--muted)]" title={`${timeOf.format(event.at)}　${event.message}`}>{event.message}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
