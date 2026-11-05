/**
 * 公司调研工作台（功能市场 › 工作台）：围绕公司调研技能做的一整页。
 * 上面选一家点一下就查（他投过的公司直接列出来）；下面左边是查过的公司和红黄绿灯，右边是这家的报告。
 * 方向探索和差距计划是技能点，成果在功能市场各自的详情里。
 */
import { useState } from 'react';

import { careerApi, safeJson } from '@/components/career/careerApi';
import { TRAFFIC_LIGHT_LABELS } from '@/components/career/careerConstants';
import { Badge, Button, CareerPage, ErrorRow, LoadingRow, formatDate, useSuggestToChat, type BadgeTone } from '@/components/career/CareerPrimitives';
import { PickBox, type PickOption } from '@/components/career/skills/PickBox';
import { CompanyReport } from '@/components/career/skills/results/CompanyReport';
import { useMyTargets } from '@/components/career/skills/StartBar';
import type { Company } from '@/components/career/types';
import { useCareerQuery } from '@/components/career/useCareerData';
import { pageSurfaceId } from '@/features/career-shell/pageSurface';

const LIGHT_TONE: Record<string, BadgeTone> = { red: 'error', yellow: 'warning', green: 'success' };
const SURFACE = pageSurfaceId({ kind: 'career-review', view: 'research' });

function companyName(company: Company): string {
  return company.legal_name ?? safeJson<string[]>(company.brand_names, [])[0] ?? '未知公司';
}

function Light({ light }: { light: string | null }) {
  return light ? <Badge tone={LIGHT_TONE[light] ?? 'neutral'}>{TRAFFIC_LIGHT_LABELS[light] ?? light}</Badge> : <Badge>未评级</Badge>;
}

function StartResearch() {
  const suggest = useSuggestToChat();
  const { companies } = useMyTargets();
  const [company, setCompany] = useState<PickOption | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PickBox ariaLabel="公司" placeholder="选一家你投过的，或输入公司名" value={company} onChange={setCompany} options={companies} freeText className="w-80 max-w-full" />
      <Button variant="primary" disabled={!company} onClick={() => { if (company) suggest(`帮我查一下「${company.label}」这家公司靠不靠谱`, { surface: SURFACE }); }}>查这家公司</Button>
    </div>
  );
}

function CompanyList({ companies, activeId, onSelect }: { companies: Company[]; activeId: string; onSelect: (id: string) => void }) {
  return (
    <ul aria-label="查过的公司">
      {companies.map(company => (
        <li key={company.id}>
          <button
            type="button" onClick={() => onSelect(company.id)} aria-current={company.id === activeId ? 'true' : undefined}
            className={`relative flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${company.id === activeId ? 'bg-[var(--selected)] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-[var(--primary)]' : 'hover:bg-[var(--hover)]'}`}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{companyName(company)}</span>
            <Light light={company.traffic_light} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function CompanyDetail({ company }: { company: Company }) {
  const report = safeJson<unknown>(company.dd_report_json, null);
  const brands = safeJson<string[]>(company.brand_names, []).filter(brand => brand !== company.legal_name);
  return (
    <div className="min-w-0 max-w-3xl space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-[var(--ink)]">{companyName(company)}</h2>
          <Light light={company.traffic_light} />
        </div>
        <div className="mt-1 text-xs text-[var(--muted)]">{brands.length > 0 ? `${brands.join(' / ')} · ` : ''}{formatDate(company.updated_at)} 查的</div>
      </div>
      <CompanyReport report={report} legacyChecks={safeJson<unknown[]>(company.manual_checks, [])} />
    </div>
  );
}

export default function CareerResearch({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(careerApi.companies, ['company']);
  const companies = query.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = companies.find(company => company.id === selectedId) ?? companies[0] ?? null;
  return (
    <CareerPage embedded={embedded} title="公司调研">
      <div className="space-y-6 px-6 py-5">
        <StartResearch />
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !query.data && <LoadingRow />}
        {selected && (
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[280px_minmax(0,1fr)]">
            <CompanyList companies={companies} activeId={selected.id} onSelect={setSelectedId} />
            <CompanyDetail key={selected.id} company={selected} />
          </div>
        )}
      </div>
    </CareerPage>
  );
}
