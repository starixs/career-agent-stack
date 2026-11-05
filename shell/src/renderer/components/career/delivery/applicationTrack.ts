/**
 * 申请对象卡上那条路（规范 §5.8）：投出 → 笔试 / 面试的各个时间点 → 结果。
 * 发生过的为墨色（on），等你的那一节为钢笔蓝（ask，来自同一份要你的事），没到的为灰。
 * 邮件投递的申请：第一节叫「邮件发出」，跟进发出、对方回信各加一节（来自卷宗里的邮件），等你的跟进 / 回信 / 重发是钢笔蓝。
 */
import { isMailApplication, isSentStage, mailAskNodes, mailTrackNodes, pendingApplyAsk } from '../mail-apply/liveMail';
import type { Dossier } from '../types';
import { whenText } from './askText';
import type { AskView } from './deliveryApi';

export interface TrackNode { key: string; label: string; date?: string; on?: boolean; ask?: boolean }

const KIND_LABEL: Partial<Record<string, string>> = { assessment: '测评', written_test: '笔试', interview: '面试', offer_reply: '回复 Offer' };
const DONE = new Set(['done', 'skipped']);
const dateOnly = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日`; };

/** 「美团 · 后端开发 一面」→「一面」；认不出轮次就用种类。 */
function deadlineLabel(title: string, kind: string): string {
  const round = /([一二三四五六终]面|HR\s*面|笔试|测评)/.exec(title)?.[1];
  return round ?? KIND_LABEL[kind] ?? title;
}

type TrackSource = Pick<Dossier, 'application' | 'history' | 'deadlines'> & Partial<Pick<Dossier, 'job' | 'mails'>>;

/** 第一节（投出 / 邮件发出）以及邮件申请多出的几节。 */
function sentNodes(d: TrackSource, asks: readonly AskView[]): TrackNode[] {
  const sent = d.history.find(h => h.to_stage === 'applied');
  const mail = isMailApplication({ submission_evidence: d.application.submission_evidence, apply_email: d.job?.apply_email });
  const on = !!sent || (mail ? isSentStage(d.application.stage) : d.application.stage !== 'evaluated');
  const first: TrackNode = { key: 'sent', label: mail ? '邮件发出' : '投出', date: sent ? dateOnly(sent.created_at) : undefined, on };
  if (!mail) return [first];
  const waiting = on ? undefined : pendingApplyAsk(asks);
  const head = waiting?.sources[0] ? { ...first, key: waiting.sources[0].id, ask: true } : first;
  return [head, ...mailTrackNodes(d.mails ?? []), ...mailAskNodes(asks)];
}

export function applicationTrack(d: TrackSource, asks: readonly AskView[], now = new Date()): TrackNode[] {
  const askOf = new Map(asks.flatMap(a => a.sources.map(s => [s.id, a] as const)));
  const nodes: TrackNode[] = sentNodes(d, asks);
  const points = d.deadlines.filter(x => x.status !== 'cancelled' && KIND_LABEL[x.kind]).sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));
  for (const p of points) {
    const ask = askOf.get(p.id);
    const happened = DONE.has(p.status) || (!!p.due_at && Date.parse(p.due_at) < now.getTime() && !ask);
    nodes.push({ key: p.id, label: ask ? ask.title.split(' · ').pop()! : deadlineLabel(p.title, p.kind), date: p.due_at ? whenText(p.due_at, now) : '时间未知', on: happened, ask: !!ask });
  }
  const stage = d.application.stage;
  if (stage === 'offer' || stage === 'hired') nodes.push({ key: 'end', label: 'Offer', on: true });
  else if (stage === 'rejected') nodes.push({ key: 'end', label: '不合适', on: true });
  else if (!nodes.some(n => !n.on)) nodes.push({ key: 'next', label: '等回音' });
  return nodes;
}
