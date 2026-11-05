/**
 * 面后复盘（interview-retro）的成果。他要看见的是：每道题被追到第几层卡住、下一轮会接着问什么、
 * 这道题重答该怎么说、回去要补什么。
 * 两层（见 skills/layers.tsx）：上面一句「这一轮在看什么」（前面一只眼睛），下面一排块，块上是点阵——
 * 一道题一颗（卡住的红、过了的绿）、要补的是空方框——点哪块看哪项。
 * 每道题一张追问卡（ProbeCard）：轨道上的红叉是卡住的那一站，同一道题的重答是贴在卡里的便签。
 * 证据和推断分开（技能约束）：看到的事实是正文，「也可能是」是虚线气泡，不靠「也可能是：」这几个字区分。
 * 旧数据不是这个结构：调用方先用 isRetro 判断，认不出就退回通用展示。
 */
import { Eye } from 'lucide-react';

import { dict, dicts, num, pickText, texts, type Dict } from '../read';
import { TileTabs, type TileTab } from '../layers';
import { Marks, type Tone } from '../visual';

import { TodoItems } from './MockReport';
import { AnswerNote, ProbeCard } from './ProbeCard';

/** 每道题一张追问卡；同一道题的重答贴在卡的下半张。 */
function Questions({ items, retakes }: { items: Dict[]; retakes: Dict[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {items.map((item, index) => {
        const quote = pickText(item, 'quote', 'question');
        const doubt = dict(item.interviewer_doubt);
        return (
          <ProbeCard
            key={`${index}:${quote}`} claim={quote} stuck={num(item.stuck_layer) ?? 0}
            issue={pickText(doubt, 'evidence')} alternative={pickText(doubt, 'alternative')}
            answer={quote ? retakes.find(retake => pickText(retake, 'question') === quote) : undefined}
          />
        );
      })}
    </ul>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item, index) => <li key={`${index}:${item}`} className="rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-3 py-1 text-sm text-[var(--ink-2)]">{item}</li>)}
    </ul>
  );
}

function Retakes({ items }: { items: Dict[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => <li key={`${index}:${pickText(item, 'question')}`}><AnswerNote answer={item} question={pickText(item, 'question')} /></li>)}
    </ul>
  );
}

/** 现场信号：看到的事实是实线气泡，「也可能是」是它下面的虚线气泡。推断和事实用形状分开，不写「也可能」。 */
function Signals({ items }: { items: Dict[] }) {
  return (
    <ul className="space-y-3 text-sm leading-relaxed">
      {items.map((signal, index) => (
        <li key={`${index}:${pickText(signal, 'fact')}`} className="space-y-1">
          <div className="text-[var(--ink)]">{pickText(signal, 'fact')}</div>
          <div className="flex flex-wrap gap-2">
            {pickText(signal, 'interpretation') && <span className="rounded-lg rounded-tl-sm bg-[var(--inset)] px-2.5 py-1 text-[var(--ink-2)]">{pickText(signal, 'interpretation')}</span>}
            {pickText(signal, 'alternative') && <span className="rounded-lg rounded-tl-sm border border-dashed border-[var(--line-2)] px-2.5 py-1 text-[var(--muted)]" aria-label={`也可能是：${pickText(signal, 'alternative')}`}>{pickText(signal, 'alternative')}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 这份复盘里有没有技能约定的那几块。 */
export function isRetro(retro: unknown): boolean {
  const data = dict(retro);
  return ['focus_this_round', 'questions', 'next_round_probes', 'retakes', 'todo', 'signals'].some(key => data[key] != null);
}

const repeat = (count: number, tone: Tone | null): Array<Tone | null> => Array.from({ length: count }, () => tone);

export function RetroView({ retro }: { retro: unknown }) {
  const data = dict(retro);
  const todo = dict(data.todo);
  const focus = pickText(data, 'focus_this_round');
  const questions = dicts(data.questions);
  const stuck = questions.filter(item => (num(item.stuck_layer) ?? 0) > 0).length;
  const probes = texts(data.next_round_probes);
  const asked = new Set(questions.map(item => pickText(item, 'quote', 'question')).filter(Boolean));
  const retakes = dicts(data.retakes);
  // 对得上题的重答已经贴在那道题的卡里，这里只剩没对上的
  const looseRetakes = retakes.filter(item => !asked.has(pickText(item, 'question')));
  const todos = [...texts(todo.facts), ...texts(todo.delivery)];
  const signals = dicts(data.signals).filter(signal => pickText(signal, 'fact'));
  // 块上是点阵：一道题一颗（卡住的红、过了的绿）、下一轮会问的一颗蓝、重答一颗黄、要补的是空方框、信号是灰圆点
  const all: Array<TileTab & { present: boolean }> = [
    {
      id: 'stuck', label: '卡住', summary: `${stuck} 处`, present: questions.length > 0,
      value: <Marks marks={questions.map(item => ((num(item.stuck_layer) ?? 0) > 0 ? 'danger' : 'success'))} label={`问了 ${questions.length} 道，卡住 ${stuck} 处`} />,
      body: <Questions items={questions} retakes={retakes} />,
    },
    { id: 'next', label: '下一轮会问', summary: `${probes.length} 个`, present: probes.length > 0, value: <Marks marks={repeat(probes.length, 'info')} label={`${probes.length} 个`} />, body: <Chips items={probes} /> },
    { id: 'retake', label: '重答', summary: `${looseRetakes.length} 道`, present: looseRetakes.length > 0, value: <Marks marks={repeat(looseRetakes.length, 'warning')} label={`${looseRetakes.length} 道`} />, body: <Retakes items={looseRetakes} /> },
    { id: 'todo', label: '回去要补', summary: `${todos.length} 件`, present: todos.length > 0, value: <Marks marks={repeat(todos.length, null)} label={`${todos.length} 件`} />, body: <TodoItems items={todos} /> },
    { id: 'signals', label: '现场信号', summary: `${signals.length} 个`, present: signals.length > 0, value: <Marks shape="ring" marks={repeat(signals.length, 'neutral')} label={`${signals.length} 个`} />, body: <Signals items={signals} /> },
  ];
  return (
    <div className="space-y-5">
      {focus && (
        <p className="flex items-start gap-2.5 font-human text-lg font-semibold leading-relaxed text-[var(--ink)]">
          <Eye className="mt-1.5 h-5 w-5 shrink-0 text-[var(--primary)]" role="img" aria-label="这一轮在看" />
          {focus}
        </p>
      )}
      <TileTabs label="复盘分项" tabs={all.filter(tab => tab.present).map(({ present: _present, ...tab }) => tab)} />
    </div>
  );
}
