/**
 * 模拟面试（interview-probe）结束后的面试官视角复盘。他要看见的是：哪句话被追到第几层卡住了、
 * 面试官为什么起疑、下次可以怎么答、回去要做什么。
 *   卡在哪：每句话一排圆点，红的那颗是卡住的那一层；
 *   可以这样答：一张便签；回去要做的：一列待办方框。
 * 旧数据不是技能约定的结构：调用方先用 isMockReport 判断，认不出就退回通用展示。
 */
import { dict, dicts, num, pickText, texts, type Dict } from '../read';
import { Pips, type Tone } from '../visual';

import { Block } from './parts';

const VERDICTS: Record<string, { label: string; tone: Tone }> = {
  pass: { label: '过了', tone: 'success' },
  borderline: { label: '有点悬', tone: 'warning' },
  fail: { label: '没过', tone: 'danger' },
};

const FLAG_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'suspicious', label: '存疑' }, { key: 'inflated', label: '说大了' }, { key: 'scripted', label: '像背的' },
];

/** 追问一般钻到五层左右（技能约定 4–6 层），圆点至少画这么多颗。 */
const USUAL_DEPTH = 5;

/** 这场模拟的结论；报告里没写就没有。 */
export function mockVerdict(report: unknown): { label: string; tone: Tone } | null {
  return VERDICTS[pickText(dict(report), 'verdict') ?? ''] ?? null;
}

function Diagnosis({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block label="卡在哪">
      <ul className="space-y-3">
        {items.map((item, index) => {
          const layer = num(item.broke_at_layer) ?? 0;
          return (
            <li key={`${index}:${pickText(item, 'claim')}`} className="text-sm leading-relaxed">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[var(--ink)]">{pickText(item, 'claim')}</span>
                {layer > 0 && <Pips total={Math.max(USUAL_DEPTH, layer)} reached={layer - 1} stuck={layer} label={`追到第 ${layer} 层卡住`} />}
              </div>
              <div className="text-[var(--ink-2)]">{pickText(item, 'issue')}</div>
              {pickText(item, 'interviewer_thought') && <div className="mt-1 border-l-2 border-[var(--line-2)] pl-2 text-[var(--muted)]">{pickText(item, 'interviewer_thought')}</div>}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function RedFlags({ flags }: { flags: Dict }) {
  const groups = FLAG_LABELS.map(({ key, label }) => ({ label, items: texts(flags[key]) })).filter(group => group.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <Block label="起疑的地方">
      <ul className="space-y-1.5 text-sm leading-relaxed text-[var(--ink-2)]">
        {groups.flatMap(group => group.items.map(item => (
          <li key={`${group.label}:${item}`} className="flex items-baseline gap-2">
            <span className="shrink-0 rounded bg-[var(--warning-bg)] px-1.5 text-xs leading-5 text-[var(--warning)]">{group.label}</span>
            {item}
          </li>
        )))}
      </ul>
    </Block>
  );
}

function ReferenceAnswers({ answers }: { answers: Dict[] }) {
  if (answers.length === 0) return null;
  return (
    <Block label="可以这样答">
      <ul className="space-y-2">
        {answers.map((item, index) => {
          const verify = texts(item.needs_verification);
          return (
            <li key={`${index}:${pickText(item, 'claim')}`} className="rounded-md bg-[var(--note)] px-3 py-2 text-sm leading-relaxed">
              <div className="text-[var(--ink)]">{pickText(item, 'answer')}</div>
              {verify.length > 0 && <div className="mt-1 text-xs text-[var(--warning)]">先核实：{verify.join('；')}</div>}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

/** 一列待办：每条前面一个空方框。 */
export function TodoList({ label, items, level }: { label: string; items: string[]; level?: 'section' | 'sub' }) {
  if (items.length === 0) return null;
  return (
    <Block label={label} level={level}>
      <ul className="space-y-1.5 text-sm leading-relaxed text-[var(--ink-2)]">
        {items.map((item, index) => (
          <li key={`${index}:${item}`} className="flex items-baseline gap-2">
            <span className="h-3 w-3 shrink-0 translate-y-0.5 rounded-sm border-[1.5px] border-[var(--hard)]" aria-hidden />
            {item}
          </li>
        ))}
      </ul>
    </Block>
  );
}

/** 这份报告里有没有技能约定的那几块。 */
export function isMockReport(report: unknown): boolean {
  const data = dict(report);
  return ['verdict', 'diagnosis', 'red_flags', 'reference_answers', 'todo', 'gaps'].some(key => data[key] != null);
}

export function MockReport({ report }: { report: unknown }) {
  const data = dict(report);
  const gaps = dicts(data.gaps).map(gap => [pickText(gap, 'jd_requirement'), pickText(gap, 'strategy')].filter(Boolean).join('：')).filter(Boolean);
  return (
    <div className="space-y-4">
      <Diagnosis items={dicts(data.diagnosis)} />
      <RedFlags flags={dict(data.red_flags)} />
      <ReferenceAnswers answers={dicts(data.reference_answers)} />
      <TodoList label="回去要做的" items={[...texts(data.todo), ...gaps]} />
    </div>
  );
}
