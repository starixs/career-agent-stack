/**
 * 差距计划（gap-plan）的成果：对着一个岗位或方向，已经有的 / 缺证据的 / 真没有的三栏，加一张可验收的小任务表。
 */
import { GAP_CATEGORY_LABELS } from '../../careerConstants';
import { Badge, formatDate, type BadgeTone } from '../../CareerPrimitives';
import type { Direction, GapPlan } from '../../types';
import { dict, list, num, parseJson, pickText, texts, type Dict } from '../read';

import { Block, Disclosure, ResultList } from './parts';

const CATEGORIES: ReadonlyArray<{ key: keyof typeof GAP_CATEGORY_LABELS; tone: BadgeTone }> = [
  { key: 'have', tone: 'success' }, { key: 'need_evidence', tone: 'warning' }, { key: 'missing', tone: 'error' },
];

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
      {CATEGORIES.map(({ key, tone }) => {
        const items = texts(gaps[key], 'requirement', 'text', 'item');
        return (
          <div key={key}>
            <Badge tone={tone}>{GAP_CATEGORY_LABELS[key]} {items.length}</Badge>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--ink-2)]">
              {items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TaskTable({ tasks }: { tasks: unknown[] }) {
  if (tasks.length === 0) return null;
  // 任务有时是一句话，有时是 {title, acceptance, est_hours…}
  const rows = tasks.map(task => (typeof task === 'string' ? { title: task } : dict(task)));
  return (
    <Block label="小任务">
      <table className="w-full border-collapse text-sm">
        <thead className="text-left text-xs text-[var(--muted)]">
          <tr><th className="py-1.5 pr-4 font-medium">做什么</th><th className="py-1.5 pr-4 font-medium">做到什么算完成</th><th className="w-16 py-1.5 font-medium">大概要</th></tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const hours = num(row.est_hours) ?? num(row.hours);
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

export function GapPlans({ plans, targets }: { plans: GapPlan[]; targets: GapTargets }) {
  return (
    <ResultList title="做过的计划" count={plans.length}>
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
          <GapColumns gaps={dict(parseJson(plan.gaps_json, `gap_plan ${plan.id}.gaps_json`))} />
          <TaskTable tasks={list(parseJson(plan.actions_json, `gap_plan ${plan.id}.actions_json`))} />
        </Disclosure>
      ))}
    </ResultList>
  );
}
