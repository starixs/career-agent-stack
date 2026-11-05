/**
 * 面试助力 ·「准备」。他在这页要看见的是：准备的是哪一场、离它还有几天，以及三步各走到哪了。
 *   上面一张「面试票」：日期、公司和轮次、还有几天、「帮我准备这一场」（这页唯一的实心按钮）；
 *   下面三栏是一条从左到右的路：① 会被问什么（预测追问）→ ② 先练几道（按岗位出的题）→ ③ 模拟一场。
 * 每栏先用图形说清现状（风险分布条、练没练过、上次模拟的结论章），再列条目；条目整行可点。
 * 每个动作都带着这场面试的 id 发进对话，不用打字。
 */
import { useState, type ReactNode } from 'react';

import { pageSurfaceId } from '@/features/career-shell/pageSurface';

import { safeJson } from '../careerApi';
import { INTERVIEW_ROUND_LABELS, MOCK_MODE_LABELS } from '../careerConstants';
import { Button, Select, StructuredJson, formatDate, useSuggestToChat } from '../CareerPrimitives';
import { MockReport, isMockReport, mockVerdict } from '../skills/results/MockReport';
import { PredictionList, riskSegments, sortByRisk } from '../skills/results/PredictionList';
import { DateBlock, SegmentBar, Stamp, StepCircle, daysUntil, toneColor, type Tone } from '../skills/visual';
import type { DossierSummary, Interview, MockInterview, ProbePrediction, QuestionItem } from '../types';

import { buildPrepTargets, type PrepTarget } from './prepTargets';

export interface PrepData {
  interviews: Interview[]; mocks: MockInterview[]; predictions: ProbePrediction[]; dossiers: DossierSummary[]; questions: QuestionItem[];
}

/** 这一页发出去的话，回复结束后带他回到面试助力看结果。 */
const SURFACE = pageSurfaceId({ kind: 'career-dossier', view: 'interview' });
/** 预测和题目先各摆这么多条：面试前要的是最可能出事的那几条，其余点开再看。 */
const TOP_PREDICTIONS = 5;
const TOP_QUESTIONS = 5;
/** 练习得分到这个数算过关（题库页「不到 60 分」的同一条线）。 */
const PASS_SCORE = 60;
/** 离面试不到这么多天，「还有几天」用提醒色。 */
const SOON_DAYS = 3;
const ROUND_OPTIONS = (['first', 'second', 'final', 'hr'] as const).map(value => ({ value, label: INTERVIEW_ROUND_LABELS[value] }));
const ROW = 'flex w-full items-center gap-3 rounded-md py-2.5 pr-2 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]';

function countdown(at: string | null): { text: string; tone: Tone } | null {
  const days = daysUntil(at);
  if (days === null || days < 0) return null;
  if (days === 0) return { text: '就是今天', tone: 'danger' };
  return { text: `还有 ${days} 天`, tone: days <= SOON_DAYS ? 'warning' : 'neutral' };
}

function Ticket({ targets, target, onChange, onPrepare }: { targets: PrepTarget[]; target: PrepTarget | null; onChange: (key: string) => void; onPrepare: () => void }) {
  if (!target) return <Button variant="primary" size="lg" onClick={onPrepare}>帮我准备面试</Button>;
  const left = countdown(target.at);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border-[1.5px] border-[var(--hard)] bg-[var(--paper)] px-5 py-4 shadow-hard-lg">
      {target.at && (
        <>
          <DateBlock iso={target.at} />
          <span className="self-stretch border-l-[1.5px] border-dashed border-[var(--line-2)]" aria-hidden />
        </>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-human text-lg font-semibold text-[var(--ink)]">
          {target.company}{target.round ? ` · ${INTERVIEW_ROUND_LABELS[target.round] ?? target.round}` : ''}
        </div>
        {target.title && <div className="truncate text-sm text-[var(--muted)]">{target.title}</div>}
      </div>
      {left && <Stamp tone={left.tone}>{left.text}</Stamp>}
      {/* 票面上已经写着是哪一场，下拉里只列别的场次 */}
      {targets.length > 1 && (
        <div className="w-28"><Select ariaLabel="换一场" value="" placeholder="换一场" onChange={onChange} options={targets.filter(t => t.key !== target.key).map(t => ({ value: t.key, label: t.label }))} /></div>
      )}
      <Button variant="primary" size="lg" onClick={onPrepare}>帮我准备这一场</Button>
    </div>
  );
}

function Station({ n, title, actions, children }: { n: number; title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 space-y-4">
      <div className="flex min-h-8 items-center gap-2.5">
        <StepCircle n={n} />
        <h2 className="font-human text-base font-semibold text-[var(--ink)]">{title}</h2>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Predictions({ predictions, onPredict }: { predictions: ProbePrediction[]; onPredict: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = sortByRisk(predictions);
  return (
    <Station n={1} title="会被问什么" actions={<Button size="sm" variant="ghost" onClick={onPredict}>{predictions.length ? '重新预测' : '预测追问'}</Button>}>
      <SegmentBar label="风险分布" segments={riskSegments(predictions)} />
      {sorted.length > 0 && <PredictionList predictions={showAll ? sorted : sorted.slice(0, TOP_PREDICTIONS)} />}
      {sorted.length > TOP_PREDICTIONS && (
        <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setShowAll(value => !value)}>{showAll ? '只看最要紧的' : `看全部 ${sorted.length} 条`}</Button>
      )}
    </Station>
  );
}

/** 没练过的、分数低的排前面。 */
function pickQuestions(questions: QuestionItem[], target: PrepTarget | null): QuestionItem[] {
  const jobId = target?.refs.job_id;
  const mine = questions.filter(q => q.kind === 'interview' && ((jobId && q.job_id === jobId) || (!!target?.company && q.company_name === target.company)));
  const pool = mine.length ? mine : questions.filter(q => q.kind === 'interview');
  return [...pool].sort((a, b) => (a.last_attempt_score ?? -1) - (b.last_attempt_score ?? -1)).slice(0, TOP_QUESTIONS);
}

/** 一道题练得怎样：没练过是虚线空圈，练过是带分数的圈，不到过关线用提醒色。 */
function ScoreRing({ question }: { question: QuestionItem }) {
  const score = question.attempt_count ? question.last_attempt_score : null;
  if (score === null) return <span className="h-8 w-8 shrink-0 rounded-full border-[1.5px] border-dashed border-[var(--line-2)]" role="img" aria-label="没练过" />;
  const tone: Tone = score < PASS_SCORE ? 'warning' : 'success';
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[1.5px] text-xs font-semibold tabular-nums"
      style={{ borderColor: toneColor(tone), color: toneColor(tone) }} role="img" aria-label={`上次 ${score} 分`}
    >
      {score}
    </span>
  );
}

function Questions({ questions, onGenerate, onOpenBank }: { questions: QuestionItem[]; onGenerate: () => void; onOpenBank: () => void }) {
  const suggest = useSuggestToChat();
  const practiced = questions.filter(q => q.attempt_count > 0).length;
  return (
    <Station
      n={2} title="先练几道"
      actions={<><Button size="sm" variant="ghost" onClick={onOpenBank}>题库</Button><Button size="sm" variant="ghost" onClick={onGenerate}>出一组题</Button></>}
    >
      <SegmentBar label="练习情况" segments={[{ label: '练过', value: practiced, tone: 'success' }, { label: '没练', value: questions.length - practiced, tone: 'neutral' }]} />
      {questions.length > 0 && (
        <ul className="divide-y divide-[var(--line)]">
          {questions.map(question => (
            <li key={question.id}>
              <button
                type="button" aria-label={`练这道：${question.content}`} className={ROW}
                onClick={() => suggest(`用这道题考我：${question.content}`, { surface: SURFACE, refs: { question_id: question.id } })}
              >
                <ScoreRing question={question} />
                <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-relaxed text-[var(--ink)]">{question.content}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Station>
  );
}

function MockRow({ mock }: { mock: MockInterview }) {
  const suggest = useSuggestToChat();
  const [open, setOpen] = useState(false);
  const turns = safeJson<unknown[]>(mock.turns_json, []);
  const report = safeJson<unknown>(mock.report_json, null);
  const verdict = report === null ? { label: '没练完', tone: 'neutral' as const } : mockVerdict(report);
  const title = [mock.round ? INTERVIEW_ROUND_LABELS[mock.round] ?? mock.round : MOCK_MODE_LABELS[mock.mode] ?? mock.mode, mock.company_type].filter(Boolean).join(' · ');
  return (
    <li>
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className={ROW}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--ink)]">{title}</span>
          <span className="block text-xs tabular-nums text-[var(--muted)]">{formatDate(mock.created_at)} · {turns.length} 轮</span>
        </span>
        {verdict && <Stamp tone={verdict.tone}>{verdict.label}</Stamp>}
      </button>
      {open && (
        <div className="pb-4 pt-1">
          {report !== null && (isMockReport(report) ? <MockReport report={report} /> : <StructuredJson value={report} />)}
          {report === null && <Button size="sm" onClick={() => suggest('接着练这场模拟面试', { surface: SURFACE, refs: { mock_interview_id: mock.id } })}>接着练</Button>}
        </div>
      )}
    </li>
  );
}

function Mocks({ mocks, target, onStart, onStory }: { mocks: MockInterview[]; target: PrepTarget | null; onStart: (round: string) => void; onStory: () => void }) {
  // 换一场准备时轮次跟着那场走；手动选过就听他的
  const [picked, setPicked] = useState<{ target: string | undefined; round: string } | null>(null);
  const round = picked && picked.target === target?.key ? picked.round : target?.round ?? 'first';
  return (
    <Station n={3} title="模拟一场" actions={<Button size="sm" variant="ghost" onClick={onStory}>讲一遍项目</Button>}>
      <div className="flex items-center gap-2">
        <div className="w-24"><Select ariaLabel="轮次" value={round} onChange={value => setPicked({ target: target?.key, round: value })} options={ROUND_OPTIONS} /></div>
        <Button onClick={() => onStart(round)}>开始模拟</Button>
      </div>
      {mocks.length > 0 && <ul className="divide-y divide-[var(--line)]">{mocks.map(mock => <MockRow key={mock.id} mock={mock} />)}</ul>}
    </Station>
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
    <div className="space-y-8">
      <Ticket targets={targets} target={target} onChange={setKey} onPrepare={() => send(`帮我准备${company ? `${company}的` : ''}面试`)} />
      <div className="grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-3">
        <Predictions predictions={data.predictions} onPredict={() => send(`预测一下${company}面试会深挖我简历哪里`)} />
        <Questions questions={pickQuestions(data.questions, target)} onGenerate={() => send(`按${target?.label ?? '我投的岗位'}出一组面试题`)} onOpenBank={onOpenBank} />
        <Mocks
          mocks={data.mocks} target={target}
          onStart={round => send(`开始模拟${company}${INTERVIEW_ROUND_LABELS[round] ?? '面试'}，先从高风险的深挖点问起`, { round })}
          onStory={() => send('我想练一下讲项目，听完按结构、时长和数据可信度帮我打分')}
        />
      </div>
    </div>
  );
}
