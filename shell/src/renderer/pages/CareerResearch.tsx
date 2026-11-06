/**
 * 公司调研工作台（功能市场 › 工作台）：围绕公司调研技能做的一整页。
 * 上面选一家点一下就查（他投过的公司直接列出来）；下面左边是查过的公司和红黄绿灯，右边是这家的报告。
 * 方向探索和差距计划是技能点，成果在功能市场各自的详情里。
 */
import { useState } from 'react';

import { careerApi, safeJson } from '@/components/career/careerApi';
import { TRAFFIC_LIGHT_LABELS } from '@/components/career/careerConstants';
import { Button, CareerPage, ErrorRow, LoadingRow, formatDate, useSuggestToChat } from '@/components/career/CareerPrimitives';
import { PickBox, type PickOption } from '@/components/career/skills/PickBox';
import { CompanyReport, companyBasics } from '@/components/career/skills/results/CompanyReport';
import { SAMPLE_COMPANIES } from '@/components/career/skills/samples/company';
import { SampleFrame } from '@/components/career/skills/samples/SampleFrame';
import { useMyTargets } from '@/components/career/skills/StartBar';
import { Lamps, Stamp, type Tone } from '@/components/career/skills/visual';
import type { Company } from '@/components/career/types';
import { useCareerQuery } from '@/components/career/useCareerData';
import { pageSurfaceId } from '@/features/career-shell/pageSurface';

const LIGHT_TONE: Record<string, Tone> = { red: 'danger', yellow: 'warning', green: 'success' };
const lightLabel = (light: string | null): string => (light ? TRAFFIC_LIGHT_LABELS[light] ?? light : '未评级');
const SURFACE = pageSurfaceId({ kind: 'career-review', view: 'research' });

function companyName(company: Company): string {
  return company.legal_name ?? safeJson<string[]>(company.brand_names, [])[0] ?? '未知公司';
}

function StartResearch() {
  const suggest = useSuggestToChat();
  const { companies } = useMyTargets();
  const [company, setCompany] = useState<PickOption | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PickBox ariaLabel="公司" placeholder="公司名" value={company} onChange={setCompany} options={companies} freeText className="w-80 max-w-full" />
      <Button variant="primary" disabled={!company} onClick={() => { if (company) suggest(`帮我查一下「${company.label}」这家公司靠不靠谱`, { surface: SURFACE }); }}>查这家</Button>
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
            <Lamps light={company.traffic_light} size="sm" />
            <span className="sr-only">{lightLabel(company.traffic_light)}</span>
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
    <div className="min-w-0 max-w-3xl space-y-7">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Lamps light={company.traffic_light} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-human text-2xl font-semibold text-[var(--ink)]">{companyName(company)}</h2>
          <div className="text-xs text-[var(--muted)]">{[brands.join(' / '), companyBasics(report), `${formatDate(company.updated_at)} 查的`].filter(Boolean).join(' · ')}</div>
        </div>
        <Stamp tone={LIGHT_TONE[company.traffic_light ?? ''] ?? 'neutral'}>{lightLabel(company.traffic_light)}</Stamp>
      </header>
      <CompanyReport report={report} legacyChecks={safeJson<unknown[]>(company.manual_checks, [])} />
    </div>
  );
}

/** 左边查过的公司和灯，右边这家的报告。 */
function CompanyBoard({ companies, selected, onSelect }: { companies: Company[]; selected: Company; onSelect: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-[280px_minmax(0,1fr)]">
      <CompanyList companies={companies} activeId={selected.id} onSelect={onSelect} />
      <CompanyDetail key={selected.id} company={selected} />
    </div>
  );
}

/** 一家都还没查过：用示例的三家把查出来的样子摆出来，左边照样能点着换。 */
function SampleBoard() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = SAMPLE_COMPANIES.find(company => company.id === selectedId) ?? SAMPLE_COMPANIES[0];
  return <SampleFrame><CompanyBoard companies={SAMPLE_COMPANIES} selected={selected} onSelect={setSelectedId} /></SampleFrame>;
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
        {selected && <CompanyBoard companies={companies} selected={selected} onSelect={setSelectedId} />}
        {query.data?.length === 0 && <SampleBoard />}
      </div>
    </CareerPage>
  );
}
