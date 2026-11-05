/**
 * 右栏的几块（主线体验 §6.1a / §6.5，11-02 定）：后台在做什么全在右栏，不进对话。
 *  - 主线进度：说说你 → 定方向 → 先投一家 → 再投一批，告诉他走到哪、还剩几步；先投一家之后下面常驻「再投一批」按钮。
 *    服务端还有第五个阶段 released（放手），界面上算「再投一批」也做完了。
 *  - 要他的事不在右栏：唯一落点是输入框上沿的等你条（规范 §5.2），右栏只在头部写一句「有 N 件等你」。
 *  - 刚投出：最近三张回执提到此刻；全部回执在足迹。
 *  - 正在做：几个预设岗位（写简历、定制、网申、盯邮箱），每个一行人话。
 *  - 今天：备好 · 投出 · 等你 三个真数。
 *  - 简历草稿：建档时边聊边长，每行标来源（来自你说的）。
 *  - 回执、学会了：一份份攒下来；学会了的那一类，做通够数时他可以盖章「以后同类直接投」。
 */
import { emitEvent } from '@/api/eventBus';
import { openBatchPick } from '@/components/career/BatchPickCard';
import { careerApi } from '@/components/career/careerApi';
import type { ExperienceNode } from '@/components/career/types';
import { requestOpenDeck } from '@/components/career/delivery/WaitingDock';
import type { MainlineStage, RailBlock, RailPool, RailReceipt, RailSnapshot, TrustEntry } from '../../../shared/careerRail';

/** 界面上的四步（用他的话）；服务端阶段 id 不变，released 落在最后一步之后＝四步都做完。 */
export const MAINLINE_STEPS: ReadonlyArray<{ stage: MainlineStage; label: string }> = [
  { stage: 'profile', label: '说说你' }, { stage: 'direction', label: '定方向' }, { stage: 'first', label: '先投一家' }, { stage: 'batch', label: '再投一批' },
];
/** 第一份当面投完之后（走到「再投一批」或四步都做完），进度下面常驻「再投一批」按钮。 */
const BATCH_STEP = MAINLINE_STEPS.findIndex(s => s.stage === 'batch');
/** 此刻里「刚投出」放几张回执，其余在足迹。 */
export const RECENT_RECEIPTS = 3;
const DOT: Record<RailBlock['status'], string> = {
  working: 'bg-[var(--success)] animate-pulse', waiting: 'bg-[var(--warning)]', done: 'bg-[var(--line-2)]', idle: 'bg-[var(--line)]',
};

export function RailHeading({ children, count }: { children: string; count?: number }) {
  return (
    <h3 className="mx-1 mb-1.5 mt-4 flex items-center gap-1.5 font-human text-sm font-semibold text-[var(--ink-2)]">
      {children}
      {typeof count === 'number' && count > 0 && <span className="font-sans text-xs font-normal text-[var(--muted)]">{count}</span>}
    </h3>
  );
}

/** 当前在第几步（0 起）；released 返回步数，表示四步都做完。 */
export function mainlineStepIndex(stage: MainlineStage): number {
  const at = MAINLINE_STEPS.findIndex(s => s.stage === stage);
  return at >= 0 ? at : MAINLINE_STEPS.length;
}

function stepsLeftText(at: number): string {
  const left = MAINLINE_STEPS.length - 1 - at;
  if (left > 0) return `还剩 ${left} 步`;
  return left === 0 ? '最后一步' : '后面的交给我，有动静叫你';
}

export function MainlineProgress({ stage }: { stage: MainlineStage }) {
  const at = mainlineStepIndex(stage);
  return (
    <section aria-label="主线进度" data-testid="rail-mainline" className="mx-1 mt-3">
      <ol className="flex items-center gap-1">
        {MAINLINE_STEPS.map(({ stage: id, label }, i) => (
          <li key={id} className="flex min-w-0 flex-1 flex-col items-center gap-1" aria-current={i === at ? 'step' : undefined}>
            <span className={`h-1.5 w-full rounded-full transition-colors duration-300 ${i <= at ? 'bg-[var(--primary)]' : 'bg-[var(--line)]'}`} />
            <span className={`whitespace-nowrap text-xs ${i === at ? 'font-semibold text-[var(--ink)]' : 'text-[var(--muted)]'}`}>{i < at ? `✓ ${label}` : label}</span>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-center text-xs text-[var(--subtle)]">{stepsLeftText(at)}</p>
      {at >= BATCH_STEP && (
        <button
          type="button" data-testid="rail-batch-pick" onClick={() => void openBatchPick()}
          className="mt-2 w-full rounded-lg border-[1.5px] border-[var(--primary)] bg-[var(--paper)] py-1 text-sm font-semibold text-[var(--primary)] transition-colors hover:bg-[var(--hover)]"
        >再投一批</button>
      )}
    </section>
  );
}

/** 打开浏览器现场（看一眼在填的那家，或者那一步要他本人来）。 */
const openLive = () => emitEvent('career:focus', { surface: 'live_drawer' });

/**
 * 网申那一行在等你时的「去处理」：浏览器停在要他本人来的一步 → 打开浏览器现场；
 * 其余要他的事 → 打开输入框上沿的等你卡组。从不跳岗位库。
 */
export function handleWaiting(handoff: boolean): void {
  if (handoff) openLive();
  else requestOpenDeck();
}

function BlockRow({ block, handoff }: { block: RailBlock; handoff: boolean }) {
  const look = () => (block.status === 'waiting' ? handleWaiting(handoff) : openLive());
  return (
    <li className="flex items-start gap-2.5 px-1 py-1.5" data-testid={`rail-block-${block.id}`}>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[block.status]}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="font-human text-sm font-semibold text-[var(--ink)]">{block.label}</span>
          {typeof block.total === 'number' && block.total > 0 && <span className="text-xs tabular-nums text-[var(--muted)]">{block.done ?? 0}/{block.total}</span>}
        </span>
        <span className="block text-xs text-[var(--muted)]">{block.line}</span>
      </span>
      {block.id === 'apply' && (block.status === 'working' || block.status === 'waiting') && (
        <button type="button" onClick={look} className="shrink-0 text-xs text-[var(--primary)] underline-offset-2 hover:underline">
          {block.status === 'waiting' ? '去处理' : '看一眼'}
        </button>
      )}
    </li>
  );
}

export function BlockRows({ blocks, handoff = false }: { blocks: readonly RailBlock[]; handoff?: boolean }) {
  return <ul className="flex flex-col" aria-label="正在做">{blocks.map(b => <BlockRow key={b.id} block={b} handoff={handoff} />)}</ul>;
}

export function TodayStrip({ today }: { today: RailSnapshot['today'] }) {
  const cell = (n: number, label: string) => (
    <span className="flex flex-col items-center"><b className="text-lg tabular-nums text-[var(--ink)]">{n}</b><span className="text-xs text-[var(--muted)]">{label}</span></span>
  );
  return (
    <div className="mx-1 mt-3 grid grid-cols-3 rounded-lg bg-[var(--paper)] py-2" data-testid="rail-today">
      {cell(today.prepared, '备好')}{cell(today.sent, '今天投出')}{cell(today.waiting, '等你')}
    </div>
  );
}

/** 定方向时的主角：他说一句偏好，符合的岗位数当场变；每个条件一枚小签（§6.5）。 */
export function PoolPanel({ pool }: { pool: RailPool }) {
  return (
    <section aria-label="岗位池" data-testid="rail-pool" className="mx-1 rounded-lg bg-[var(--paper)] px-3 py-2">
      <p className="font-human text-sm text-[var(--ink)]">
        符合的 <b className="text-lg tabular-nums transition-all duration-300">{pool.fits}</b> 个
        <span className="ml-1 text-xs text-[var(--muted)]">（岗位库里没截止的 {pool.total} 个）</span>
      </p>
      {pool.conditions.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {pool.conditions.map(c => <li key={c} className="speech-block rounded-full border border-[var(--line-2)] px-2 py-0.5 text-xs text-[var(--ink-2)]">{c}</li>)}
        </ul>
      )}
    </section>
  );
}

/** 建档时的主角：简历一行行长出来，每行标来源；被追问出数字的那行当场变具体（数据是同一条主张）。 */
export function ResumeDraft({ experiences }: { experiences: readonly ExperienceNode[] }) {
  if (!experiences.length) {
    return <p className="mx-1 text-xs text-[var(--subtle)]">你说一句，这里就长一行。</p>;
  }
  return (
    <ol className="flex flex-col gap-2" data-testid="rail-resume-draft">
      {experiences.map(e => (
        <li key={e.id} className="speech-block rounded-lg bg-[var(--paper)] px-3 py-2">
          <div className="font-human text-sm font-semibold text-[var(--ink)]">{e.title}</div>
          {(e.role || e.org) && <div className="text-xs text-[var(--muted)]">{[e.org, e.role].filter(Boolean).join(' · ')}</div>}
          <ul className="mt-1 flex flex-col gap-0.5">
            {e.claims.map(c => (
              <li key={c.id} className="speech-block text-xs text-[var(--ink-2)]">
                · {c.text}
                <span className="ml-1 text-[var(--subtle)]">{c.created_from === 'interview' ? '来自你说的' : '来自你的材料'}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** 建档完成后简历草稿收成顶上一枚小块，点一下临时展开看一眼。 */
export function ResumeChip({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} data-testid="rail-resume-chip"
      className="mx-1 mt-3 inline-flex items-center gap-1.5 rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-3 py-1 text-xs text-[var(--ink-2)]">
      简历 · {count} 段 ✓
    </button>
  );
}

function receiptTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const openReceipt = (id: string) => emitEvent('career:focus', { surface: 'dossier', application_id: id });

/** 此刻里的「刚投出」：最近三张，一行一家（公司 · 岗位 · 时间）；没投过就不出这块。 */
export function RecentReceipts({ receipts }: { receipts: readonly RailReceipt[] }) {
  if (!receipts.length) return null;
  return (
    <>
      <RailHeading>刚投出</RailHeading>
      <ul className="flex flex-col" data-testid="rail-recent-receipts">
        {receipts.slice(0, RECENT_RECEIPTS).map(r => (
          <li key={r.application_id}>
            <button type="button" onClick={() => openReceipt(r.application_id)}
              className="flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-[var(--hover)]">
              <span className="shrink-0 text-xs text-[var(--success)]" aria-hidden="true">✓</span>
              <span className="min-w-0 flex-1 truncate font-human text-sm text-[var(--ink)]">{r.company} · {r.title}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]">{receiptTime(r.at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Receipts({ receipts }: { receipts: readonly RailReceipt[] }) {
  if (!receipts.length) return <p className="mx-1 text-xs text-[var(--subtle)]">投出去的每一份都会在这里留一张回执。</p>;
  return (
    <ul className="flex flex-col" data-testid="rail-receipts">
      {receipts.map(r => (
        <li key={r.application_id}>
          <button type="button" onClick={() => openReceipt(r.application_id)}
            className="speech-block flex w-full items-start gap-2 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-[var(--hover)]">
            <span className="mt-0.5 shrink-0 text-xs text-[var(--success)]">✓</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-human text-sm text-[var(--ink)]">{r.company} · {r.title}</span>
              <span className="block truncate text-xs text-[var(--muted)]">
                {[receiptTime(r.at), r.resume ? `用的「${r.resume}」` : null, r.filled !== null ? `填了 ${r.filled} 格` : null].filter(Boolean).join(' · ')}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const TRUST_TEXT: Record<TrustEntry['state'], string> = { new: '还没投过', shown: '当面做过', delegated: '已交给我' };

export function Learned({ learned, onChanged }: { learned: ReadonlyArray<TrustEntry & { propose: boolean }>; onChanged: () => void }) {
  if (!learned.length) return <p className="mx-1 text-xs text-[var(--subtle)]">每学会一种网申系统，这里多一枚。</p>;
  const stamp = async (key: string) => { await careerApi.trust(key, 'delegate'); onChanged(); };
  return (
    <ul className="flex flex-col gap-1" data-testid="rail-learned">
      {learned.map(e => (
        <li key={e.key} className="speech-block flex items-center gap-2 px-1 py-1">
          <span className="font-human text-sm text-[var(--ink)]">{e.label}</span>
          <span className="text-xs text-[var(--muted)]">{TRUST_TEXT[e.state]} · {e.successes} 份</span>
          {e.propose && (
            <button type="button" onClick={() => void stamp(e.key)}
              className="ml-auto shrink-0 rounded-md border-[1.5px] border-[var(--primary)] px-2 py-0.5 text-xs font-semibold text-[var(--primary)]">
              以后同类直接投
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
