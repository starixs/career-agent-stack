/**
 * 面试准备卡（interview_prep）：「帮我准备 X 的面试」的终态，只放最可能出事的少数几条。
 * 时间 → 上一轮 / 同类面试卡在哪 → 三个高风险深挖点 → 几道题 → 开始模拟。数据来自服务端 buildInterviewPrep。
 */
import { CalendarClock } from 'lucide-react';

import { requestNavigation } from '@/features/career-shell/navModel';

import { INTERVIEW_ROUND_LABELS } from './careerConstants';
import { Badge, Button, suggestToChat } from './CareerPrimitives';
import { CardShell, list, str, type CardProps } from './FlowCardShell';

const RISK_LABEL: Record<string, string> = { high: '高风险', mid: '中', medium: '中', low: '低' };

function whenText(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s) : []);

export function InterviewPrepCard({ card, onDismiss }: CardProps) {
  const d = card.data;
  const round = str(d.round);
  const roundLabel = round ? INTERVIEW_ROUND_LABELS[round] ?? round : null;
  const company = str(d.company) ?? '';
  const when = whenText(str(d.at));
  const carried = list(d.carried).map(c => ({ label: c.same_application === true ? '上一轮' : `${str(c.company) ?? '别家'}同类面试`, points: strings(c.points) })).filter(c => c.points.length);
  const predictions = list(d.predictions).map(p => ({ statement: str(p.statement) ?? '', risk: str(p.risk) ?? 'mid', chain: strings(p.chain) })).filter(p => p.statement);
  const questions = list(d.questions).map(q => ({ id: str(q.id) ?? '', content: str(q.content) ?? '' })).filter(q => q.content);
  const jobId = str(d.job_id);
  const start = () => suggestToChat(`开始模拟 ${company} ${roundLabel ?? '面试'}（job_id=${jobId ?? ''}${round ? `，round=${round}` : ''}），先从高风险的深挖点问起`);
  return (
    <CardShell testId="career-card-interview_prep" icon={<CalendarClock className="size-4" />} title={card.title} badge={roundLabel ? <Badge tone="accent">{roundLabel}</Badge> : undefined} onDismiss={onDismiss}>
      {when && <div className="font-human text-base text-[var(--ink)]">{when}</div>}
      {carried.length > 0 && (
        <section className="mt-3">
          <div className="text-xs text-[var(--muted)]">上次卡在哪</div>
          {carried.map(c => (
            <div key={c.label} className="mt-1 text-sm text-[var(--ink-2)]"><span className="text-[var(--muted)]">{c.label}：</span>{c.points.join('；')}</div>
          ))}
        </section>
      )}
      {predictions.length > 0 && (
        <section className="mt-3">
          <div className="text-xs text-[var(--muted)]">最可能被深挖的</div>
          <ol className="mt-1 space-y-1.5">
            {predictions.map(p => (
              <li key={p.statement} className="text-sm text-[var(--ink)]">
                <span className={p.risk === 'high' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}>{RISK_LABEL[p.risk] ?? p.risk} · </span>{p.statement}
                {p.chain.length > 0 && <div className="text-xs text-[var(--muted)]">{p.chain.join(' → ')}</div>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {questions.length > 0 && (
        <section className="mt-3">
          <div className="text-xs text-[var(--muted)]">先练这几道</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--ink-2)]">{questions.map(q => <li key={q.id || q.content}>{q.content}</li>)}</ul>
        </section>
      )}
      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" onClick={start}>开始模拟</Button>
        <Button variant="ghost" onClick={() => requestNavigation({ kind: 'career-dossier', view: 'interview' })}>看全部题和记录</Button>
      </div>
    </CardShell>
  );
}
