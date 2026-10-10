/**
 * 面试：面试记录（结果 + 来源徽标）、详情（transcript / 标签 / 复盘）、新建记录、模拟面试历史、深挖点预测。
 */
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { careerApi, safeJson } from '@/components/career/careerApi';
import {
  INTERVIEW_RESULT_LABELS, INTERVIEW_RESULT_SOURCE_LABELS, INTERVIEW_ROUND_LABELS, MOCK_MODE_LABELS,
} from '@/components/career/careerConstants';
import { QuestionBankPanel } from '@/components/career/QuestionBankPanel';
import {
  Badge, Button, CareerPage, Card, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, Select, StructuredJson, TextArea, TextInput,
  formatDate, textOrUnknown,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type { Interview, MockInterview, ProbePrediction } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

interface InterviewData { interviews: Interview[]; mocks: MockInterview[]; predictions: ProbePrediction[] }

async function loadAll(): Promise<InterviewData> {
  const [interviews, mocks, predictions] = await Promise.all([
    careerApi.interviews(), careerApi.mockInterviews().catch(() => [] as MockInterview[]), careerApi.probePredictions(),
  ]);
  return { interviews, mocks, predictions };
}

const RESULT_TONE: Record<string, BadgeTone> = { none: 'neutral', rejected: 'error', advanced: 'success', no_feedback_inferred: 'warning' };
const SOURCE_TONE: Record<string, BadgeTone> = { none: 'neutral', official: 'success', inferred: 'warning' };
const ROUND_OPTIONS = Object.entries(INTERVIEW_ROUND_LABELS).map(([value, label]) => ({ value, label }));
const RESULT_OPTIONS = Object.entries(INTERVIEW_RESULT_LABELS).map(([value, label]) => ({ value, label }));
const SOURCE_OPTIONS = Object.entries(INTERVIEW_RESULT_SOURCE_LABELS).map(([value, label]) => ({ value, label }));

export default function CareerInterview({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(loadAll, ['interview', 'mock_interview', 'probe_prediction']);
  const interviews = useMemo(() => [...(query.data?.interviews ?? [])].sort((a, b) => ((b.date ?? b.created_at) > (a.date ?? a.created_at) ? 1 : -1)), [query.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const selected = interviews.find(i => i.id === selectedId) ?? interviews[0] ?? null;
  const activeId = selected?.id ?? null;

  return (
    <CareerPage
      embedded={embedded}
      title="面试"
      actions={<Button onClick={() => setShowForm(v => !v)}><Plus className="h-3.5 w-3.5" />新建记录</Button>}
    >
      <div className="space-y-10 px-6 py-6">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {showForm && <InterviewForm onDone={() => { setShowForm(false); query.reload(); }} onCancel={() => setShowForm(false)} />}
        {query.loading && !query.data && <LoadingRow />}
        {query.data && (
          <>
            <section>
              <SectionTitle>面试记录（{interviews.length}）</SectionTitle>
              {interviews.length === 0 && <EmptyState title="还没有面试记录" hint="记录每一轮的过程和结果，复盘和预测才有依据。没有反馈的会标为「无反馈（推测）」。" example="帮我记录刚才的面试" />}
              {interviews.length > 0 && (
                <div className="grid grid-cols-1 gap-8 md:grid-cols-[300px_1fr]">
                  <ul>
                    {interviews.map(iv => (
                      <li key={iv.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(iv.id)}
                          aria-current={iv.id === activeId ? 'true' : undefined}
                          className={`relative w-full rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${iv.id === activeId ? 'bg-[var(--selected)] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-[var(--primary)]' : 'hover:bg-[var(--hover)]'}`}
                        >
                          <div className="truncate text-sm font-medium text-[var(--ink)]">{textOrUnknown(iv.company_name)} · {textOrUnknown(iv.title)}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--muted)]">
                            <span>{INTERVIEW_ROUND_LABELS[iv.round] ?? iv.round}</span>
                            <span>· {formatDate(iv.date)}</span>
                            <Badge tone={RESULT_TONE[iv.result] ?? 'neutral'}>{INTERVIEW_RESULT_LABELS[iv.result] ?? iv.result}</Badge>
                            <span title="结果来源">{INTERVIEW_RESULT_SOURCE_LABELS[iv.result_source] ?? iv.result_source}</span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {selected && <InterviewDetail key={selected.id} interview={selected} />}
                </div>
              )}
            </section>
            <QuestionBankPanel />
            <MockSection mocks={query.data.mocks} />
            <PredictionSection predictions={query.data.predictions} />
          </>
        )}
      </div>
    </CareerPage>
  );
}

function InterviewDetail({ interview }: { interview: Interview }) {
  const tags = safeJson<unknown[]>(interview.tags_json, []);
  const retro = safeJson<unknown>(interview.retro_json, null);
  return (
    <div className="space-y-3">
      <Card title={`${textOrUnknown(interview.company_name)} · ${textOrUnknown(interview.title)}`}>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
          <span>{INTERVIEW_ROUND_LABELS[interview.round] ?? interview.round}</span>
          <span>· {formatDate(interview.date)}</span>
          {interview.interviewer_role_guess && <span>· 面试官可能是：{interview.interviewer_role_guess}</span>}
          <Badge tone={RESULT_TONE[interview.result] ?? 'neutral'}>{INTERVIEW_RESULT_LABELS[interview.result] ?? interview.result}</Badge>
          <Badge tone={SOURCE_TONE[interview.result_source] ?? 'neutral'}>来源：{INTERVIEW_RESULT_SOURCE_LABELS[interview.result_source] ?? interview.result_source}</Badge>
        </div>
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((t, i) => <Badge key={i}>{typeof t === 'string' ? t : JSON.stringify(t)}</Badge>)}
          </div>
        )}
      </Card>
      <Card title="过程记录">
        {interview.transcript
          ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-[var(--font-sans)] text-sm text-[var(--ink)]">{interview.transcript}</pre>
          : <div className="text-xs text-[var(--subtle)]">暂无记录。在对话里说「帮我记录这场面试的过程」。</div>}
      </Card>
      <Card title="复盘">
        {retro ? <StructuredJson value={retro} /> : <div className="text-xs text-[var(--subtle)]">还没有复盘。在对话里说「帮我复盘这场面试」。</div>}
      </Card>
    </div>
  );
}

function InterviewForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const action = useCareerAction();
  const [form, setForm] = useState({ company_name: '', title: '', round: 'first', date: '', result: 'none', result_source: 'none', transcript: '', tags: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = () => action.run(async () => {
    if (!form.company_name.trim()) throw new Error('请填写公司');
    await careerApi.createInterview({
      company_name: form.company_name.trim(), title: form.title || null, round: form.round, date: form.date || null,
      result: form.result, result_source: form.result_source, transcript: form.transcript || null,
      tags_json: JSON.stringify(form.tags.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)),
    });
    onDone();
  });
  return (
    <Card title="新建面试记录">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="公司"><TextInput value={form.company_name} onChange={set('company_name')} /></Field>
        <Field label="岗位"><TextInput value={form.title} onChange={set('title')} /></Field>
        <Field label="轮次"><Select value={form.round} onChange={v => setForm(f => ({ ...f, round: v }))} options={ROUND_OPTIONS} /></Field>
        <Field label="日期"><TextInput type="date" value={form.date} onChange={set('date')} /></Field>
        <Field label="结果"><Select value={form.result} onChange={v => setForm(f => ({ ...f, result: v }))} options={RESULT_OPTIONS} /></Field>
        <Field label="结果来源"><Select value={form.result_source} onChange={v => setForm(f => ({ ...f, result_source: v }))} options={SOURCE_OPTIONS} /></Field>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2">
        <Field label="标签（逗号分隔）"><TextInput value={form.tags} onChange={set('tags')} /></Field>
        <Field label="过程记录"><TextArea value={form.transcript} onChange={set('transcript')} /></Field>
      </div>
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>保存</Button>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </Card>
  );
}

function MockSection({ mocks }: { mocks: MockInterview[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <section>
      <SectionTitle>模拟面试（{mocks.length}）</SectionTitle>
      {mocks.length === 0 && <div className="text-xs text-[var(--subtle)]">还没有模拟面试。在对话里说「帮我模拟一场深挖追问」。</div>}
      <div className="space-y-2">
        {mocks.map(m => {
          const turns = safeJson<unknown[]>(m.turns_json, []);
          const report = safeJson<unknown>(m.report_json, null);
          const open = openId === m.id;
          return (
            <Card key={m.id} title={`${MOCK_MODE_LABELS[m.mode] ?? m.mode}${m.round ? ` · ${INTERVIEW_ROUND_LABELS[m.round] ?? m.round}` : ''}`}
              extra={(
                <>
                  <span className="text-xs text-[var(--subtle)]">{formatDate(m.created_at)} · {turns.length} 轮</span>
                  <Button variant="ghost" onClick={() => setOpenId(open ? null : m.id)}>{open ? '收起' : '查看报告'}</Button>
                </>
              )}>
              {m.company_type && <div className="text-xs text-[var(--muted)]">公司类型：{m.company_type}</div>}
              {open && (
                <div className="mt-2 border-l-2 border-[var(--line-2)] pl-3 text-sm">
                  {report ? <StructuredJson value={report} /> : <span className="text-xs text-[var(--subtle)]">暂无报告</span>}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

const RISK_TONE: Record<string, BadgeTone> = { high: 'error', mid: 'warning', low: 'success' };
const TARGET_LABELS: Record<string, string> = { data: '数据', project: '项目', industry: '行业', method: '方法' };

function PredictionSection({ predictions }: { predictions: ProbePrediction[] }) {
  return (
    <section>
      <SectionTitle>深挖点预测（{predictions.length}）</SectionTitle>
      {predictions.length === 0 && <div className="text-xs text-[var(--subtle)]">还没有预测。在对话里说「帮我预测这版简历会被追问的点」。</div>}
      <ul className="divide-y divide-[var(--line)]">
        {predictions.map(p => {
          const chain = safeJson<unknown[]>(p.expected_chain_json, []);
          return (
            <li key={p.id} className="py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={RISK_TONE[p.risk] ?? 'neutral'}>风险 {p.risk}</Badge>
                <Badge>{TARGET_LABELS[p.target_type] ?? p.target_type}</Badge>
                <span className="text-sm text-[var(--ink)]">{p.statement}</span>
              </div>
              {chain.length > 0 && (
                <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-[var(--muted)]">
                  {chain.map((c, i) => <li key={i}>{typeof c === 'string' ? c : JSON.stringify(c)}</li>)}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
