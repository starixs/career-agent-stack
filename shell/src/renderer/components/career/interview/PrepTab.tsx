/**
 * 面试助力 ·「准备」：围绕一场面试，把预测追问、出题、模拟面试、项目讲述四个技能摆成一条准备的路。
 *   准备哪一场 →「帮我准备这一场」（一键，缺的预测和题由小芽补齐）
 *   会被深挖的（预测追问的成果）→ 先练这几道（按岗位出的题）→ 模拟一场（面试官视角的复盘；讲一遍项目也从这里开始）
 * 每一步都是选一下、点一下，对象 id 走隐藏上下文，不用打字。
 */
import { useState, type ReactNode } from 'react';

import { pageSurfaceId } from '@/features/career-shell/pageSurface';

import { safeJson } from '../careerApi';
import { INTERVIEW_ROUND_LABELS, MOCK_MODE_LABELS } from '../careerConstants';
import { Button, Select, StructuredJson, formatDate, useSuggestToChat } from '../CareerPrimitives';
import { Disclosure } from '../skills/results/parts';
import { MockReport, isMockReport } from '../skills/results/MockReport';
import { PredictionList, riskSummary, sortByRisk } from '../skills/results/PredictionList';
import type { DossierSummary, Interview, MockInterview, ProbePrediction, QuestionItem } from '../types';

import { buildPrepTargets, type PrepTarget } from './prepTargets';

export interface PrepData {
  interviews: Interview[]; mocks: MockInterview[]; predictions: ProbePrediction[]; dossiers: DossierSummary[]; questions: QuestionItem[];
}

/** 这一页发出去的话，回复结束后带他回到面试助力看结果。 */
const SURFACE = pageSurfaceId({ kind: 'career-dossier', view: 'interview' });
/** 预测和题目先各摆这么多条：面试前一晚要的是最可能出事的那几条，其余点开再看。 */
const TOP_PREDICTIONS = 5;
const TOP_QUESTIONS = 5;
const ROUND_OPTIONS = (['first', 'second', 'final', 'hr'] as const).map(value => ({ value, label: INTERVIEW_ROUND_LABELS[value] }));

function Section({ title, meta, actions, children }: { title: string; meta?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-[var(--ink)]">{title}</h2>
        {meta && <span className="text-xs tabular-nums text-[var(--muted)]">{meta}</span>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Predictions({ predictions, onPredict }: { predictions: ProbePrediction[]; onPredict: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = sortByRisk(predictions);
  const visible = showAll ? sorted : sorted.slice(0, TOP_PREDICTIONS);
  return (
    <Section title="会被深挖的" meta={riskSummary(predictions)} actions={<Button size="sm" variant="ghost" onClick={onPredict}>{predictions.length ? '重新预测' : '预测追问'}</Button>}>
      {visible.length > 0 && <PredictionList predictions={visible} />}
      {sorted.length > TOP_PREDICTIONS && (
        <Button size="sm" variant="ghost" className="mt-1 -ml-3" onClick={() => setShowAll(value => !value)}>{showAll ? '只看最要紧的' : `看全部 ${sorted.length} 条`}</Button>
      )}
    </Section>
  );
}

/** 没练过的、分数低的排前面。 */
function pickQuestions(questions: QuestionItem[], target: PrepTarget | null): QuestionItem[] {
  const jobId = target?.refs.job_id;
  const mine = questions.filter(q => q.kind === 'interview' && ((jobId && q.job_id === jobId) || (!!target?.company && q.company_name === target.company)));
  const pool = mine.length ? mine : questions.filter(q => q.kind === 'interview');
  return [...pool].sort((a, b) => (a.last_attempt_score ?? -1) - (b.last_attempt_score ?? -1)).slice(0, TOP_QUESTIONS);
}

function Questions({ questions, onGenerate, onOpenBank }: { questions: QuestionItem[]; onGenerate: () => void; onOpenBank: () => void }) {
  const suggest = useSuggestToChat();
  return (
    <Section
      title="先练这几道"
      actions={<><Button size="sm" variant="ghost" onClick={onOpenBank}>全部题目</Button><Button size="sm" variant="ghost" onClick={onGenerate}>出一组题</Button></>}
    >
      {questions.length > 0 && (
        <ul className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
          {questions.map(question => (
            <li key={question.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 text-sm leading-relaxed text-[var(--ink)]">{question.content}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--subtle)]">{question.attempt_count ? `上次 ${question.last_attempt_score ?? '—'} 分` : '没练过'}</span>
              <Button size="sm" variant="ghost" onClick={() => suggest(`用这道题考我：${question.content}`, { surface: SURFACE, refs: { question_id: question.id } })}>练这道</Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function MockRow({ mock }: { mock: MockInterview }) {
  const suggest = useSuggestToChat();
  const turns = safeJson<unknown[]>(mock.turns_json, []);
  const report = safeJson<unknown>(mock.report_json, null);
  const title = [MOCK_MODE_LABELS[mock.mode] ?? mock.mode, mock.round && (INTERVIEW_ROUND_LABELS[mock.round] ?? mock.round), mock.company_type].filter(Boolean).join(' · ');
  return (
    <Disclosure
      summary={(
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{title}</span>
          <span className="shrink-0 text-xs tabular-nums text-[var(--subtle)]">{formatDate(mock.created_at)} · 问了 {turns.length} 轮{report ? '' : ' · 没练完'}</span>
        </span>
      )}
    >
      {report !== null && (isMockReport(report) ? <MockReport report={report} /> : <StructuredJson value={report} />)}
      {report === null && (
        <Button size="sm" onClick={() => suggest('接着练这场模拟面试', { surface: SURFACE, refs: { mock_interview_id: mock.id } })}>接着练</Button>
      )}
    </Disclosure>
  );
}

function Mocks({ mocks, target, onStart, onStory }: { mocks: MockInterview[]; target: PrepTarget | null; onStart: (round: string) => void; onStory: () => void }) {
  // 换一场准备时轮次跟着那场走；手动选过就听他的
  const [picked, setPicked] = useState<{ target: string | undefined; round: string } | null>(null);
  const round = picked && picked.target === target?.key ? picked.round : target?.round ?? 'first';
  return (
    <Section
      title="模拟一场"
      meta={mocks.length ? `${mocks.length} 场` : undefined}
      actions={(
        <>
          <div className="w-24"><Select ariaLabel="轮次" value={round} onChange={value => setPicked({ target: target?.key, round: value })} options={ROUND_OPTIONS} /></div>
          <Button size="sm" variant="ghost" onClick={() => onStart(round)}>开始模拟</Button>
          <Button size="sm" variant="ghost" onClick={onStory}>讲一遍项目</Button>
        </>
      )}
    >
      {mocks.length > 0 && <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">{mocks.map(mock => <MockRow key={mock.id} mock={mock} />)}</div>}
    </Section>
  );
}

function TargetBar({ targets, value, onChange, onPrepare }: { targets: PrepTarget[]; value: PrepTarget | null; onChange: (key: string) => void; onPrepare: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {targets.length > 0 && (
        <>
          <span className="text-sm text-[var(--muted)]">准备哪一场</span>
          <div className="w-80 max-w-full"><Select ariaLabel="准备哪一场" value={value?.key ?? ''} onChange={onChange} options={targets.map(t => ({ value: t.key, label: t.label }))} /></div>
        </>
      )}
      <Button variant="primary" onClick={onPrepare}>{targets.length ? '帮我准备这一场' : '帮我准备面试'}</Button>
    </div>
  );
}

export function PrepTab({ data, onOpenBank }: { data: PrepData; onOpenBank: () => void }) {
  const suggest = useSuggestToChat();
  const targets = buildPrepTargets(data.interviews, data.dossiers);
  const [key, setKey] = useState<string | null>(null);
  const target = targets.find(t => t.key === key) ?? targets[0] ?? null;
  const company = target?.company ?? '';
  const send = (text: string, extra: Record<string, string | undefined> = {}) => suggest(text, { surface: SURFACE, refs: { ...target?.refs, ...extra } });

  return (
    <div className="max-w-4xl space-y-8">
      <TargetBar targets={targets} value={target} onChange={setKey} onPrepare={() => send(`帮我准备${company ? `${company}的` : ''}面试`)} />
      <Predictions predictions={data.predictions} onPredict={() => send(`预测一下${company}面试会深挖我简历哪里`)} />
      <Questions questions={pickQuestions(data.questions, target)} onGenerate={() => send(`按${target?.label ?? '我投的岗位'}出一组面试题`)} onOpenBank={onOpenBank} />
      <Mocks
        mocks={data.mocks} target={target}
        onStart={round => send(`开始模拟${company}${INTERVIEW_ROUND_LABELS[round] ?? '面试'}，先从高风险的深挖点问起`, { round })}
        onStory={() => send('我想练一下讲项目，听完按结构、时长和数据可信度帮我打分')}
      />
    </div>
  );
}
