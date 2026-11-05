/**
 * 面后复盘（interview-retro）的成果：这一轮在看什么、问了什么卡在哪、下一轮可能接着问、重答一遍、回去要补的。
 * 证据和推断分开写（技能约束）：事实一行，「也可能是」另起一句。旧数据不是这个结构：调用方先用 isRetro 判断，认不出就退回通用展示。
 */
import { dict, dicts, num, pickText, texts, type Dict } from '../read';

import { Block, Bullets } from './parts';

function Questions({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block label="问了什么、卡在哪">
      <ul className="space-y-3">
        {items.map((item, index) => {
          const layer = num(item.stuck_layer);
          const doubt = dict(item.interviewer_doubt);
          return (
            <li key={`${index}:${pickText(item, 'quote')}`} className="text-sm leading-relaxed">
              <div className="text-[var(--ink)]">{pickText(item, 'quote', 'question')}</div>
              {pickText(item, 'intent') && <div className="text-[var(--muted)]">想看的是：{pickText(item, 'intent')}</div>}
              {layer !== null && layer > 0 && <div className="text-[var(--ink-2)]">追到第 {layer} 层卡住{pickText(doubt, 'evidence') ? `：${pickText(doubt, 'evidence')}` : ''}</div>}
              {pickText(doubt, 'alternative') && <div className="text-[var(--muted)]">也可能是：{pickText(doubt, 'alternative')}</div>}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function Retakes({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block label="重答一遍">
      <ul className="space-y-3">
        {items.map((item, index) => {
          const verify = texts(item.needs_verification);
          return (
            <li key={`${index}:${pickText(item, 'question')}`} className="text-sm leading-relaxed">
              <div className="text-[var(--muted)]">{pickText(item, 'question')}</div>
              <div className="text-[var(--ink)]">{pickText(item, 'answer')}</div>
              {verify.length > 0 && <div className="text-[var(--warning)]">先核实：{verify.join('；')}</div>}
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
    <div className="space-y-4">
      {focus && <Block label="这一轮在看什么"><p className="text-sm leading-relaxed text-[var(--ink)]">{focus}</p></Block>}
      <Questions items={dicts(data.questions)} />
      <Bullets label="下一轮可能接着问" items={texts(data.next_round_probes)} />
      <Retakes items={dicts(data.retakes)} />
      <Bullets label="要补的事实" items={texts(todo.facts)} />
      <Bullets label="表达上要改的" items={texts(todo.delivery)} />
      <Bullets label="现场的信号" items={dicts(data.signals).map(signalLine).filter((line): line is string => line !== null)} />
    </div>
  );
}
