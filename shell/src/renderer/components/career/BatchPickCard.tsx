/**
 * 「今天这批」勾选卡（batch_pick，face-beta-polish 2026-11-05；plan-r2 §C 撑得住一天几十份）：
 * 小芽提议"先投这几家？"，他在一张表上点头。
 *
 * 所有入口（第一份投出之后、建议条、右栏「再投一批」、功能市场、网申进展）都出这一张。
 * 表头（BatchPickHeader）说清方向、简历、今天走到哪，三枚预设只改勾选；
 * 每行写公司 · 岗位，后面一枚小签说这家会怎样（我会了 / 先停给你看 / 先给你看），再一枚说用哪份简历。
 * 默认勾选和分组由服务端算好；没勾的行变淡、不划掉——是"这次先不投"，不是"不要"。
 * 按钮数字 = 勾选数，点下即开始，没有上限、没有待投清单。
 */
import { Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';

import { requestNavigation } from '@/features/career-shell/navModel';

import { BatchPickHeader, companyKey, onePerCompany } from './BatchPickHeader';
import { careerApi } from './careerApi';
import { Button, suggestToChat } from './CareerPrimitives';
import { NO_RESUME_OPENER } from './ColdStartCards';
import { CardShell, ErrorLine, useSubmit, type CardProps } from './FlowCardShell';
import { PickTable, type PickGroup, type Picked } from './PickTable';

const ResumePlan = z.object({
  kind: z.enum(['tailored', 'master', 'will_tailor', 'no_jd']),
  resume_id: z.string().nullable(), name: z.string().nullable(), changes: z.number().int().nullable(),
});
const Row = z.object({
  job_id: z.string(), company: z.string(), title: z.string(), city: z.string().nullable(),
  system: z.string().nullable(), known: z.boolean(), target: z.boolean(), picked: z.boolean(),
  delegated: z.boolean().default(false), deadline: z.string().nullable().default(null),
  group: z.string().default('all'), resume_plan: ResumePlan.nullable().default(null),
});
const Group = z.object({ id: z.string(), title: z.string(), collapsed: z.boolean().default(false) });
const Data = z.object({
  rows: z.array(Row).default([]),
  groups: z.array(Group).default([]),
  more: z.number().int().default(0),
  direction: z.array(z.string()).default([]),
  resume: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
  blocked: z.enum(['no_resume']).nullable().default(null),
  stage: z.enum(['profile', 'direction', 'first', 'batch', 'released']).default('batch'),
  today: z.object({ sent: z.number().int(), filling: z.number().int(), prepared: z.number().int() }).default({ sent: 0, filling: 0, prepared: 0 }),
  propose_delegate: z.array(z.object({ key: z.string(), label: z.string(), successes: z.number().int() })).default([]),
  excluded: z.number().int().default(0),
});
export type BatchPickData = z.infer<typeof Data>;
type RowData = z.infer<typeof Row>;
const EMPTY: BatchPickData = Data.parse({});

/** 行尾小签：这家投出去之前会怎样。 */
export function rowNote(r: Pick<RowData, 'city' | 'system' | 'known' | 'target'>): string {
  const how = r.target ? '★ 先给你看' : r.known ? `${r.system ?? '这类网申'} · 我会了` : `${r.system ? `${r.system} · ` : ''}先停给你看`;
  return [r.city, how].filter(Boolean).join(' · ');
}

/** 简历签：这家投时用哪份。 */
export function resumeChip(plan: RowData['resume_plan']): string | null {
  if (!plan) return null;
  if (plan.kind === 'tailored') return plan.changes != null ? `定制版 · 改 ${plan.changes} 处` : '定制版';
  if (plan.kind === 'will_tailor') return '投时按岗位定制';
  return plan.kind === 'no_jd' ? '主简历（没拿到岗位描述）' : '主简历';
}

function groupsOf(d: BatchPickData): PickGroup[] {
  const toPick = (r: RowData) => ({ id: r.job_id, text: `${r.company} · ${r.title}`, note: rowNote(r), chip: resumeChip(r.resume_plan) });
  const known = d.groups.length ? d.groups : [{ id: 'all', title: '能投的', collapsed: false }];
  const ids = new Set(known.map(g => g.id));
  const groups = known.map(g => ({ ...g, rows: d.rows.filter(r => r.group === g.id || (!ids.has(r.group) && g === known[0])).map(toPick) }));
  return groups.filter(g => g.rows.length);
}

/**
 * 一家只投一个岗开着时：新勾上的行把同公司其他行取消；一次勾上好几行（整组、⌘A、拖选）里同一家的，
 * 只留表里靠前的那行。
 */
export function keepOnePer(prev: Picked, next: Picked, rows: Array<{ job_id: string; company: string }>): Picked {
  const turnedOn = new Set(Object.keys(next).filter(id => next[id] && !prev[id]));
  if (!turnedOn.size) return next;
  const winner = new Map<string, string>();
  for (const r of rows) if (turnedOn.has(r.job_id) && !winner.has(companyKey(r.company))) winner.set(companyKey(r.company), r.job_id);
  const out = { ...next };
  for (const r of rows) {
    const w = winner.get(companyKey(r.company));
    if (w && w !== r.job_id) out[r.job_id] = false;
  }
  return out;
}

function usePicks(rows: RowData[]) {
  const [picked, setPicked] = useState<Picked>(() => Object.fromEntries(rows.map(r => [r.job_id, r.picked])));
  const [onePer, setOnePer] = useState(true);
  const change = (next: Picked) => setPicked(prev => onePer ? keepOnePer(prev, next, rows) : next);
  const preset = (ids: string[]) => { const on = new Set(ids); setPicked(Object.fromEntries(rows.map(r => [r.job_id, on.has(r.job_id)]))); };
  const togglePer = (v: boolean) => {
    setOnePer(v);
    if (v) setPicked(prev => { const keep = new Set(onePerCompany(rows.filter(r => prev[r.job_id])).map(r => r.job_id)); return Object.fromEntries(rows.map(r => [r.job_id, keep.has(r.job_id)])); });
  };
  // 按表里的顺序交出去：会了的系统在前、新网站在后（服务端排好的）
  const chosen = rows.filter(r => picked[r.job_id]).map(r => r.job_id);
  return { picked, onePer, change, preset, togglePer, chosen };
}

function PickBody({ card, data, onDone, onDismiss }: CardProps & { data: BatchPickData }) {
  const p = usePicks(data.rows);
  const { busy, error, run } = useSubmit();
  const start = () => {
    if (!p.chosen.length || busy) return;
    // 收起那一行用服务端写回的 done_line（含没开始的原因），这里只留日志
    void run(() => careerApi.startBatchPick(card.id, p.chosen, data.resume?.id).then(res => {
      if (res.skipped.length) console.info(`[career-card] batch_pick ${card.id} started=${res.started.length} skipped=${res.skipped.length}`);
    })).then(ok => { if (ok) onDone(); });
  };
  const groups = useMemo(() => groupsOf(data), [data]);
  const headerRows = useMemo(() => data.rows.map(r => ({ ...r, picked: !!p.picked[r.job_id] })), [data.rows, p.picked]);
  return (
    <>
      <BatchPickHeader data={data} rows={headerRows} onePer={p.onePer} released={data.stage === 'released'} onPreset={p.preset} onTogglePer={p.togglePer} />
      <PickTable groups={groups} picked={p.picked} onChange={p.change} unpicked="dim" filterPlaceholder="筛公司 / 城市" onPrimary={start} actions={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onDismiss}>先不投</Button>
          <Button variant="primary" busy={busy} disabled={!p.chosen.length} onClick={start}>投这 {p.chosen.length} 家</Button>
        </>
      )} />
      {(data.stage === 'first' || data.stage === 'batch') && <p className="mt-2 text-xs text-[var(--muted)]">填到提交前停下，检查都过了的合成一次「一键投出」给你点。</p>}
      <ErrorLine error={error} />
    </>
  );
}

export function BatchPickCard({ card, onDone, onDismiss }: CardProps) {
  const parsed = Data.safeParse(card.data);
  const data = parsed.success ? parsed.data : EMPTY;
  if (!parsed.success) console.warn(`[career-card] batch_pick ${card.id} data invalid:`, parsed.error.message);
  return (
    <CardShell testId="career-card-batch_pick" icon={<Send className="size-4" />} title={card.title} onDismiss={onDismiss}>
      {data.rows.length > 0 ? <PickBody card={card} data={data} onDone={onDone} onDismiss={onDismiss} />
        : data.blocked === 'no_resume' ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-[var(--ink-2)]">还没有简历，先一起做一份，做好就能投。</p>
            <Button variant="primary" onClick={() => { onDismiss(); suggestToChat(NO_RESUME_OPENER); }}>先做一份简历</Button>
          </div>
        ) : <p className="text-sm text-[var(--muted)]">{data.excluded ? '刚才那张表还在上面，从那里挑就行。' : '岗位库里暂时没有现在就能投的，有新的我再叫你。'}</p>}
    </CardShell>
  );
}

/**
 * 不在对话里的入口（右栏「再投一批」、功能市场、网申进展空状态）：回到对话，让小芽放一张勾选表。
 * 先切回对话再放卡，他看着那张表出现。
 */
export async function openBatchPick(): Promise<void> {
  requestNavigation({ kind: 'chat' });
  try {
    await careerApi.proposeBatch();
  } catch (error) {
    console.warn('[career-card] batch_pick propose failed:', error instanceof Error ? error.message : error);
  }
}
