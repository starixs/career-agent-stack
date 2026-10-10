/**
 * 调研：公司研究（法定名 / 红绿灯 / 九段报告 / 人工核实清单）、方向探索（候选 / 暂定 / 已选 / 放弃）、差距计划。
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { careerApi, safeJson } from '@/components/career/careerApi';
import { DIRECTION_STATUSES, DIRECTION_STATUS_LABELS, GAP_CATEGORY_LABELS, TRAFFIC_LIGHT_LABELS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, Card, EmptyState, ErrorRow, LoadingRow, SectionTitle, StructuredJson, formatDate,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
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
      <div className="space-y-5 px-4 py-3">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !data && <LoadingRow />}
        {data && (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CompaniesColumn companies={data.companies} />
              <DirectionsColumn directions={data.directions} onChanged={query.reload} />
            </div>
            <GapPlansSection plans={data.gapPlans} jobs={data.jobs} directions={data.directions} />
          </>
        )}
      </div>
    </CareerPage>
  );
}

function CompaniesColumn({ companies }: { companies: Company[] }) {
  return (
    <section>
      <SectionTitle>公司研究（{companies.length}）</SectionTitle>
      {companies.length === 0 && <EmptyState title="还没有公司研究" hint="红绿灯只是提示，最终判断在你。" example="帮我研究一下这家公司" />}
      <div className="space-y-2">
        {companies.map(c => <CompanyCard key={c.id} company={c} />)}
      </div>
    </section>
  );
}

const REPORT_SECTION_LABELS: Record<string, string> = {
  overview: '概览', business: '业务', finance: '财务', team: '团队', culture: '文化', compensation: '薪酬', risk: '风险',
  reviews: '评价', hiring: '招聘', summary: '总结', legal: '法律', news: '新闻', competition: '竞争', growth: '成长',
};

function CompanyCard({ company }: { company: Company }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const brands = safeJson<string[]>(company.brand_names, []);
  const report = safeJson<unknown>(company.dd_report_json, null);
  const checks = safeJson<Array<string | { item?: string; text?: string; done?: boolean }>>(company.manual_checks, []);
  const light = company.traffic_light;
  const name = company.legal_name ?? brands[0] ?? '未知公司';
  const reportEntries = report && typeof report === 'object' && !Array.isArray(report) ? Object.entries(report as Record<string, unknown>) : null;
  return (
    <Card
      title={name}
      extra={light ? <Badge tone={LIGHT_TONE[light] ?? 'neutral'}>{TRAFFIC_LIGHT_LABELS[light] ?? light}</Badge> : <Badge>未评级</Badge>}
    >
      <div className="text-xs text-[var(--muted)]">
        法定名：{company.legal_name ?? '未知'}{brands.length > 0 ? ` · 品牌：${brands.join(' / ')}` : ''} · 更新 {formatDate(company.updated_at)}
      </div>
      <button type="button" onClick={() => setOpen(v => !v)} className="mt-2 flex items-center gap-1 text-xs font-medium text-[var(--ink)]">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        九段报告{reportEntries ? `（${reportEntries.length} 段）` : ''}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-[var(--line)] bg-[var(--inset)] p-2 text-sm">
          {!report && <div className="text-xs text-[var(--subtle)]">暂无报告</div>}
          {reportEntries && reportEntries.map(([k, v]) => (
            <div key={k}>
              <div className="text-xs font-semibold text-[var(--muted)]">{REPORT_SECTION_LABELS[k] ?? k}</div>
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
              const text = typeof item === 'string' ? item : item.item ?? item.text ?? JSON.stringify(item);
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
          <div className="mt-1 text-xs text-[var(--subtle)]">勾选只记在本页，核实结果请在对话里告诉助理。</div>
        </div>
      )}
    </Card>
  );
}

function DirectionsColumn({ directions, onChanged }: { directions: Direction[]; onChanged: () => void }) {
  return (
    <section>
      <SectionTitle>方向探索（{directions.length}）</SectionTitle>
      {directions.length === 0 && <EmptyState title="还没有候选方向" hint="助理会结合你的经历和搜索给出 2–3 个方向。" example="帮我探索适合的方向" />}
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
        <div><span className="text-xs text-[var(--muted)]">理由：</span><StructuredJson value={reason ?? '未知'} /></div>
        <div><span className="text-xs text-[var(--muted)]">不确定性：</span><StructuredJson value={uncertainty ?? '未知'} /></div>
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
      <SectionTitle>差距计划（{plans.length}）</SectionTitle>
      {plans.length === 0 && <EmptyState title="还没有差距计划" hint="针对某个岗位或方向，把差距分成已具备 / 需补证据 / 缺失，并给出可验收的小任务。" example="帮我做这个岗位的差距计划" />}
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
                    <div key={cat} className="rounded-lg border border-[var(--line)] p-2">
                      <Badge tone={tone}>{GAP_CATEGORY_LABELS[cat]}（{items.length}）</Badge>
                      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-[var(--ink)]">
                        {items.map((it, i) => <li key={i}>{typeof it === 'string' ? it : JSON.stringify(it)}</li>)}
                        {items.length === 0 && <li className="list-none text-[var(--subtle)]">无</li>}
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
