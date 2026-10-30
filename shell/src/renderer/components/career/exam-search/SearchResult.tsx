/**
 * 搜题结果：一题一行，答案先行（大字），出处标明，解析和类似题默认收起。
 * 说实话：题库原题 / 参考了类似题 / 模型作答分开标；模型拿不准的标「拿不准」。
 */
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { Badge, type BadgeTone } from '../CareerPrimitives';
import type { BankMatch, MatchTier, QuestionAnswer, SearchQuestion } from './examSearchApi';

const TIER_LABEL: Record<MatchTier, string> = { 'same-role-company': '同公司同岗位', 'same-role': '同岗位', 'same-company': '同公司', general: '通用题库' };


export function whereOf(match: Pick<BankMatch, 'company_name' | 'role_title' | 'year'>): string {
  return [match.company_name, match.role_title, match.year].filter(Boolean).join(' · ');
}

export function sourceLabel(question: SearchQuestion, answer: QuestionAnswer | undefined): { text: string; tone: BadgeTone } | null {
  if (!answer) return null;
  const top = question.matches[0];
  if (answer.source === 'bank' && top) return { text: `题库原题${whereOf(top) ? ` · ${whereOf(top)}` : ''}`, tone: 'success' };
  if (answer.source === 'reference' && top) return { text: `参考了${TIER_LABEL[top.tier]}的类似题`, tone: 'info' };
  return { text: '题库里没有，模型作答', tone: 'neutral' };
}

/** 第一条候选如果就是本题（题库原题），类似题从第二条起算。 */
export function similarOf(question: SearchQuestion, answer: QuestionAnswer | undefined): BankMatch[] {
  const top = question.matches[0];
  if (!top) return [];
  return answer?.source === 'bank' || top.same ? question.matches.slice(1) : question.matches;
}

function Toggle({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-0.5 text-xs text-[var(--muted)] hover:text-[var(--ink)]">
      <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />{label}
    </button>
  );
}

function SimilarList({ matches }: { matches: BankMatch[] }) {
  return (
    <ul className="mt-1.5 space-y-2 border-l-2 border-[var(--line)] pl-3">
      {matches.map(match => (
        <li key={match.item_id} className="text-xs">
          <div className="text-[var(--subtle)]">{TIER_LABEL[match.tier]}{whereOf(match) ? ` · ${whereOf(match)}` : ''}</div>
          <div className="text-[var(--ink-2)]">{match.stem}</div>
          {match.options.length > 0 && <div className="text-[var(--muted)]">{match.options.join('　')}</div>}
          <div className="text-[var(--ink)]">答案：{match.answer ?? '题库没给'}{match.explanation ? `（${match.explanation}）` : ''}</div>
        </li>
      ))}
    </ul>
  );
}

function QuestionRow({ question, answer, pending }: { question: SearchQuestion; answer: QuestionAnswer | undefined; pending: boolean }) {
  const [openExplain, setOpenExplain] = useState(false);
  const [openSimilar, setOpenSimilar] = useState(false);
  const source = sourceLabel(question, answer);
  const similar = similarOf(question, answer);
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-x-3 border-b border-[var(--line)] py-3 last:border-b-0">
      <div className="pt-1 text-right text-sm font-semibold tabular-nums text-[var(--subtle)]">{question.index + 1}</div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-3">
          <span className="text-xs text-[var(--muted)]">{question.qtype === 'personality' ? '建议倾向' : '答案'}</span>
          {answer
            ? <span className="font-human text-2xl font-semibold text-[var(--ink)]">{answer.answer}</span>
            : <span className="text-sm text-[var(--subtle)]">{pending ? '作答中…' : '没有答案'}</span>}
          {answer?.confidence === 'low' && <Badge tone="warning">拿不准</Badge>}
          {source && <Badge tone={source.tone}>{source.text}</Badge>}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-[var(--ink-2)]" title={question.stem}>{question.stem}</p>
        {question.options.length > 0 && <p className="line-clamp-2 text-xs text-[var(--muted)]">{question.options.join('　')}</p>}
        <div className="mt-1 flex gap-4">
          {answer?.explanation && <Toggle open={openExplain} label="解析" onClick={() => setOpenExplain(v => !v)} />}
          {similar.length > 0 && <Toggle open={openSimilar} label={`类似题 ${similar.length}`} onClick={() => setOpenSimilar(v => !v)} />}
        </div>
        {openExplain && answer && <p className="mt-1 text-sm text-[var(--ink-2)]">{answer.explanation}</p>}
        {openSimilar && <SimilarList matches={similar} />}
      </div>
    </li>
  );
}

export function SearchResult({ questions, answers, pending }: { questions: SearchQuestion[]; answers: QuestionAnswer[]; pending: boolean }) {
  const byIndex = new Map(answers.map(answer => [answer.index, answer]));
  return (
    <ol>
      {questions.map(question => <QuestionRow key={question.index} question={question} answer={byIndex.get(question.index)} pending={pending} />)}
    </ol>
  );
}
