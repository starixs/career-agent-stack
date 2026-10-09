/**
 * 经历访谈进度（R03）：六轮普查走到哪了、下一轮要问什么、经历库还缺什么。访谈本身在对话里做。
 */
import { careerApi } from './careerApi';
import { Badge, ChatActionButton, type BadgeTone } from './CareerPrimitives';
import type { InterviewProgress } from './types';
import { useCareerQuery } from './useCareerData';

const TONE: Record<InterviewProgress['rounds'][number]['status'], BadgeTone> = { todo: 'neutral', in_progress: 'info', done: 'success', none: 'neutral' };
const LABEL: Record<InterviewProgress['rounds'][number]['status'], string> = { todo: '未聊', in_progress: '在聊', done: '聊完', none: '没有' };

export function InterviewProgressCard() {
  const query = useCareerQuery(careerApi.experienceProgress, ['kv', 'experience', 'claim']);
  const p = query.data;
  if (!p || !Array.isArray(p.rounds)) return null;
  const next = p.rounds.find(r => r.key === p.next_round);
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-xs">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-[var(--ink)]">经历访谈 {p.done} / {p.rounds.length}</span>
        {p.rounds.map(r => <Badge key={r.key} tone={TONE[r.status]}>{r.label} · {LABEL[r.status]}</Badge>)}
        <span className="flex-1" />
        <ChatActionButton variant="primary" text={next ? `继续经历访谈：${next.label}` : '帮我检查经历库还缺什么'}>{next ? `继续「${next.label}」` : '查缺补漏'}</ChatActionButton>
      </div>
      <div className="text-[var(--ink)]">{p.suggestion}</div>
      {p.follow_up_questions.length > 0 && <div className="mt-1 text-[var(--muted)]">下一轮要问：{p.follow_up_questions.join('；')}</div>}
      {(p.gaps.claims_without_metric.length > 0 || p.gaps.experiences_without_confirmed.length > 0) && (
        <div className="mt-1 text-[var(--muted)]">
          {p.gaps.experiences_without_confirmed.length > 0 && <span>还没确认主张：{p.gaps.experiences_without_confirmed.map(e => e.title).join('、')}。</span>}
          {p.gaps.claims_without_metric.length > 0 && <span>缺量化结果：{p.gaps.claims_without_metric.length} 条。</span>}
        </div>
      )}
    </div>
  );
}
