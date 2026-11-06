/**
 * 面试助力 ·「复盘」：上面一排日期块选一场；下面先是输入（把录音拖进来，或说几句），
 * 复盘出来后是两栏：左边总结和提问逻辑，右边一问一答（见 skills/results/RetroView.tsx）。不绕到对话。
 * 电话约的面试邮箱里没有记录，所以留着「我约了一场面试」和「补记一场」两个入口。
 */
import { useState } from 'react';

import { track } from '@/analytics';
import { pageSurfaceId } from '@/features/career-shell/pageSurface';

import { BookInterviewForm } from '../BookInterviewForm';
import { careerApi, safeJson } from '../careerApi';
import { INTERVIEW_RESULT_LABELS, INTERVIEW_RESULT_SOURCE_LABELS, INTERVIEW_ROUND_LABELS } from '../careerConstants';
import { Button, Card, Field, Select, StructuredJson, TextArea, TextInput, textOrUnknown, useSuggestToChat } from '../CareerPrimitives';
import { InterviewRetroBox } from '../InterviewRetroBox';
import { RetroView, isRetro } from '../skills/results/RetroView';
import { SAMPLE_RETRO_INTERVIEW } from '../skills/samples/interview';
import { SampleFrame } from '../skills/samples/SampleFrame';
import { DateBlock, Stamp, toneColor, type Tone } from '../skills/visual';
import type { Interview } from '../types';
import { useCareerAction } from '../useCareerData';

/** 这一页发出去的话，回复结束后带他回到面试助力。 */
const SURFACE = pageSurfaceId({ kind: 'career-dossier', view: 'interview' });
const RESULT_STAMP: Record<string, Tone> = { rejected: 'danger', advanced: 'success', no_feedback_inferred: 'warning' };
const optionsOf = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }));
const ROUND_OPTIONS = optionsOf(INTERVIEW_ROUND_LABELS);
const RESULT_OPTIONS = optionsOf(INTERVIEW_RESULT_LABELS);
const SOURCE_OPTIONS = optionsOf(INTERVIEW_RESULT_SOURCE_LABELS);

const titleOf = (interview: Interview): string => `${textOrUnknown(interview.company_name)} · ${textOrUnknown(interview.title)}`;
const roundOf = (interview: Interview): string => INTERVIEW_ROUND_LABELS[interview.round] ?? interview.round;
/** 还没出结果的（没面，或者面了还没消息）不挂结果标签：一个「未知」帮不了他。 */
const hasResult = (interview: Interview): boolean => interview.result !== 'none';

/** 一排日期块：每场一块，选中的描墨线；结果只用一道底边颜色说。 */
function InterviewStrip({ interviews, activeId, onSelect }: { interviews: Interview[]; activeId: string | null; onSelect: (id: string) => void }) {
  return (
    <ul aria-label="面试" className="flex gap-2 overflow-x-auto pb-1">
      {interviews.map(interview => {
        const active = interview.id === activeId;
        const tone = hasResult(interview) ? RESULT_STAMP[interview.result] : undefined;
        return (
          <li key={interview.id} className="shrink-0">
            <button
              type="button" onClick={() => onSelect(interview.id)} aria-current={active ? 'true' : undefined}
              aria-label={`${titleOf(interview)} ${roundOf(interview)}`}
              className={`flex w-48 items-center gap-2 rounded-lg border-[1.5px] px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${active ? 'border-[var(--hard)] bg-[var(--paper)] shadow-hard' : 'border-transparent bg-[var(--inset)] hover:bg-[var(--hover)]'}`}
              style={tone ? { borderBottomColor: toneColor(tone), borderBottomWidth: 3 } : undefined}
            >
              <DateBlock iso={interview.date} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--ink)]">{textOrUnknown(interview.company_name)}</span>
                <span className="block truncate text-sm text-[var(--muted)]">{roundOf(interview)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function InterviewDetail({ interview }: { interview: Interview }) {
  const suggest = useSuggestToChat();
  const retro = safeJson<unknown>(interview.retro_json, null);
  const [adding, setAdding] = useState(false);
  // 按提问逻辑去练：把考察点交给小芽出题、找相近的面经；埋点记下他会不会这么用
  const practice = (points: string[]) => {
    track('career_retro_practice', { points: points.length });
    suggest(`按${textOrUnknown(interview.company_name)}这场面试的考察点（${points.join('、')}）出几道题考我，再找几篇相近的面经一起练`, {
      surface: SURFACE, refs: { interview_id: interview.id, application_id: interview.application_id ?? undefined },
    });
  };
  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="min-w-0 flex-1 truncate font-human text-2xl font-semibold text-[var(--ink)]">{titleOf(interview)}</h2>
        {hasResult(interview) && (
          <span title={INTERVIEW_RESULT_SOURCE_LABELS[interview.result_source] ?? interview.result_source}>
            <Stamp tone={RESULT_STAMP[interview.result] ?? 'neutral'} dashed={interview.result_source === 'inferred'}>{INTERVIEW_RESULT_LABELS[interview.result] ?? interview.result}</Stamp>
          </span>
        )}
      </header>
      {retro !== null && (isRetro(retro) ? <RetroView retro={retro} onPractice={practice} /> : <StructuredJson value={retro} />)}
      {/* 还没复盘的：先给输入（拖录音进来）；复盘过的收成一个「再补」 */}
      {retro === null || adding
        ? <div className="max-w-2xl"><InterviewRetroBox interview={interview} /></div>
        : <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setAdding(true)}>再补一段</Button>}
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

/** 还没有任何一场面试时：用示例那一场把复盘出来的样子摆出来。 */
function SampleRetro() {
  return (
    <SampleFrame>
      <InterviewStrip interviews={[SAMPLE_RETRO_INTERVIEW]} activeId={SAMPLE_RETRO_INTERVIEW.id} onSelect={() => undefined} />
      <InterviewDetail interview={SAMPLE_RETRO_INTERVIEW} />
    </SampleFrame>
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
      {interviews.length === 0 && <SampleRetro />}
      {selected && (
        <>
          <InterviewStrip interviews={interviews} activeId={selected.id} onSelect={setSelectedId} />
          <InterviewDetail key={selected.id} interview={selected} />
        </>
      )}
    </div>
  );
}
