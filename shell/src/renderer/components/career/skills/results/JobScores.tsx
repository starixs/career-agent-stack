/**
 * 岗位评估（job-evaluate）的成果：一行一个岗位——结论 + 五项评分；点开看每一项的依据、硬门槛、投之前要确认的事。
 * 每个分数旁边都带依据（技能约束：没有依据的分数不给），不单独摆一个总分当结论。
 */
import { Badge, type BadgeTone } from '../../CareerPrimitives';
import type { JobEvaluation } from '../../types';
import { dict, dicts, num, parseJson, pickText, texts, type Dict } from '../read';

import { Block, Bullets, Disclosure, ResultList } from './parts';

const VERDICTS: Record<string, { label: string; tone: BadgeTone }> = {
  strong: { label: '很值得投', tone: 'success' },
  good: { label: '值得投', tone: 'success' },
  moderate: { label: '可以试试', tone: 'info' },
  weak: { label: '偏弱', tone: 'warning' },
  poor: { label: '不建议投', tone: 'neutral' },
  prefilter_fail: { label: '硬门槛没过', tone: 'error' },
};

/** 五个方面，顺序和权重来自技能定义（技能 30 / 经历 25 / 方向 20 / 公司 15 / 成长 10）。 */
const DIMENSIONS = [
  { key: 'skills', label: '技能' }, { key: 'experience', label: '经历' }, { key: 'direction', label: '方向' },
  { key: 'culture', label: '公司' }, { key: 'growth', label: '成长' },
] as const;

const CHECK_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  pass: { label: '符合', tone: 'success' },
  fail: { label: '不符合', tone: 'error' },
  unverified: { label: 'JD 没写', tone: 'neutral' },
};

/** 低于这个分，条用提醒色：技能里「某一项低于 40」会触发复核。 */
const LOW_SCORE = 40;
const FULL_SCORE = 100;

function ScoreBars({ score, reasons }: { score: Dict; reasons: Dict[] }) {
  return (
    <dl className="grid grid-cols-[3rem_8rem_2rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-sm">
      {DIMENSIONS.map(({ key, label }) => {
        const value = num(score[key]);
        const reason = reasons.find(item => item.dimension === key);
        const width = value === null ? 0 : Math.max(0, Math.min(FULL_SCORE, value));
        return (
          <div key={key} className="contents">
            <dt className="text-xs text-[var(--muted)]">{label}</dt>
            <dd className="m-0 self-center">
              <div className="h-1.5 rounded-full bg-[var(--inset)]" role="img" aria-label={`${label} ${value ?? '未评'}`}>
                <div className="h-full rounded-full" style={{ width: `${width}%`, background: width < LOW_SCORE ? 'var(--warning)' : 'var(--primary)' }} />
              </div>
            </dd>
            <dd className="m-0 text-right text-xs tabular-nums text-[var(--ink-2)]">{value ?? '—'}</dd>
            <dd className="m-0 leading-relaxed text-[var(--ink-2)]">{reason ? pickText(reason, 'reason') : <span className="text-[var(--subtle)]">没有写依据</span>}</dd>
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
      <ul className="space-y-1.5 text-sm">
        {checks.map((check, index) => {
          const status = CHECK_STATUS[pickText(check, 'status') ?? ''] ?? CHECK_STATUS.unverified;
          return (
            <li key={`${index}:${pickText(check, 'item')}`} className="flex items-start gap-3 leading-5">
              <span className="w-16 shrink-0"><Badge tone={status.tone}>{status.label}</Badge></span>
              <span className="w-32 shrink-0 text-[var(--ink)]">{pickText(check, 'item') ?? '未命名'}</span>
              <span className="min-w-0 flex-1 leading-relaxed text-[var(--muted)]">{pickText(check, 'evidence')}</span>
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function EvaluationRow({ evaluation }: { evaluation: JobEvaluation }) {
  const output = dict(parseJson(evaluation.score_json, `job ${evaluation.job_id}.score_json`));
  const verdict = VERDICTS[pickText(output, 'verdict') ?? ''];
  const review = dict(output.review);
  return (
    <Disclosure
      summary={(
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]">{[evaluation.company_name, evaluation.title].filter(Boolean).join(' · ')}</span>
          {verdict && <Badge tone={verdict.tone}>{verdict.label}</Badge>}
        </span>
      )}
    >
      <ScoreBars score={dict(output.score)} reasons={dicts(output.reasons)} />
      <Prefilter checks={dicts(dict(output.prefilter).checks)} />
      <Bullets label="投之前要确认" items={texts(output.ask_user)} />
      {review.triggered === true && pickText(review, 'note') && (
        <Block label="复核"><p className="text-sm leading-relaxed text-[var(--ink-2)]">{pickText(review, 'note')}</p></Block>
      )}
    </Disclosure>
  );
}

export function JobScores({ evaluations }: { evaluations: JobEvaluation[] }) {
  return (
    <ResultList label="评估过的岗位">
      {evaluations.map(evaluation => <EvaluationRow key={evaluation.job_id} evaluation={evaluation} />)}
    </ResultList>
  );
}
