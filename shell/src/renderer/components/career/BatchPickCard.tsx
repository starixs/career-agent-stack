/**
 * 批量勾选卡（batch_pick，face-beta-polish 2026-11-05）：小芽提议"先投这几家？"，他在一张表上点头。
 *
 * 所有入口（第一份投出之后、建议条、右栏「再投一批」、功能市场、网申进展）都出这一张。
 * 表头说清"按什么方向、用哪份简历"；每行写公司 · 岗位，后面一枚小签说这家会怎样：
 * 网申系统投过的写「我会了」，没投过的写「先停给你看」，标星的写「先给你看」。
 * 默认勾前几家、一家公司只勾一个岗（服务端算好）；没勾的行变淡、不划掉——是"这次先不投"，不是"不要"。
 */
import { Send } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';

import { requestNavigation } from '@/features/career-shell/navModel';

import { careerApi } from './careerApi';
import { Button, suggestToChat } from './CareerPrimitives';
import { NO_RESUME_OPENER } from './ColdStartCards';
import { CardShell, ErrorLine, useSubmit, type CardProps } from './FlowCardShell';
import { PickTable, pickedIds, type PickGroup, type Picked } from './PickTable';

const Row = z.object({
  job_id: z.string(), company: z.string(), title: z.string(), city: z.string().nullable(),
  system: z.string().nullable(), known: z.boolean(), target: z.boolean(), picked: z.boolean(),
});
const Data = z.object({
  rows: z.array(Row).default([]),
  more: z.number().int().default(0),
  direction: z.array(z.string()).default([]),
  resume: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
  blocked: z.enum(['no_resume']).nullable().default(null),
});
export type BatchPickData = z.infer<typeof Data>;

/** 行尾小签：这家投出去之前会怎样。 */
export function rowNote(r: z.infer<typeof Row>): string {
  const how = r.target ? '★ 先给你看' : r.known ? `${r.system ?? '这类网申'} · 我会了` : `${r.system ? `${r.system} · ` : ''}先停给你看`;
  return [r.city, how].filter(Boolean).join(' · ');
}

function groupOf(d: BatchPickData): PickGroup {
  const title = d.direction.length ? `按你的方向：${d.direction.slice(0, 3).join(' · ')}` : '按你的经历挑的';
  const meta = [d.resume ? `用「${d.resume.name}」` : null, d.more ? `还有 ${d.more} 家能投` : null].filter(Boolean).join(' · ') || null;
  return { id: 'batch', title, meta, rows: d.rows.map(r => ({ id: r.job_id, text: `${r.company} · ${r.title}`, note: rowNote(r) })) };
}

export function BatchPickCard({ card, onDone, onDismiss }: CardProps) {
  const parsed = Data.safeParse(card.data);
  const data: BatchPickData = parsed.success ? parsed.data : { rows: [], more: 0, direction: [], resume: null, blocked: null };
  const [picked, setPicked] = useState<Picked>(() => Object.fromEntries(data.rows.map(r => [r.job_id, r.picked])));
  const { busy, error, run } = useSubmit();
  const chosen = pickedIds(picked);
  if (!parsed.success) console.warn(`[career-card] batch_pick ${card.id} data invalid:`, parsed.error.message);
  const start = () => run(() => careerApi.startBatchPick(card.id, chosen, data.resume?.id).then(() => undefined)).then(ok => { if (ok) onDone(); });
  return (
    <CardShell testId="career-card-batch_pick" icon={<Send className="size-4" />} title={card.title} onDismiss={onDismiss}>
      {data.rows.length > 0 ? (
        <>
          <PickTable groups={[groupOf(data)]} picked={picked} onChange={setPicked} unpicked="dim" actions={(
            <>
              <Button variant="ghost" disabled={busy} onClick={onDismiss}>先不投</Button>
              <Button variant="primary" busy={busy} disabled={!chosen.length} onClick={() => void start()}>投这 {chosen.length} 家</Button>
            </>
          )} />
          <p className="mt-2 text-xs text-[var(--muted)]">填到提交前停下，检查都过了的合成一次「一键投出」给你点。</p>
        </>
      ) : data.blocked === 'no_resume' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-[var(--ink-2)]">还没有简历，先一起做一份，做好就能投。</p>
          <Button variant="primary" onClick={() => { onDismiss(); suggestToChat(NO_RESUME_OPENER); }}>先做一份简历</Button>
        </div>
      ) : <p className="text-sm text-[var(--muted)]">岗位库里暂时没有现在就能投的，有新的我再叫你。</p>}
      <ErrorLine error={error} />
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
