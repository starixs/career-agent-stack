/**
 * 差距计划（gap-plan）的成果。他是想投一个够不太着的岗位时来的，最想知道的是「差多少、补齐要多久」。
 * 第一层：一根比例条（已经有的 / 缺证据的 / 真没有的各占多少）加一个数（补齐大概要几小时）；
 * 第二层：三栏逐条列出，加一张可验收的小任务表。
 */
import { GAP_CATEGORY_LABELS } from '../../careerConstants';
import { formatDate } from '../../CareerPrimitives';
import type { Direction, GapPlan } from '../../types';
import { dict, list, num, parseJson, pickText, texts, type Dict } from '../read';
import { SegmentBar, StatTile, Tag, type Tone } from '../visual';

import { Block, Disclosure, ResultList } from './parts';

const CATEGORIES: ReadonlyArray<{ key: keyof typeof GAP_CATEGORY_LABELS; bar: Tone }> = [
  { key: 'have', bar: 'success' }, { key: 'need_evidence', bar: 'warning' }, { key: 'missing', bar: 'danger' },
];

const gapItems = (gaps: Dict, key: string): string[] => texts(gaps[key], 'requirement', 'text', 'item');
/** 任务有时是一句话，有时是 {title, acceptance, est_hours…}。 */
const taskRows = (tasks: unknown[]): Dict[] => tasks.map(task => (typeof task === 'string' ? { title: task } : dict(task)));
const taskHours = (row: Dict): number | null => num(row.est_hours) ?? num(row.hours);

/** 第一层：岗位要求里已经有的、缺证据的、真没有的各占多少（一根比例条），补齐大概要几个小时。 */
function GapOverview({ gaps, tasks }: { gaps: Dict; tasks: Dict[] }) {
  const hours = tasks.reduce((sum, row) => sum + (taskHours(row) ?? 0), 0);
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
      <div className="min-w-48 flex-1">
        <SegmentBar label="岗位要求" segments={CATEGORIES.map(({ key, bar }) => ({ label: GAP_CATEGORY_LABELS[key], value: gapItems(gaps, key).length, tone: bar }))} />
      </div>
      {hours > 0 && <div className="flex w-28 shrink-0"><StatTile value={hours} label="小时补齐" /></div>}
    </div>
  );
}

export interface GapTargets { jobs: Array<{ job_id: string; company_name: string | null; title: string }>; directions: Direction[] }

function targetName(plan: GapPlan, targets: GapTargets): string {
  const job = plan.job_id ? targets.jobs.find(candidate => candidate.job_id === plan.job_id) : undefined;
  if (job) return [job.company_name, job.title].filter(Boolean).join(' · ');
  const direction = plan.direction_id ? targets.directions.find(candidate => candidate.id === plan.direction_id) : undefined;
  return direction ? `方向：${direction.name}` : '一份差距计划';
}

function GapColumns({ gaps }: { gaps: Dict }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-3">
      {CATEGORIES.map(({ key, bar }) => {
        const items = gapItems(gaps, key);
        if (items.length === 0) return null;
        return (
          <div key={key}>
            <Tag tone={bar}>{GAP_CATEGORY_LABELS[key]}</Tag>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--ink-2)]">
              {items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TaskTable({ rows }: { rows: Dict[] }) {
  if (rows.length === 0) return null;
  return (
    <Block label="小任务">
      <table className="w-full border-collapse text-sm">
        <thead className="text-left text-xs text-[var(--muted)]">
          <tr><th className="py-1.5 pr-4 font-medium">做什么</th><th className="py-1.5 pr-4 font-medium">做到什么算完成</th><th className="w-16 py-1.5 font-medium">大概要</th></tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const hours = taskHours(row);
            return (
              <tr key={`${index}:${pickText(row, 'title')}`} className="border-t border-[var(--line)] align-top">
                <td className="py-2 pr-4 text-[var(--ink)]">{pickText(row, 'title', 'task', 'name') ?? '—'}</td>
                <td className="py-2 pr-4 leading-relaxed text-[var(--ink-2)]">{pickText(row, 'acceptance', 'criteria', 'deliverable') ?? '—'}</td>
                <td className="py-2 tabular-nums text-[var(--muted)]">{hours === null ? '—' : `${hours} 小时`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Block>
  );
}

function PlanBody({ plan }: { plan: GapPlan }) {
  const gaps = dict(parseJson(plan.gaps_json, `gap_plan ${plan.id}.gaps_json`));
  const tasks = taskRows(list(parseJson(plan.actions_json, `gap_plan ${plan.id}.actions_json`)));
  return (
    <>
      <GapOverview gaps={gaps} tasks={tasks} />
      <GapColumns gaps={gaps} />
      <TaskTable rows={tasks} />
    </>
  );
}

export function GapPlans({ plans, targets }: { plans: GapPlan[]; targets: GapTargets }) {
  return (
    <ResultList label="做过的计划">
      {plans.map((plan, index) => (
        <Disclosure
          key={plan.id} defaultOpen={index === 0}
          summary={(
            <span className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]">{targetName(plan, targets)}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--subtle)]">{formatDate(plan.created_at)}</span>
            </span>
          )}
        >
          <PlanBody plan={plan} />
        </Disclosure>
      ))}
    </ResultList>
  );
}
