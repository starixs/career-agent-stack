/**
 * 调研：公司研究（法定名 / 红绿灯 / 九段报告 / 人工核实清单）、方向探索（候选 / 暂定 / 已选 / 放弃）、差距计划。
 * 空的那几块折成一行（名字 + 「—」+ 一个动词按钮），排在最上面；有内容的块在下面展开。
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { careerApi, safeJson } from '@/components/career/careerApi';
import { DIRECTION_STATUSES, DIRECTION_STATUS_LABELS, GAP_CATEGORY_LABELS, TRAFFIC_LIGHT_LABELS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, Card, EMPTY_VALUE, ErrorRow, LoadingRow, SectionTitle, StructuredJson, formatDate, useSuggestToChat,
} from '@/components/career/CareerPrimitives';
import { EmptyLine } from '@/components/career/EmptyLine';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import { briefText, structuredKeyLabel } from '@/components/career/structuredLabels';
import type { Company, Direction, GapPlan, Job } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

interface ResearchData { companies: Company[]; directions: Direction[]; gapPlans: GapPlan[]; jobs: Job[] }

async function loadAll(): Promise<ResearchData> {
  const [companies, directions, gapPlans, jobs] = await Promise.all([
    careerApi.companies(), careerApi.directions(), careerApi.gapPlans(), careerApi.jobs().catch(() => [] as Job[]),
  ]);
  return { companies, directions, gapPlans, jobs };
}

const LIGHT_TONE: Record<string, BadgeTone> = { red: 'error', yellow: 'warning', green: 'success' };
const DIRECTION_TONE: Record<Direction['status'], BadgeTone> = { candidate: 'neutral', tentative: 'info', chosen: 'success', dropped: 'neutral' };

export default function CareerResearch({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(loadAll, ['company', 'direction', 'gap_plan', 'job']);
  const data = query.data;
  return (
    <CareerPage embedded={embedded} title="调研">
      <div className="space-y-6 px-6 py-4">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !data && <LoadingRow />}
        {data && <ResearchBody data={data} onChanged={query.reload} />}
      </div>
    </CareerPage>
  );
}

/** 空块的一行：块名 + 发进对话的动词按钮。 */
const EMPTY_ROWS = {
  companies: { label: '公司研究', verb: '研究一家公司', ask: '帮我研究一下这家公司' },
  directions: { label: '方向探索', verb: '探索方向', ask: '帮我探索适合的方向' },
  gaps: { label: '差距计划', verb: '做差距计划', ask: '帮我做这个岗位的差距计划' },
} as const;
const EMPTY_KEYS = ['companies', 'directions', 'gaps'] as const;

function ResearchBody({ data, onChanged }: { data: ResearchData; onChanged: () => void }) {
  const suggest = useSuggestToChat();
  const empty = { companies: data.companies.length === 0, directions: data.directions.length === 0, gaps: data.gapPlans.length === 0 };
  const emptyKeys = EMPTY_KEYS.filter(k => empty[k]);
  return (
    <>
      {emptyKeys.length > 0 && (
        <div>
          {emptyKeys.map(k => (
            <EmptyLine key={k} label={EMPTY_ROWS[k].label} action={<Button size="sm" variant="ghost" onClick={() => suggest(EMPTY_ROWS[k].ask)}>{EMPTY_ROWS[k].verb}</Button>} />
          ))}
        </div>
      )}
      {(!empty.companies || !empty.directions) && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {!empty.companies && <CompaniesColumn companies={data.companies} />}
          {!empty.directions && <DirectionsColumn directions={data.directions} onChanged={onChanged} />}
        </div>
      )}
      {!empty.gaps && <GapPlansSection plans={data.gapPlans} jobs={data.jobs} directions={data.directions} />}
    </>
  );
}

function CompaniesColumn({ companies }: { companies: Company[] }) {
  return (
    <section>
      <SectionTitle count={companies.length}>公司研究</SectionTitle>
      <div className="space-y-2">
        {companies.map(c => <CompanyCard key={c.id} company={c} />)}
      </div>
    </section>
  );
}

function CompanyCard({ company }: { company: Company }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const brands = safeJson<string[]>(company.brand_names, []);
  const report = safeJson<unknown>(company.dd_report_json, null);
  const checks = safeJson<Array<string | { item?: string; text?: string; done?: boolean }>>(company.manual_checks, []);
  const light = company.traffic_light;
  const name = company.legal_name ?? brands[0] ?? '未知公司';
  const reportEntries = report && typeof report === 'object' && !Array.isArray(report) ? Object.entries(report as Record<string, unknown>).filter(([k, v]) => structuredKeyLabel(k) !== null && v != null) : null;
  return (
    <Card
      title={name}
      extra={light ? <Badge tone={LIGHT_TONE[light] ?? 'neutral'}>{TRAFFIC_LIGHT_LABELS[light] ?? light}</Badge> : undefined}
    >
      <div className="text-xs text-[var(--muted)]">
        {[brands.length > 0 ? `品牌：${brands.join(' / ')}` : null, `更新 ${formatDate(company.updated_at)}`].filter(Boolean).join(' · ')}
      </div>
      <button type="button" onClick={() => setOpen(v => !v)} className="mt-2 flex items-center gap-1 text-xs font-medium text-[var(--ink)]">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        九段报告{reportEntries ? `（${reportEntries.length} 段）` : ''}
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-l-2 border-[var(--line-2)] pl-3 text-sm">
          {!report && <div className="text-xs text-[var(--subtle)]">{EMPTY_VALUE}</div>}
          {reportEntries && reportEntries.map(([k, v]) => (
            <div key={k}>
              <div className="text-xs font-semibold text-[var(--muted)]">{structuredKeyLabel(k)}</div>
              <div className="mt-0.5"><StructuredJson value={v} /></div>
            </div>
          ))}
          {report != null && !reportEntries ? <StructuredJson value={report} /> : null}
        </div>
      )}
      {checks.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-[var(--muted)]">人工核实清单</div>
          <ul className="mt-1 space-y-1">
            {checks.map((item, i) => {
              const text = typeof item === 'string' ? item : item.item ?? item.text ?? briefText(item);
              if (!text) return null;
              const done = checked.has(i) || (typeof item !== 'string' && item.done === true);
              return (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    aria-label={text}
                    checked={done}
                    onChange={() => setChecked(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    className="mt-0.5"
                  />
                  <span className={done ? 'text-[var(--subtle)] line-through' : 'text-[var(--ink)]'}>{text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

function DirectionsColumn({ directions, onChanged }: { directions: Direction[]; onChanged: () => void }) {
  return (
    <section>
      <SectionTitle count={directions.length}>方向探索</SectionTitle>
      <div className="space-y-2">
        {directions.map(d => <DirectionCard key={d.id} direction={d} onChanged={onChanged} />)}
      </div>
    </section>
  );
}

function DirectionCard({ direction, onChanged }: { direction: Direction; onChanged: () => void }) {
  const action = useCareerAction();
  const rationale = safeJson<Record<string, unknown> | string | null>(direction.rationale_json, null);
  const reason = rationale && typeof rationale === 'object' ? rationale.reason ?? rationale.rationale ?? rationale.why : rationale;
  const uncertainty = rationale && typeof rationale === 'object' ? rationale.uncertainty ?? rationale.uncertainties ?? rationale.risks : null;
  const rest = rationale && typeof rationale === 'object'
    ? Object.fromEntries(Object.entries(rationale).filter(([k]) => !['reason', 'rationale', 'why', 'uncertainty', 'uncertainties', 'risks'].includes(k)))
    : null;
  const setStatus = (status: Direction['status']) => action.run(async () => {
    await careerApi.setDirectionStatus(direction.id, status);
    onChanged();
  });
  return (
    <Card title={direction.name} extra={<Badge tone={DIRECTION_TONE[direction.status] ?? 'neutral'}>{DIRECTION_STATUS_LABELS[direction.status] ?? direction.status}</Badge>}>
      <div className="space-y-1 text-sm">
        {reason != null && <div><span className="text-xs text-[var(--muted)]">理由：</span><StructuredJson value={reason} /></div>}
        {uncertainty != null && <div><span className="text-xs text-[var(--muted)]">不确定性：</span><StructuredJson value={uncertainty} /></div>}
        {rest && Object.keys(rest).length > 0 && <StructuredJson value={rest} />}
      </div>
      {action.error && <div role="alert" className="mt-2 text-xs text-[var(--danger)]">{action.error}</div>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {DIRECTION_STATUSES.filter(s => s !== direction.status).map(s => (
          <Button key={s} busy={action.busy} onClick={() => void setStatus(s)} variant={s === 'chosen' ? 'primary' : 'secondary'}>
            {s === 'dropped' ? '放弃' : `设为${DIRECTION_STATUS_LABELS[s]}`}
          </Button>
        ))}
      </div>
    </Card>
  );
}

interface GapTask { title?: string; task?: string; name?: string; acceptance?: string; criteria?: string; due?: string; deadline?: string; done?: boolean; status?: string }

function GapPlansSection({ plans, jobs, directions }: { plans: GapPlan[]; jobs: Job[]; directions: Direction[] }) {
  return (
    <section>
      <SectionTitle count={plans.length}>差距计划</SectionTitle>
      <div className="space-y-3">
        {plans.map(plan => {
          const gaps = safeJson<Record<string, unknown[]>>(plan.gaps_json, {});
          const tasks = safeJson<GapTask[]>(plan.actions_json, []);
          const job = plan.job_id ? jobs.find(j => j.id === plan.job_id) : undefined;
          const direction = plan.direction_id ? directions.find(d => d.id === plan.direction_id) : undefined;
          const target = job ? `${job.company_name ?? '未知公司'} · ${job.title}` : direction ? `方向：${direction.name}` : '未关联目标';
          return (
            <Card key={plan.id} title={target} extra={<span className="text-xs text-[var(--subtle)]">{formatDate(plan.created_at)}</span>}>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                {(['have', 'need_evidence', 'missing'] as const).map(cat => {
                  const items = Array.isArray(gaps[cat]) ? gaps[cat] : [];
                  const tone: BadgeTone = cat === 'have' ? 'success' : cat === 'need_evidence' ? 'warning' : 'error';
                  return (
                    <div key={cat}>
                      <Badge tone={tone}>{GAP_CATEGORY_LABELS[cat]}（{items.length}）</Badge>
                      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-[var(--ink)]">
                        {items.map(briefText).filter((it): it is string => it !== null).map((it, i) => <li key={i}>{it}</li>)}
                        {items.length === 0 && <li className="list-none text-[var(--subtle)]">{EMPTY_VALUE}</li>}
                      </ul>
                    </div>
                  );
                })}
              </div>
              {Array.isArray(tasks) && tasks.length > 0 && (
                <table className="mt-3 w-full border-collapse text-xs">
                  <thead className="text-left text-[var(--muted)]">
                    <tr><th className="py-1 pr-2 font-medium">任务</th><th className="py-1 pr-2 font-medium">验收标准</th><th className="py-1 pr-2 font-medium">期限</th><th className="py-1 font-medium">状态</th></tr>
                  </thead>
                  <tbody>
                    {tasks.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--line)] align-top">
                        <td className="py-1 pr-2 text-[var(--ink)]">{typeof t === 'string' ? t : t.title ?? t.task ?? t.name ?? '—'}</td>
                        <td className="py-1 pr-2 text-[var(--muted)]">{typeof t === 'string' ? '—' : t.acceptance ?? t.criteria ?? '—'}</td>
                        <td className="py-1 pr-2 text-[var(--muted)]">{typeof t === 'string' ? '—' : formatDate(t.due ?? t.deadline, '—')}</td>
                        <td className="py-1">{typeof t !== 'string' && (t.done || t.status === 'done') ? <Badge tone="success">完成</Badge> : <Badge>待办</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
