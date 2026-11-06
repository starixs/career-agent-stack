/**
 * 岗位评估（job-evaluate）的成果。他要看见的是：这个岗位值不值得投，强在哪、弱在哪，投之前还要确认什么。
 *   一行一个岗位，右边一枚结论章；点开左边是五项评分的雷达图，右边是每一项的分数和依据；
 *   硬门槛是一排带记号的小标签（符合 / 不符合 / JD 没写）；投之前要确认的是一列待办方框。
 * 每个分数旁边都带依据（技能约束：没有依据的分数不给），不单独摆一个总分当结论。
 */
import { Check, HelpCircle, X } from 'lucide-react';

import type { JobEvaluation } from '../../types';
import { dict, dicts, num, parseJson, pickText, texts, type Dict } from '../read';
import { Stamp, toneColor, type Tone } from '../visual';

import { TodoList } from './MockReport';
import { Block, Disclosure, ResultList } from './parts';

const VERDICTS: Record<string, { label: string; tone: Tone }> = {
  strong: { label: '很值得投', tone: 'success' },
  good: { label: '值得投', tone: 'success' },
  moderate: { label: '可以试试', tone: 'info' },
  weak: { label: '偏弱', tone: 'warning' },
  poor: { label: '不建议投', tone: 'neutral' },
  prefilter_fail: { label: '硬门槛没过', tone: 'danger' },
};

/** 五个方面，顺序和权重来自技能定义（技能 30 / 经历 25 / 方向 20 / 公司 15 / 成长 10）。 */
const DIMENSIONS = [
  { key: 'skills', label: '技能' }, { key: 'experience', label: '经历' }, { key: 'direction', label: '方向' },
  { key: 'culture', label: '公司' }, { key: 'growth', label: '成长' },
] as const;

const CHECK_STATUS: Record<string, { label: string; tone: Tone; Icon: typeof Check }> = {
  pass: { label: '符合', tone: 'success', Icon: Check },
  fail: { label: '不符合', tone: 'danger', Icon: X },
  unverified: { label: 'JD 没写', tone: 'neutral', Icon: HelpCircle },
};

/** 低于这个分用提醒色：技能里「某一项低于 40」会触发复核。 */
const LOW_SCORE = 40;
const FULL_SCORE = 100;

/** 雷达图的画布：中心和半径（viewBox 200×180）。 */
const RADAR = { cx: 100, cy: 92, r: 62, labelGap: 16 };

/** 第 index 个顶点在半径 ratio（0–1）处的坐标；第一个顶点朝正上方。 */
function vertex(index: number, ratio: number): [number, number] {
  const angle = (-90 + index * (360 / DIMENSIONS.length)) * (Math.PI / 180);
  return [RADAR.cx + Math.cos(angle) * RADAR.r * ratio, RADAR.cy + Math.sin(angle) * RADAR.r * ratio];
}
const ring = (ratio: number): string => DIMENSIONS.map((_, index) => vertex(index, ratio).map(n => n.toFixed(1)).join(',')).join(' ');

function Radar({ values }: { values: Array<number | null> }) {
  const shape = values.map((value, index) => vertex(index, Math.max(0, Math.min(FULL_SCORE, value ?? 0)) / FULL_SCORE));
  const summary = DIMENSIONS.map(({ label }, index) => `${label} ${values[index] ?? '未评'}`).join('，');
  return (
    <svg viewBox="0 0 200 180" className="h-[180px] w-[200px] shrink-0" role="img" aria-label={`五项评分：${summary}`}>
      {[1, 0.5].map(ratio => <polygon key={ratio} points={ring(ratio)} fill="none" stroke="var(--line-2)" strokeWidth={1} />)}
      {DIMENSIONS.map((_, index) => { const [x, y] = vertex(index, 1); return <line key={index} x1={RADAR.cx} y1={RADAR.cy} x2={x} y2={y} stroke="var(--line)" strokeWidth={1} />; })}
      <polygon points={shape.map(point => point.map(n => n.toFixed(1)).join(',')).join(' ')} fill="var(--mint)" stroke="var(--hard)" strokeWidth={1.75} strokeLinejoin="round" />
      {shape.map(([x, y], index) => <circle key={index} cx={x} cy={y} r={3} fill={(values[index] ?? 0) < LOW_SCORE ? 'var(--warning)' : 'var(--hard)'} />)}
      {DIMENSIONS.map(({ label }, index) => {
        const [x, y] = vertex(index, 1 + RADAR.labelGap / RADAR.r);
        return <text key={label} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="var(--muted)">{label}</text>;
      })}
    </svg>
  );
}

function Reasons({ values, reasons }: { values: Array<number | null>; reasons: Dict[] }) {
  return (
    <dl className="min-w-0 flex-1 space-y-2 self-center text-sm">
      {DIMENSIONS.map(({ key, label }, index) => {
        const value = values[index];
        const reason = reasons.find(item => item.dimension === key);
        const low = value !== null && value < LOW_SCORE;
        return (
          <div key={key} className="flex items-baseline gap-3">
            <dt className="w-8 shrink-0 text-xs text-[var(--muted)]">{label}</dt>
            <dd className="m-0 w-7 shrink-0 text-right font-human text-base font-semibold tabular-nums" style={{ color: low ? 'var(--warning)' : 'var(--ink)' }}>{value ?? '—'}</dd>
            <dd className="m-0 min-w-0 flex-1 leading-relaxed text-[var(--ink-2)]">{reason ? pickText(reason, 'reason') : null}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Prefilter({ checks }: { checks: Dict[] }) {
  if (checks.length === 0) return null;
  return (
    <Block label="硬门槛">
      <ul className="flex flex-wrap gap-2">
        {checks.map((check, index) => {
          const { label, tone, Icon } = CHECK_STATUS[pickText(check, 'status') ?? ''] ?? CHECK_STATUS.unverified;
          const item = pickText(check, 'item') ?? '未命名';
          return (
            <li
              key={`${index}:${item}`} title={pickText(check, 'evidence') ?? undefined} aria-label={`${item}：${label}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line-2)] bg-[var(--paper)] py-1 pl-2 pr-3 text-sm text-[var(--ink-2)]"
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={2} style={{ color: toneColor(tone) }} aria-hidden />
              {item}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function EvaluationRow({ evaluation, open = false }: { evaluation: JobEvaluation; open?: boolean }) {
  const output = dict(parseJson(evaluation.score_json, `job ${evaluation.job_id}.score_json`));
  const verdict = VERDICTS[pickText(output, 'verdict') ?? ''];
  const score = dict(output.score);
  const values = DIMENSIONS.map(({ key }) => num(score[key]));
  const scored = values.some(value => value !== null);
  return (
    <Disclosure
      defaultOpen={open}
      summary={(
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate font-human text-base font-semibold text-[var(--ink)]">{[evaluation.company_name, evaluation.title].filter(Boolean).join(' · ')}</span>
          {verdict && <Stamp tone={verdict.tone}>{verdict.label}</Stamp>}
        </span>
      )}
    >
      {scored && (
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <Radar values={values} />
          <Reasons values={values} reasons={dicts(output.reasons)} />
        </div>
      )}
      <Prefilter checks={dicts(dict(output.prefilter).checks)} />
      <TodoList label="投之前要确认" items={texts(output.ask_user)} />
    </Disclosure>
  );
}

/** openFirst：第一条先展开（示例里一打开就看到雷达图）。 */
export function JobScores({ evaluations, openFirst = false }: { evaluations: JobEvaluation[]; openFirst?: boolean }) {
  return (
    <ResultList label="评估过的岗位">
      {evaluations.map((evaluation, index) => <EvaluationRow key={evaluation.job_id} evaluation={evaluation} open={openFirst && index === 0} />)}
    </ResultList>
  );
}
