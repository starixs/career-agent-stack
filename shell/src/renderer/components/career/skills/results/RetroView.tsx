/**
 * 面后复盘（interview-retro）的成果。他要看见的是：每道题被追到第几层卡住、下一轮会接着问什么、
 * 这道题重答该怎么说、回去要补什么。
 *   每道题一排圆点，红的那颗是卡住的那一层；下一轮可能问的是一排小标签；重答是一张便签；要补的是待办方框。
 * 证据和推断分开（技能约束）：看到的事实一行，「也可能是」另起一行、用淡色。
 * 旧数据不是这个结构：调用方先用 isRetro 判断，认不出就退回通用展示。
 */
import { dict, dicts, num, pickText, texts, type Dict } from '../read';
import { Pips } from '../visual';

import { TodoList } from './MockReport';
import { Block } from './parts';

/** 追问一般钻到五层左右，圆点至少画这么多颗。 */
const USUAL_DEPTH = 5;

function Questions({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block level="section" label="问了什么、卡在哪">
      <ul className="divide-y divide-[var(--line)]">
        {items.map((item, index) => {
          const layer = num(item.stuck_layer) ?? 0;
          const doubt = dict(item.interviewer_doubt);
          return (
            <li key={`${index}:${pickText(item, 'quote')}`} className="py-2.5 text-sm leading-relaxed">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-[var(--ink)]">{pickText(item, 'quote', 'question')}</span>
                {layer > 0 && <Pips total={Math.max(USUAL_DEPTH, layer)} reached={layer - 1} stuck={layer} label={`追到第 ${layer} 层卡住`} />}
              </div>
              {pickText(doubt, 'evidence') && <div className="text-[var(--ink-2)]">{pickText(doubt, 'evidence')}</div>}
              {pickText(doubt, 'alternative') && <div className="text-[var(--muted)]">也可能是：{pickText(doubt, 'alternative')}</div>}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Block level="section" label={label}>
      <ul className="flex flex-wrap gap-2">
        {items.map((item, index) => <li key={`${index}:${item}`} className="rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-3 py-1 text-sm text-[var(--ink-2)]">{item}</li>)}
      </ul>
    </Block>
  );
}

function Retakes({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block level="section" label="重答一遍">
      <ul className="space-y-2">
        {items.map((item, index) => {
          const verify = texts(item.needs_verification);
          return (
            <li key={`${index}:${pickText(item, 'question')}`} className="rounded-md bg-[var(--note)] px-3 py-2 text-sm leading-relaxed">
              <div className="text-xs text-[var(--muted)]">{pickText(item, 'question')}</div>
              <div className="text-[var(--ink)]">{pickText(item, 'answer')}</div>
              {verify.length > 0 && <div className="mt-1 text-xs text-[var(--warning)]">先核实：{verify.join('；')}</div>}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

const signalLine = (signal: Dict): string | null => {
  const fact = pickText(signal, 'fact');
  if (!fact) return null;
  const reading = pickText(signal, 'interpretation');
  const other = pickText(signal, 'alternative');
  return `${fact}${reading ? `——${reading}` : ''}${other ? `（也可能：${other}）` : ''}`;
};

/** 这份复盘里有没有技能约定的那几块。 */
export function isRetro(retro: unknown): boolean {
  const data = dict(retro);
  return ['focus_this_round', 'questions', 'next_round_probes', 'retakes', 'todo', 'signals'].some(key => data[key] != null);
}

export function RetroView({ retro }: { retro: unknown }) {
  const data = dict(retro);
  const todo = dict(data.todo);
  const focus = pickText(data, 'focus_this_round');
  return (
    <div className="space-y-6">
      {focus && <p className="rounded-md bg-[var(--inset)] px-4 py-3 font-human text-base leading-relaxed text-[var(--ink)]">这一轮在看：{focus}</p>}
      <Questions items={dicts(data.questions)} />
      <Chips label="下一轮可能接着问" items={texts(data.next_round_probes)} />
      <Retakes items={dicts(data.retakes)} />
      <TodoList level="section" label="回去要补的" items={[...texts(todo.facts), ...texts(todo.delivery)]} />
      <Chips label="现场的信号" items={dicts(data.signals).map(signalLine).filter((line): line is string => line !== null)} />
    </div>
  );
}
