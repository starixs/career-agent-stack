/**
 * 漏斗右侧面板：平时留白，悬停某一层才出现。每层回答用户此刻隐含想知道的事——
 * 投出：投够了吗、还有多少在路上；笔试/测评：做了哪些；面试：下一场、面过哪些轮；Offer：有哪些、多久要答复。
 * 只放数据、细节和一句来自真实数据的分析；鼓励的话交给页底的手写模块。
 */
import type { MonthBoard } from '@/components/career/types';

import { LAYER_COLORS, LAYER_INK, LAYER_NAMES, improvedRate } from './monthFunnelGeometry';

const UNITS = ['份投递', '家给了笔试或测评', '家请你面试', '个 Offer'];
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function when(iso: string | null): string {
  if (!iso) return '时间待定';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

export function LayerPanel({ board, layer }: { board: MonthBoard; layer: number }) {
  const { counts, prev } = board;
  const rate = improvedRate(counts, prev, layer);
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <div className="flex items-baseline justify-between">
        <span className="font-human text-2xl" style={{ color: LAYER_INK[layer] }}>{LAYER_NAMES[layer]}</span>
        <span className="text-xs text-[var(--subtle)]">{layer + 1} / 4</span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-3">
          <span className="font-human font-semibold text-[var(--ink)]" style={{ fontSize: 60, lineHeight: '64px' }}>{counts[layer]}</span>
          <span className="font-human text-xl font-semibold">{UNITS[layer]}</span>
          {prev && <span className="text-xs text-[var(--subtle)]">上月 {prev[layer]}</span>}
        </div>
        {rate && (
          <span className="text-sm font-semibold" style={{ color: LAYER_INK[layer] }}>
            从上一层走到这里 {Math.round(rate.now * 100)}% · 上月 {Math.round(rate.before * 100)}%
          </span>
        )}
      </div>
      {layer === 0 && <SentDetail board={board} />}
      {layer === 1 && <ExamDetail board={board} />}
      {layer === 2 && <InterviewDetail board={board} />}
      {layer === 3 && <OfferDetail board={board} />}
    </div>
  );
}

function SentDetail({ board }: { board: MonthBoard }) {
  const max = Math.max(1, ...board.days.map((d) => d.sent));
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex h-[88px] items-end gap-1 border-b-[1.5px] border-[var(--ink)] pb-[3px]" aria-label="本月每天投出">
        {board.days.map((d) => (
          <span
            key={d.day}
            title={`${board.month.month}/${d.day} 投出 ${d.sent} 份`}
            className="flex-1 rounded-t-[4px] rounded-b-[1px]"
            style={d.sent === 0
              ? { height: 2, background: 'var(--line)' }
              : { height: Math.max(4, Math.round((d.sent / max) * 80)), ...(d.pending ? { background: 'rgba(52,86,196,0.12)', boxShadow: `inset 0 0 0 1.5px ${LAYER_COLORS[0]}` } : { background: LAYER_COLORS[0] }) }}
          />
        ))}
      </div>
      <div className="flex justify-between text-xs text-[var(--subtle)]"><span>1 日</span><span>15 日</span><span>{board.month.days} 日</span></div>
      {board.in_transit > 0 && (
        <span className="text-sm text-[var(--ink)]">
          还有 <b className="font-semibold">{board.in_transit}</b> 份在路上
          {board.prev && board.rhythm.reply_days !== null && <span className="text-[var(--muted)]"> · 你的回音多半在投出后 {Math.round(board.rhythm.reply_days)} 天内到</span>}
        </span>
      )}
    </div>
  );
}

function ExamDetail({ board }: { board: MonthBoard }) {
  const rows = board.exams.slice(0, 6);
  const more = board.exams.length - rows.length;
  return (
    <div className="flex flex-col">
      {rows.map((e, i) => {
        const done = e.status === 'done'; const missed = e.status === 'missed';
        return (
          <div key={`${e.company}-${i}`} className="grid h-11 grid-cols-[34px_1fr_auto] items-center border-b border-[var(--line)] text-sm">
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
              style={done ? { background: LAYER_COLORS[1], color: '#fff' } : missed ? { background: 'var(--inset)', color: 'var(--muted)' } : { boxShadow: `inset 0 0 0 1.5px ${LAYER_COLORS[1]}`, color: LAYER_INK[1] }}
            >{done ? '✓' : missed ? '✕' : '○'}</span>
            <span><b className="font-semibold">{e.company}</b> <span className="text-[var(--muted)]">{e.kind === 'assessment' ? '测评' : '笔试'}</span></span>
            <span className="text-xs text-[var(--subtle)]">{done ? '做完' : missed ? '错过' : '待做'} · {when(e.due_at)}</span>
          </div>
        );
      })}
      {more > 0 && <span className="pt-2.5 text-xs text-[var(--subtle)]">还有 {more} 场</span>}
    </div>
  );
}

function InterviewDetail({ board }: { board: MonthBoard }) {
  const next = board.next_interview;
  return (
    <div className="flex flex-col gap-3.5">
      {next && (
        <div className="flex items-center justify-between rounded-[var(--radius-lg)] px-5 py-4" style={{ background: 'rgba(219,90,120,0.12)' }}>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs" style={{ color: LAYER_INK[2] }}>下一场</span>
            <span className="text-xl font-semibold text-[var(--ink)]">{next.company} · {next.round}</span>
            <span className="text-sm text-[var(--ink-2)]">{when(next.date)}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="font-human text-5xl font-semibold" style={{ color: LAYER_INK[2] }}>{daysUntil(next.date)}</span>
            <span className="text-xs" style={{ color: LAYER_INK[2] }}>天后</span>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {board.interviews.flatMap((row) => row.rounds.map((r, i) => (
          <span
            key={`${row.company}-${i}`}
            className="rounded-[var(--radius-lg)] px-3 py-1.5 text-sm"
            style={r.done ? { background: 'var(--inset)', color: 'var(--ink)' } : { background: 'var(--paper)', color: LAYER_INK[2], fontWeight: 600, boxShadow: `inset 0 0 0 1.5px ${LAYER_COLORS[2]}` }}
          >{r.done ? '✓' : '○'} {row.company} {r.round}{!r.done && r.date ? ` ${new Date(r.date).getMonth() + 1}/${new Date(r.date).getDate()}` : ''}</span>
        )))}
      </div>
      {board.prev && board.rhythm.first_interview_after !== null && (
        <span className="font-human text-lg text-[var(--muted)]">你第一次进面试，是在第 {board.rhythm.first_interview_after} 份之后</span>
      )}
    </div>
  );
}

function OfferDetail({ board }: { board: MonthBoard }) {
  if (!board.offers.length) return <span className="font-human text-xl text-[var(--subtle)]">这一层还空着，往上看看已经走到哪了</span>;
  return (
    <div className="flex gap-4">
      {board.offers.map((o) => (
        <div key={o.company} className="flex flex-1 flex-col gap-3 rounded-[var(--radius-lg)] bg-[var(--paper)] p-5 shadow-[var(--shadow-md)]">
          <div className="flex items-center gap-3">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={LAYER_INK[3]} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="9" r="6" /><path d="M8.5 14 7 22l5-3 5 3-1.5-8" /></svg>
            <div className="flex flex-col"><span className="text-2xl font-semibold">{o.company}</span><span className="text-sm text-[var(--ink-2)]">{[o.location, o.title].filter(Boolean).join(' · ')}</span></div>
          </div>
          {o.reply_by && <span className="text-xs text-[var(--muted)]">{when(o.reply_by).split(' ')[0]} 前答复 · 还剩 {daysUntil(o.reply_by)} 天</span>}
        </div>
      ))}
    </div>
  );
}
