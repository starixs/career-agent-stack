/**
 * 面试助力 ·「复盘」：每一场真实面试的记录和复盘。左边选一场，右边看过程和复盘；
 * 面完了说几句或传一段录音，就在这一页复盘（面后复盘技能），不绕到对话。
 * 电话约的面试邮箱里没有记录，所以留着「我约了一场面试」和「补记一场」两个入口。
 */
import { UserRound } from 'lucide-react';
import { useState } from 'react';

import { BookInterviewForm } from '../BookInterviewForm';
import { careerApi, safeJson } from '../careerApi';
import { INTERVIEW_RESULT_LABELS, INTERVIEW_RESULT_SOURCE_LABELS, INTERVIEW_ROUND_LABELS } from '../careerConstants';
import { Badge, Button, Card, Field, Select, StructuredJson, TextArea, TextInput, formatDate, textOrUnknown, type BadgeTone } from '../CareerPrimitives';
import { InterviewRetroBox } from '../InterviewRetroBox';
import { RetroView, isRetro } from '../skills/results/RetroView';
import { DateBlock, Stamp, type Tone } from '../skills/visual';
import type { Interview } from '../types';
import { useCareerAction } from '../useCareerData';

const RESULT_TONE: Record<string, BadgeTone> = { none: 'neutral', rejected: 'error', advanced: 'success', no_feedback_inferred: 'warning' };
const RESULT_STAMP: Record<string, Tone> = { rejected: 'danger', advanced: 'success', no_feedback_inferred: 'warning' };
const optionsOf = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }));
const ROUND_OPTIONS = optionsOf(INTERVIEW_ROUND_LABELS);
const RESULT_OPTIONS = optionsOf(INTERVIEW_RESULT_LABELS);
const SOURCE_OPTIONS = optionsOf(INTERVIEW_RESULT_SOURCE_LABELS);

const titleOf = (interview: Interview): string => `${textOrUnknown(interview.company_name)} · ${textOrUnknown(interview.title)}`;
const roundOf = (interview: Interview): string => INTERVIEW_ROUND_LABELS[interview.round] ?? interview.round;
/** 还没出结果的（没面，或者面了还没消息）不挂结果标签：一个「未知」帮不了他。 */
const hasResult = (interview: Interview): boolean => interview.result !== 'none';

function InterviewList({ interviews, activeId, onSelect }: { interviews: Interview[]; activeId: string | null; onSelect: (id: string) => void }) {
  return (
    <ul>
      {interviews.map(interview => (
        <li key={interview.id}>
          <button
            type="button" onClick={() => onSelect(interview.id)} aria-current={interview.id === activeId ? 'true' : undefined}
            className={`relative w-full rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${interview.id === activeId ? 'bg-[var(--selected)] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-[var(--primary)]' : 'hover:bg-[var(--hover)]'}`}
          >
            <span className="flex items-center gap-3">
              <DateBlock iso={interview.date} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--ink)]">{titleOf(interview)}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--muted)]">
                  <span>{roundOf(interview)}</span>
                  {hasResult(interview) && <Badge tone={RESULT_TONE[interview.result] ?? 'neutral'}>{INTERVIEW_RESULT_LABELS[interview.result] ?? interview.result}</Badge>}
                </span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function InterviewDetail({ interview }: { interview: Interview }) {
  const tags = safeJson<unknown[]>(interview.tags_json, []);
  const retro = safeJson<unknown>(interview.retro_json, null);
  const [adding, setAdding] = useState(false);
  return (
    <div className="min-w-0 max-w-3xl space-y-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-human text-2xl font-semibold text-[var(--ink)]">{titleOf(interview)}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="rounded-full bg-[var(--inset)] px-2 py-0.5 text-[var(--ink-2)]">{roundOf(interview)}</span>
            <span className="tabular-nums">{formatDate(interview.date)}</span>
            {interview.interviewer_role_guess && (
              <span className="inline-flex items-center gap-1">
                <UserRound className="h-3.5 w-3.5" role="img" aria-label="面试官可能是" />
                {interview.interviewer_role_guess}
              </span>
            )}
            {tags.map((tag, index) => <span key={index} className="rounded-full border border-[var(--line-2)] px-2 py-0.5">{typeof tag === 'string' ? tag : JSON.stringify(tag)}</span>)}
          </div>
        </div>
        {hasResult(interview) && (
          <span title={INTERVIEW_RESULT_SOURCE_LABELS[interview.result_source] ?? interview.result_source}>
            <Stamp tone={RESULT_STAMP[interview.result] ?? 'neutral'} dashed={interview.result_source === 'inferred'}>{INTERVIEW_RESULT_LABELS[interview.result] ?? interview.result}</Stamp>
          </span>
        )}
      </header>
      {interview.transcript && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-l-2 border-[var(--line-2)] pl-3 font-[var(--font-sans)] text-sm leading-relaxed text-[var(--ink-2)]" aria-label="过程记录">{interview.transcript}</pre>
      )}
      {retro !== null && (isRetro(retro) ? <RetroView retro={retro} /> : <StructuredJson value={retro} />)}
      {/* 已经复盘过的：输入框先收着，要补再点开；还没复盘的直接摆出来 */}
      {retro === null || adding
        ? <InterviewRetroBox interview={interview} />
        : <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setAdding(true)}>再补几句</Button>}
    </div>
  );
}

function InterviewForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const action = useCareerAction();
  const [form, setForm] = useState({ company_name: '', title: '', round: 'first', date: '', result: 'none', result_source: 'none', transcript: '', tags: '' });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }));
  const pick = (key: keyof typeof form) => (value: string) => setForm(current => ({ ...current, [key]: value }));
  const submit = () => action.run(async () => {
    if (!form.company_name.trim()) throw new Error('请填写公司');
    await careerApi.createInterview({
      company_name: form.company_name.trim(), title: form.title || null, round: form.round, date: form.date || null,
      result: form.result, result_source: form.result_source, transcript: form.transcript || null,
      tags_json: JSON.stringify(form.tags.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean)),
    });
    onDone();
  });
  return (
    <Card title="补记一场面试" variant="approval">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="公司"><TextInput value={form.company_name} onChange={set('company_name')} /></Field>
        <Field label="岗位"><TextInput value={form.title} onChange={set('title')} /></Field>
        <Field label="轮次"><Select ariaLabel="轮次" value={form.round} onChange={pick('round')} options={ROUND_OPTIONS} /></Field>
        <Field label="日期"><TextInput type="date" value={form.date} onChange={set('date')} /></Field>
        <Field label="结果"><Select ariaLabel="结果" value={form.result} onChange={pick('result')} options={RESULT_OPTIONS} /></Field>
        <Field label="结果来源"><Select ariaLabel="结果来源" value={form.result_source} onChange={pick('result_source')} options={SOURCE_OPTIONS} /></Field>
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

export function RetroTab({ interviews, onChanged }: { interviews: Interview[]; onChanged: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<'book' | 'record' | null>(null);
  const selected = interviews.find(interview => interview.id === selectedId) ?? interviews[0] ?? null;
  const done = () => { setForm(null); onChanged(); };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setForm(current => (current === 'book' ? null : 'book'))}>我约了一场面试</Button>
        <Button variant="ghost" onClick={() => setForm(current => (current === 'record' ? null : 'record'))}>补记一场</Button>
      </div>
      {form === 'book' && <BookInterviewForm onDone={done} onCancel={() => setForm(null)} />}
      {form === 'record' && <InterviewForm onDone={done} onCancel={() => setForm(null)} />}
      {interviews.length === 0 && <p className="py-10 text-center text-sm text-[var(--muted)]">还没有面试记录</p>}
      {selected && (
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[280px_minmax(0,1fr)]">
          <InterviewList interviews={interviews} activeId={selected.id} onSelect={setSelectedId} />
          <InterviewDetail key={selected.id} interview={selected} />
        </div>
      )}
    </div>
  );
}
