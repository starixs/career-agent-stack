/**
 * 右栏的几块（主线体验 §6.1a / §6.5，11-02 定）：后台在做什么全在右栏，不进对话。
 *  - 主线进度：建档 → 方向 → 当面投 → 一小批 → 放手，只告诉他走到哪、还剩几步，不能点。
 *  - 等你：一次只亮一件在最上。
 *  - 正在做：几个预设岗位（写简历、定制、网申、盯邮箱），每个一行人话。
 *  - 今天：备好 · 投出 · 等你 三个真数。
 *  - 简历草稿：建档时边聊边长，每行标来源（来自你说的）。
 *  - 回执、学会了：一份份攒下来；学会了的那一类，做通够数时他可以盖章「以后同类直接投」。
 */
import { emitEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import type { ExperienceNode } from '@/components/career/types';
import { MAINLINE_STAGE_ORDER, type MainlineStage, type RailBlock, type RailPool, type RailReceipt, type RailSnapshot, type TrustEntry } from '../../../shared/careerRail';

import { requestNavigation } from './navModel';

const STAGE_LABELS: Record<MainlineStage, string> = { profile: '建档', direction: '方向', first: '当面投', batch: '一小批', released: '放手' };
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

export function MainlineProgress({ stage }: { stage: MainlineStage }) {
  const at = MAINLINE_STAGE_ORDER.indexOf(stage);
  const left = MAINLINE_STAGE_ORDER.length - 1 - at;
  return (
    <section aria-label="主线进度" data-testid="rail-mainline" className="mx-1 mt-3">
      <ol className="flex items-center gap-1">
        {MAINLINE_STAGE_ORDER.map((id, i) => (
          <li key={id} className="flex min-w-0 flex-1 flex-col items-center gap-1" aria-current={i === at ? 'step' : undefined}>
            <span className={`h-1.5 w-full rounded-full transition-colors duration-300 ${i <= at ? 'bg-[var(--primary)]' : 'bg-[var(--line)]'}`} />
            <span className={`text-xs ${i === at ? 'font-semibold text-[var(--ink)]' : 'text-[var(--muted)]'}`}>{STAGE_LABELS[id]}</span>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-center text-xs text-[var(--subtle)]">{left > 0 ? `还剩 ${left} 步` : '后面的交给我，有动静叫你'}</p>
    </section>
  );
}

export function WaitingTop({ waiting }: { waiting: RailSnapshot['waiting'] }) {
  if (!waiting.count || !waiting.first) return null;
  const open = () => requestNavigation({ kind: 'career-dossier', view: 'apply' });
  return (
    <button type="button" onClick={open} data-testid="rail-waiting"
      className="mt-3 flex w-full items-start gap-2 rounded-lg border-l-[3px] border-[var(--warning)] bg-[var(--paper)] px-3 py-2 text-left transition-colors hover:bg-[var(--hover)]">
      <span className="min-w-0 flex-1">
        <span className="block font-human text-sm font-semibold text-[var(--ink)]">{waiting.first.title}</span>
        {waiting.first.detail && <span className="block truncate text-xs text-[var(--muted)]">{waiting.first.detail}</span>}
      </span>
      {waiting.count > 1 && <span className="shrink-0 text-xs text-[var(--muted)]">还有 {waiting.count - 1} 件</span>}
    </button>
  );
}

function BlockRow({ block }: { block: RailBlock }) {
  const look = () => emitEvent('career:focus', { surface: 'live_drawer' });
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
      {block.id === 'apply' && block.status === 'working' && (
        <button type="button" onClick={look} className="shrink-0 text-xs text-[var(--primary)] underline-offset-2 hover:underline">看一眼</button>
      )}
    </li>
  );
}

export function BlockRows({ blocks }: { blocks: readonly RailBlock[] }) {
  return <ul className="flex flex-col" aria-label="正在做">{blocks.map(b => <BlockRow key={b.id} block={b} />)}</ul>;
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

export function Receipts({ receipts }: { receipts: readonly RailReceipt[] }) {
  if (!receipts.length) return <p className="mx-1 text-xs text-[var(--subtle)]">投出去的每一份都会在这里留一张回执。</p>;
  const open = (id: string) => emitEvent('career:focus', { surface: 'dossier', application_id: id });
  return (
    <ul className="flex flex-col" data-testid="rail-receipts">
      {receipts.map(r => (
        <li key={r.application_id}>
          <button type="button" onClick={() => open(r.application_id)}
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
