/**
 * 面试助力 ·「准备」。他用到这页时是收到了面试通知、心里没底，最想知道的是：我准备到哪了、最可能在哪出事。
 * 两层（见 skills/layers.tsx）：
 *   第一层：一张「面试票」——哪一场、哪天、还有几天、「帮我准备这一场」（这页唯一的实心按钮）；
 *           票下面三块是准备的三步，块上各一个小图形：① 一条预测一颗按风险上色的方块 ② 一道题一颗圆点（练没练、过没过）③ 上次模拟的那枚章。
 *   第二层：点哪一步，下面摊开哪一步的细节。要读的文字只有简历里的那句话和面试官会问的问题；
 *           风险、深度、练没练都用颜色和图形说，不写「高风险」「练过 2 道」这类字，也不放图例。
 * 每个动作都带着这场面试的 id 发进对话，不用打字。
 */
import { useState, type ReactNode } from 'react';

import { pageSurfaceId } from '@/features/career-shell/pageSurface';

import { safeJson } from '../careerApi';
import { INTERVIEW_ROUND_LABELS, MOCK_MODE_LABELS } from '../careerConstants';
import { Button, Select, StructuredJson, formatDate, useSuggestToChat } from '../CareerPrimitives';
import { TileTabs, type TileTab } from '../skills/layers';
import { MockReport, isMockReport, mockVerdict } from '../skills/results/MockReport';
import { PredictionList, riskOf, sortByRisk } from '../skills/results/PredictionList';
import { SAMPLE_PREP } from '../skills/samples/interview';
import { SampleFrame } from '../skills/samples/SampleFrame';
import { DateBlock, Marks, PASS_SCORE, ScoreRing, Stamp, daysUntil, type Tone } from '../skills/visual';
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
/** 离面试不到这么多天，「还有几天」用提醒色。 */
const SOON_DAYS = 3;
const ROUND_OPTIONS = (['first', 'second', 'final', 'hr'] as const).map(value => ({ value, label: INTERVIEW_ROUND_LABELS[value] }));
const ROW = 'flex w-full items-center gap-3 -mx-2 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]';

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

/** 一步的细节：最上面是这一步的主动作（有才放），中间是条目，最下面一行是它的次要动作。 */
function Panel({ top, actions, children }: { top?: ReactNode; actions: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-4">
      {top}
      {children}
      <div className="-ml-3 flex items-center gap-1">{actions}</div>
    </div>
  );
}

function Predictions({ predictions, onPredict, onPractice }: { predictions: ProbePrediction[]; onPredict: () => void; onPractice: (prediction: ProbePrediction) => void }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = sortByRisk(predictions);
  return (
    <Panel
      actions={(
        <>
          {sorted.length > TOP_PREDICTIONS && <Button size="sm" variant="ghost" onClick={() => setShowAll(value => !value)}>{showAll ? '只看最要紧的' : `看全部 ${sorted.length} 条`}</Button>}
          <Button size="sm" variant="ghost" onClick={onPredict}>{predictions.length ? '重新预测' : '预测追问'}</Button>
        </>
      )}
    >
      {sorted.length > 0 && <PredictionList predictions={showAll ? sorted : sorted.slice(0, TOP_PREDICTIONS)} onPractice={onPractice} />}
    </Panel>
  );
}

/** 没练过的、分数低的排前面。 */
function pickQuestions(questions: QuestionItem[], target: PrepTarget | null): QuestionItem[] {
  const jobId = target?.refs.job_id;
  const mine = questions.filter(q => q.kind === 'interview' && ((jobId && q.job_id === jobId) || (!!target?.company && q.company_name === target.company)));
  const pool = mine.length ? mine : questions.filter(q => q.kind === 'interview');
  return [...pool].sort((a, b) => (a.last_attempt_score ?? -1) - (b.last_attempt_score ?? -1)).slice(0, TOP_QUESTIONS);
}

/** 先练几道：不让他一道道挑，一个「开始练」由小芽按这几道发题；下面的题只是给他看练到哪了。 */
function Questions({ questions, onStart, onGenerate, onOpenBank }: { questions: QuestionItem[]; onStart: () => void; onGenerate: () => void; onOpenBank: () => void }) {
  return (
    <Panel
      top={questions.length > 0 ? <Button onClick={onStart}>开始练</Button> : undefined}
      actions={<><Button size="sm" variant="ghost" onClick={onGenerate}>出一组题</Button><Button size="sm" variant="ghost" onClick={onOpenBank}>题库</Button></>}
    >
      {questions.length > 0 && (
        <ul aria-label="这一场的题" className="max-w-3xl divide-y divide-[var(--line)]">
          {questions.map(question => (
            <li key={question.id} className="flex items-center gap-3 py-2.5">
              <ScoreRing score={question.attempt_count ? question.last_attempt_score : null} />
              <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-relaxed text-[var(--ink)]">{question.content}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const verdictOf = (mock: MockInterview): { label: string; tone: Tone } | null => {
  const report = safeJson<unknown>(mock.report_json, null);
  return report === null ? { label: '没练完', tone: 'neutral' } : mockVerdict(report);
};

function MockRow({ mock }: { mock: MockInterview }) {
  const suggest = useSuggestToChat();
  const [open, setOpen] = useState(false);
  const turns = safeJson<unknown[]>(mock.turns_json, []);
  const report = safeJson<unknown>(mock.report_json, null);
  const verdict = verdictOf(mock);
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
    <Panel
      top={(
        <div className="flex items-center gap-2">
          <div className="w-24"><Select ariaLabel="轮次" value={round} onChange={value => setPicked({ target: target?.key, round: value })} options={ROUND_OPTIONS} /></div>
          <Button onClick={() => onStart(round)}>开始模拟</Button>
        </div>
      )}
      actions={<Button size="sm" variant="ghost" onClick={onStory}>讲一遍项目</Button>}
    >
      {mocks.length > 0 && <ul className="max-w-3xl divide-y divide-[var(--line)]">{mocks.map(mock => <MockRow key={mock.id} mock={mock} />)}</ul>}
    </Panel>
  );
}

/** 一道题练得怎样，给点阵用：没练过是空的，练过按过没过关上色。 */
const practiceTone = (question: QuestionItem): Tone | null => {
  if (!question.attempt_count || question.last_attempt_score === null) return null;
  return question.last_attempt_score < PASS_SCORE ? 'warning' : 'success';
};

/** 这一步还什么都没有：一颗空的。 */
const EMPTY_MARK: Array<Tone | null> = [null];

type Send = (text: string, extra?: Record<string, string | undefined>) => void;

/** 准备的三步：块上各一个小图形，点哪块下面摊开哪一步。 */
function PrepSteps({ data, target, send, onOpenBank }: { data: PrepData; target: PrepTarget | null; send: Send; onOpenBank: () => void }) {
  const company = target?.company ?? '';
  const risks = sortByRisk(data.predictions).map(riskOf);
  const highRisk = risks.filter(risk => risk.order === 0).length;
  const questions = pickQuestions(data.questions, target);
  const practiced = questions.filter(q => q.attempt_count > 0).length;
  // 模拟按这一场算：只看给这个岗位练的和没指定岗位的；换一场，章跟着换
  const jobId = target?.refs.job_id;
  const mocks = jobId ? data.mocks.filter(mock => mock.job_id === jobId || mock.job_id === null) : data.mocks;
  const lastVerdict = mocks[0] ? verdictOf(mocks[0]) : null;
  const steps: TileTab[] = [
    {
      id: 'predict', label: '会被问什么', summary: risks.length ? `高风险 ${highRisk} 条` : '还没预测',
      value: <Marks marks={risks.length ? risks.map(risk => risk.tone) : EMPTY_MARK} label={risks.length ? `${risks.length} 条预测，高风险 ${highRisk} 条` : '还没预测'} />,
      body: (
        <Predictions
          predictions={data.predictions}
          onPredict={() => send(`预测一下${company}面试会深挖我简历哪里`)}
          onPractice={prediction => send(`就简历里这句话深挖我：${prediction.statement}`, { prediction_id: prediction.id })}
        />
      ),
    },
    {
      id: 'practice', label: '先练几道', summary: questions.length ? `练过 ${practiced} 道，共 ${questions.length} 道` : '还没有题',
      value: <Marks shape="ring" marks={questions.length ? questions.map(practiceTone) : EMPTY_MARK} label={questions.length ? `${questions.length} 道题，练过 ${practiced} 道` : '还没有题'} />,
      body: (
        <Questions
          questions={questions} onOpenBank={onOpenBank}
          onStart={() => send(`用${company ? `${company}的` : '这几道'}面试题考我，先考没练过的和分数低的`)}
          onGenerate={() => send(`按${target?.label ?? '我投的岗位'}出一组面试题`)}
        />
      ),
    },
    {
      id: 'mock', label: '模拟一场', summary: lastVerdict ? `上次${lastVerdict.label}` : '还没练过',
      value: lastVerdict ? <Stamp tone={lastVerdict.tone}>{lastVerdict.label}</Stamp> : <Marks shape="ring" marks={EMPTY_MARK} label="还没练过" />,
      body: (
        <Mocks
          mocks={mocks} target={target}
          onStart={round => send(`开始模拟${company}${INTERVIEW_ROUND_LABELS[round] ?? '面试'}，先从高风险的深挖点问起`, { round })}
          onStory={() => send('我想练一下讲项目，听完按结构、时长和数据可信度帮我打分')}
        />
      ),
    },
  ];
  return <TileTabs label="准备的三步" tabs={steps} numbered />;
}

const noop = (): void => undefined;

/**
 * 还没准备过任何一场（没有预测、题、模拟）时的示例：三步按示例那一场摆满；
 * 他还没有可以准备的那一场时，连面试票也用示例的摆出来（上面那个「帮我准备面试」照常能点）。
 */
function SamplePrep({ withTicket, onOpenBank }: { withTicket: boolean; onOpenBank: () => void }) {
  const targets = buildPrepTargets(SAMPLE_PREP.interviews, SAMPLE_PREP.dossiers);
  const target = targets[0] ?? null;
  return (
    <SampleFrame>
      {withTicket && <Ticket targets={targets} target={target} onChange={noop} onPrepare={noop} />}
      <PrepSteps data={SAMPLE_PREP} target={target} send={noop} onOpenBank={onOpenBank} />
    </SampleFrame>
  );
}

const hasPrep = (data: PrepData): boolean => data.predictions.length > 0 || data.questions.length > 0 || data.mocks.length > 0;

export function PrepTab({ data, onOpenBank }: { data: PrepData; onOpenBank: () => void }) {
  const suggest = useSuggestToChat();
  const targets = buildPrepTargets(data.interviews, data.dossiers);
  const [key, setKey] = useState<string | null>(null);
  const target = targets.find(t => t.key === key) ?? targets[0] ?? null;
  const company = target?.company ?? '';
  const send: Send = (text, extra = {}) => suggest(text, { surface: SURFACE, refs: { ...target?.refs, ...extra } });

  return (
    <div className="max-w-5xl space-y-6">
      <Ticket targets={targets} target={target} onChange={setKey} onPrepare={() => send(`帮我准备${company ? `${company}的` : ''}面试`)} />
      {hasPrep(data)
        ? <PrepSteps data={data} target={target} send={send} onOpenBank={onOpenBank} />
        : <SamplePrep withTicket={!target} onOpenBank={onOpenBank} />}
    </div>
  );
}
