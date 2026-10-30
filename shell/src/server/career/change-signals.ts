/**
 * 「换方向 / 补短板」的信号（2026-10-30 定，低谷面）：只有数据出现信号时，复盘才把它作为一条建议提出，用户点了才调
 * direction_explore / gap_plan。拒信当天不提——换方向不是安慰。
 */
import { classifyJobTitle, type Deadline, type StageHistoryRow } from '@career/core';

/** 某类岗位投出这么多份仍没有一份进笔试，才算「这个方向可能不对」 */
export const DIRECTION_MIN_SENT = 30;
/** 最近连续这么多封拒信挂在同一个环节（笔试或面试），才算「这一环有短板」 */
export const SAME_STAGE_FAILS = 3;
/** 最近一封拒信之后这么久内不提换方向 / 补短板 */
export const REJECTION_COOLDOWN_MS = 24 * 3_600_000;

export interface ChangeSignal { tool: 'direction_explore' | 'gap_plan'; text: string }
type Layer = 'resume' | 'exam' | 'interview';
const LAYER_LABEL: Record<Layer, string> = { resume: '简历', exam: '笔试', interview: '面试' };
const PAST_RESUME = new Set(['responded', 'interview', 'offer', 'hired']);

export function changeSignals(input: {
  apps: Array<{ id: string; job: { title: string | null } }>; history: StageHistoryRow[]; deadlines: Deadline[]; nowIso: string;
}): ChangeSignal[] {
  const { apps, history, nowIso } = input;
  const exams = new Set(input.deadlines.filter(d => (d.kind === 'assessment' || d.kind === 'written_test') && d.status !== 'cancelled' && d.application_id).map(d => d.application_id!));
  const sent = new Set<string>(); const pastResume = new Set<string>(exams); const interviewed = new Set<string>();
  const rejections: Array<{ id: string; at: number; layer: Layer }> = [];
  for (const h of history) {
    if (h.to_stage === 'applied') sent.add(h.application_id);
    if (PAST_RESUME.has(h.to_stage)) pastResume.add(h.application_id);
    if (h.to_stage === 'interview') interviewed.add(h.application_id);
    if (h.to_stage === 'rejected') {
      const layer: Layer = interviewed.has(h.application_id) ? 'interview' : exams.has(h.application_id) ? 'exam' : 'resume';
      rejections.push({ id: h.application_id, at: Date.parse(h.created_at), layer });
    }
  }
  const last = rejections.at(-1);
  if (last && Date.parse(nowIso) - last.at < REJECTION_COOLDOWN_MS) return [];
  return [...directionSignals(apps, sent, pastResume), ...gapSignal(rejections)];
}

function directionSignals(apps: Array<{ id: string; job: { title: string | null } }>, sent: Set<string>, pastResume: Set<string>): ChangeSignal[] {
  const byCat = new Map<string, { sent: number; past: number }>();
  for (const a of apps) {
    if (!sent.has(a.id)) continue;
    const cat = classifyJobTitle(a.job.title);
    const c = byCat.get(cat) ?? { sent: 0, past: 0 };
    c.sent++; if (pastResume.has(a.id)) c.past++;
    byCat.set(cat, c);
  }
  return [...byCat].filter(([, c]) => c.sent >= DIRECTION_MIN_SENT && c.past === 0)
    .map(([cat, c]) => ({ tool: 'direction_explore', text: `「${cat}」类投出 ${c.sent} 份，没有一份进笔试` }));
}

function gapSignal(rejections: Array<{ layer: Layer }>): ChangeSignal[] {
  const tail = rejections.slice(-SAME_STAGE_FAILS);
  if (tail.length < SAME_STAGE_FAILS) return [];
  const layer = tail[0].layer;
  if (layer === 'resume' || tail.some(r => r.layer !== layer)) return [];
  return [{ tool: 'gap_plan', text: `最近 ${SAME_STAGE_FAILS} 封拒信都挂在${LAYER_LABEL[layer]}` }];
}
