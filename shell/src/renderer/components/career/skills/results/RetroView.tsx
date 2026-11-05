/**
 * 面后复盘（interview-retro）的成果，两栏（2026-11-05 用户定）：
 *   左栏 · 总结：这一轮在看什么（一只眼睛）→ 提问逻辑：面试官是从哪几个点问的、为什么、下次复习什么；
 *         点一个考察点，右栏只留这个点上的题；「按这些点练」把考察点交给小芽出题找面经 → 回去要补的 → 下一轮会问的。
 *   右栏 · 一问一答：面试官问（左边带人像的气泡）、他怎么答（右边的气泡）、答得好的（绿勾）、要补的（橙点），
 *         卡住的题一条追问轨道，重答是贴在下面的便签。
 * 文字只有问句、答句和评价本身；好坏用勾和点、深浅用轨道说，不写「优点」「不足」这类小标题。
 * 旧复盘没有 point / answer / good / lacking / logic：考察点退回题型，要补的退回面试官起疑的证据。
 * 调用方先用 isRetro 判断，认不出就退回通用展示。
 */
import { ArrowRight, BookOpen, Check, Eye, UserRound } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../../CareerPrimitives';
import { dict, dicts, num, pickText, texts, type Dict } from '../read';
import { DepthTrack, Marks, type Tone } from '../visual';

import { TodoItems } from './MockReport';
import { AnswerNote } from './ProbeCard';

/** 追问一般钻到五层左右，轨道至少画这么多站。 */
const USUAL_DEPTH = 5;

export interface RetroPoint { point: string; why: string | null; review: string | null }
interface RetroQuestion { item: Dict; point: string | null; quote: string | null }

const stuckOf = (item: Dict): number => num(item.stuck_layer) ?? 0;

/** 这道题考的是什么：技能新版写 point，旧版只有题型。 */
const pointOf = (item: Dict): string | null => pickText(item, 'point', 'type');

/** 提问逻辑：技能给了就用；旧复盘按每题的考察点归一下。 */
export function retroPoints(retro: unknown): RetroPoint[] {
  const data = dict(retro);
  const given = dicts(data.logic).map(entry => ({ point: pickText(entry, 'point') ?? '', why: pickText(entry, 'why'), review: pickText(entry, 'review') })).filter(entry => entry.point);
  if (given.length) return given;
  const seen = [...new Set(dicts(data.questions).map(pointOf).filter((point): point is string => !!point))];
  return seen.map(point => ({ point, why: null, review: null }));
}

function PointList({ points, questions, picked, onPick }: { points: RetroPoint[]; questions: RetroQuestion[]; picked: string | null; onPick: (point: string | null) => void }) {
  return (
    <ul aria-label="提问逻辑" className="space-y-1.5">
      {points.map(entry => {
        const hits = questions.filter(question => question.point === entry.point);
        const selected = picked === entry.point;
        return (
          <li key={entry.point}>
            <button
              type="button" aria-pressed={selected} onClick={() => onPick(selected ? null : entry.point)}
              className={`w-full rounded-lg border-[1.5px] p-3 text-left text-sm leading-relaxed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${selected ? 'border-[var(--hard)] bg-[var(--paper)] shadow-hard' : 'border-transparent bg-[var(--inset)] hover:bg-[var(--hover)]'}`}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 font-semibold text-[var(--ink)]">{entry.point}</span>
                {hits.length > 0 && <Marks marks={hits.map(hit => (stuckOf(hit.item) > 0 ? 'danger' : 'success') as Tone)} label={`问了 ${hits.length} 道，卡住 ${hits.filter(hit => stuckOf(hit.item) > 0).length} 道`} />}
              </span>
              {entry.why && <span className="mt-1 block text-[var(--ink-2)]">{entry.why}</span>}
              {entry.review && (
                <span className="mt-1 flex items-start gap-1.5 text-[var(--primary)]">
                  <BookOpen className="mt-1 h-3.5 w-3.5 shrink-0" role="img" aria-label="下次复习" />
                  {entry.review}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Verdicts({ items, tone }: { items: string[]; tone: 'good' | 'lacking' }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={tone === 'good' ? '答得好的' : '要补的'} className="space-y-1">
      {items.map((item, index) => (
        <li key={`${index}:${item}`} className="flex items-start gap-2 text-sm leading-relaxed text-[var(--ink-2)]">
          {tone === 'good'
            ? <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--success)]" aria-hidden />
            : <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--warning)]" aria-hidden />}
          {item}
        </li>
      ))}
    </ul>
  );
}

function Exchange({ question, retake }: { question: RetroQuestion; retake?: Dict }) {
  const { item } = question;
  const stuck = stuckOf(item);
  const answer = pickText(item, 'answer');
  const lacking = texts(item.lacking);
  const doubt = pickText(dict(item.interviewer_doubt), 'evidence');
  return (
    <li className="space-y-2.5 border-b border-[var(--line)] pb-5 last:border-b-0">
      <div className="flex items-start gap-2">
        <UserRound className="mt-1.5 h-4 w-4 shrink-0 text-[var(--muted)]" role="img" aria-label="面试官问" />
        <span className="min-w-0 rounded-lg rounded-tl-sm bg-[var(--inset)] px-3 py-1.5 text-sm leading-relaxed text-[var(--ink)]">{question.quote}</span>
      </div>
      {answer && (
        <div className="flex justify-end pl-10">
          <span role="note" aria-label="我答" className="min-w-0 rounded-lg rounded-tr-sm border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm leading-relaxed text-[var(--ink)]">{answer}</span>
        </div>
      )}
      {stuck > 0 && <DepthTrack total={Math.max(USUAL_DEPTH, stuck)} stuck={stuck} label={`追到第 ${stuck} 层卡住`} />}
      <Verdicts tone="good" items={texts(item.good)} />
      <Verdicts tone="lacking" items={lacking.length ? lacking : doubt ? [doubt] : []} />
      {retake && <AnswerNote answer={retake} />}
    </li>
  );
}

/** 这份复盘里有没有技能约定的那几块。 */
export function isRetro(retro: unknown): boolean {
  const data = dict(retro);
  return ['focus_this_round', 'questions', 'next_round_probes', 'retakes', 'todo', 'logic'].some(key => data[key] != null);
}

export function RetroView({ retro, onPractice }: { retro: unknown; onPractice?: (points: string[]) => void }) {
  const data = dict(retro);
  const [picked, setPicked] = useState<string | null>(null);
  const focus = pickText(data, 'focus_this_round');
  const questions: RetroQuestion[] = dicts(data.questions).map(item => ({ item, point: pointOf(item), quote: pickText(item, 'quote', 'question') }));
  const points = retroPoints(retro);
  const retakes = dicts(data.retakes);
  const todo = dict(data.todo);
  const todos = [...texts(todo.facts), ...texts(todo.delivery)];
  const probes = texts(data.next_round_probes);
  const shown = picked ? questions.filter(question => question.point === picked) : questions;
  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="min-w-0 space-y-5">
        {focus && (
          <p className="flex items-start gap-2.5 font-human text-lg font-semibold leading-relaxed text-[var(--ink)]">
            <Eye className="mt-1.5 h-5 w-5 shrink-0 text-[var(--primary)]" role="img" aria-label="这一轮在看" />
            {focus}
          </p>
        )}
        {points.length > 0 && <PointList points={points} questions={questions} picked={picked} onPick={setPicked} />}
        {onPractice && points.length > 0 && <Button variant="primary" onClick={() => onPractice(points.map(entry => entry.point))}>按这些点练</Button>}
        {todos.length > 0 && <div role="group" aria-label="回去要补"><TodoItems items={todos} /></div>}
        {probes.length > 0 && (
          <ul aria-label="下一轮会问" className="space-y-1.5">
            {probes.map(probe => (
              <li key={probe} className="flex items-start gap-2 text-sm leading-relaxed text-[var(--ink-2)]">
                <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--muted)]" aria-hidden />
                {probe}
              </li>
            ))}
          </ul>
        )}
      </aside>
      <ol aria-label="一问一答" className="min-w-0 space-y-5">
        {shown.map((question, index) => (
          <Exchange key={`${index}:${question.quote}`} question={question} retake={question.quote ? retakes.find(retake => pickText(retake, 'question') === question.quote) : undefined} />
        ))}
      </ol>
    </div>
  );
}
