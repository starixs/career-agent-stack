/**
 * 模拟面试（interview-probe）结束后的面试官视角复盘：这场的判断、每个点卡在第几层、起疑的地方、可以怎么答、回去要做什么。
 * 旧数据不是技能约定的结构：调用方先用 isMockReport 判断，认不出就退回通用展示。
 */
import { Badge, type BadgeTone } from '../../CareerPrimitives';
import { dict, dicts, num, pickText, texts, type Dict } from '../read';

import { Block, Bullets } from './parts';

const VERDICTS: Record<string, { label: string; tone: BadgeTone }> = {
  pass: { label: '这场过了', tone: 'success' },
  borderline: { label: '这场有点悬', tone: 'warning' },
  fail: { label: '这场没过', tone: 'error' },
};

const FLAG_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'suspicious', label: '存疑' }, { key: 'inflated', label: '说大了' }, { key: 'scripted', label: '像背的' },
];

function Diagnosis({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block label="卡在哪">
      <ul className="space-y-3">
        {items.map((item, index) => {
          const layer = num(item.broke_at_layer);
          return (
            <li key={`${index}:${pickText(item, 'claim')}`} className="text-sm leading-relaxed">
              <div className="text-[var(--ink)]">{pickText(item, 'claim')}</div>
              <div className="text-[var(--ink-2)]">{layer !== null && layer > 0 ? `追到第 ${layer} 层：` : ''}{pickText(item, 'issue')}</div>
              {pickText(item, 'interviewer_thought') && <div className="text-[var(--muted)]">面试官会想：{pickText(item, 'interviewer_thought')}</div>}
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
    <Block label="面试官起疑的地方">
      <ul className="space-y-1 text-sm leading-relaxed text-[var(--ink-2)]">
        {groups.flatMap(group => group.items.map(item => (
          <li key={`${group.label}:${item}`} className="flex gap-3"><span className="w-12 shrink-0 text-xs leading-6 text-[var(--muted)]">{group.label}</span>{item}</li>
        )))}
      </ul>
    </Block>
  );
}

function ReferenceAnswers({ answers }: { answers: Dict[] }) {
  if (answers.length === 0) return null;
  return (
    <Block label="可以这样答（只用你亲口说过的事实）">
      <ul className="space-y-3">
        {answers.map((item, index) => {
          const verify = texts(item.needs_verification);
          return (
            <li key={`${index}:${pickText(item, 'claim')}`} className="text-sm leading-relaxed">
              <div className="text-[var(--muted)]">{pickText(item, 'claim', 'question')}</div>
              <div className="text-[var(--ink)]">{pickText(item, 'answer')}</div>
              {verify.length > 0 && <div className="text-[var(--warning)]">先核实：{verify.join('；')}</div>}
            </li>
          );
        })}
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
  const verdict = VERDICTS[pickText(data, 'verdict') ?? ''];
  const gaps = dicts(data.gaps).map(gap => [pickText(gap, 'jd_requirement'), pickText(gap, 'strategy')].filter(Boolean).join('：')).filter(Boolean);
  return (
    <div className="space-y-4">
      {verdict && <Badge tone={verdict.tone}>{verdict.label}</Badge>}
      <Diagnosis items={dicts(data.diagnosis)} />
      <RedFlags flags={dict(data.red_flags)} />
      <ReferenceAnswers answers={dicts(data.reference_answers)} />
      <Bullets label="回去要做的" items={texts(data.todo)} />
      <Bullets label="对着岗位要求" items={gaps} />
    </div>
  );
}
