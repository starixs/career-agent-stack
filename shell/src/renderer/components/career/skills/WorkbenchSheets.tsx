/**
 * 工作台入口：一张小纸片 + 名字。纸片上是这个工作台里的真实内容的一小块（最要紧的那条追问、最近查的公司、
 * 手上的 Offer……），看一眼就知道里面是什么，不用再配一句说明（立场 7：对象用它自己的样子，不用抽象符号）。
 * 还没有数据时放一块示例并标「示例」（立场 3：示例不冒充他的数据）。
 */
import type { ReactNode } from 'react';

import { safeJson } from '../careerApi';
import { STAGE_LABELS, TRAFFIC_LIGHT_LABELS } from '../careerConstants';
import { Badge, DueLabel, type BadgeTone } from '../CareerPrimitives';
import { LAYER_NAMES } from '../review/monthFunnelGeometry';

import type { Workbench, WorkbenchId } from './catalog';
import { dict, dicts, parseJson, pickText, text, texts } from './read';
import { riskOf, sortByRisk } from './results/PredictionList';
import type { MarketData } from './useMarketData';

interface Sheet { body: ReactNode; example?: boolean; count?: string }

const LIGHT_TONE: Record<string, BadgeTone> = { red: 'error', yellow: 'warning', green: 'success' };
/** 纸片上最多摆几行同类条目（投递、Offer）：再多就挤出纸片了。 */
const MAX_ROWS = 3;

function Row({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{left}</span>
      {right && <span className="shrink-0 text-[var(--muted)]">{right}</span>}
    </span>
  );
}

function interviewSheet({ predictions, mocks }: MarketData): Sheet {
  const top = sortByRisk(predictions)[0];
  const risk = top ? riskOf(top) : { label: '高风险', tone: 'error' as const };
  const statement = top?.statement ?? '主导三层配置体系的开发';
  const first = top ? texts(parseJson(top.expected_chain_json, `probe_prediction ${top.id}.expected_chain_json`))[0] : '「主导」是指你独立完成了哪些模块？';
  return {
    example: !top,
    count: [predictions.length > 0 && `${predictions.length} 条预测`, mocks > 0 && `${mocks} 场模拟`].filter(Boolean).join(' · ') || undefined,
    body: (
      <>
        <Badge tone={risk.tone}>{risk.label}</Badge>
        <span className="line-clamp-2 text-[var(--ink)]">{statement}</span>
        {first && <span className="block truncate text-[var(--muted)]">↳ {first}</span>}
      </>
    ),
  };
}

/** 搜题页另一条分支在改，这里不读它的数据，只放示例。 */
function examSheet(): Sheet {
  return {
    example: true,
    body: (
      <>
        <span className="line-clamp-2 text-[var(--ink)]">下列哪一项不是 TCP 的特性？</span>
        <span className="block truncate font-medium text-[var(--success)]">✓ C. 无连接</span>
      </>
    ),
  };
}

function resumeSheet({ resume }: MarketData): Sheet {
  const schema = dict(resume ? parseJson(resume.schema_json, `resume_master ${resume.id}.schema_json`) : null);
  const school = pickText(dict(dicts(schema.education)[0]), 'school');
  const job = dict(dicts(schema.experience)[0]);
  const work = [pickText(job, 'org'), pickText(job, 'position')].filter(Boolean).join(' · ');
  const project = pickText(dict(dicts(schema.projects)[0]), 'name');
  const real = !!(school || work || project);
  const rows: Array<[string, string | null]> = real
    ? [['教育', school], ['实习', work || null], ['项目', project]]
    : [['教育', '某某大学 · 计算机'], ['实习', '某公司 · 后端开发'], ['项目', '订单系统并发优化']];
  return {
    example: !real,
    body: rows.filter(([, value]) => value).map(([label, value]) => (
      <span key={label} className="flex items-baseline gap-2">
        <span className="shrink-0 text-[var(--muted)]">{label}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{value}</span>
      </span>
    )),
  };
}

function applySheet({ dossiers }: MarketData): Sheet {
  const applied = dossiers.filter(row => !!row.applied_at).length;
  const rows = dossiers.length
    ? dossiers.slice(0, MAX_ROWS).map(row => ({ key: row.application_id, name: row.company_name ?? row.title, stage: STAGE_LABELS[row.stage] ?? row.stage }))
    : [{ key: 'a', name: '甲公司', stage: '已投递' }, { key: 'b', name: '乙公司', stage: '投递中' }, { key: 'c', name: '丙公司', stage: '需要你' }];
  return {
    example: dossiers.length === 0,
    count: applied > 0 ? `投出 ${applied} 家` : undefined,
    body: rows.map(row => <Row key={row.key} left={row.name} right={row.stage} />),
  };
}

function companySheet({ companies }: MarketData): Sheet {
  const latest = companies[0];
  const name = latest ? latest.legal_name ?? safeJson<string[]>(latest.brand_names, [])[0] ?? '未知公司' : '某某科技有限公司';
  const light = latest ? latest.traffic_light : 'yellow';
  const report = dict(latest ? parseJson(latest.dd_report_json, `company ${latest.id}.dd_report_json`) : null);
  const pitfall = latest ? pickText(dict(dicts(report.pitfalls)[0]), 'risk') : '校招岗位可能挂在子公司签约';
  return {
    example: !latest,
    count: companies.length > 0 ? `查过 ${companies.length} 家` : undefined,
    body: (
      <>
        <Row left={name} right={light ? <Badge tone={LIGHT_TONE[light] ?? 'neutral'}>{TRAFFIC_LIGHT_LABELS[light] ?? light}</Badge> : undefined} />
        {pitfall && <span className="line-clamp-2 text-[var(--muted)]">{pitfall}</span>}
      </>
    ),
  };
}

function offerSheet({ offers }: MarketData): Sheet {
  const rows = offers.length
    ? offers.slice(0, MAX_ROWS).map(offer => {
      const comp = dict(parseJson(offer.comp_json, `offer ${offer.id}.comp_json`));
      const pay = [text(comp.base), text(comp.months)].filter(Boolean).join(' × ');
      return { key: offer.id, name: offer.company_name ?? '未知公司', pay, due: offer.deadline ? <DueLabel at={offer.deadline} suffix="" /> : null };
    })
    : [{ key: 'a', name: '甲公司', pay: '22000 × 15', due: <Badge tone="warning">剩 2 天</Badge> }, { key: 'b', name: '乙公司', pay: '25000 × 13', due: null }];
  return {
    example: offers.length === 0,
    count: offers.length > 0 ? `${offers.length} 个` : undefined,
    // 一个 Offer 两行：公司和答复期限一行，薪酬一行；挤在一行会把薪酬截掉
    body: rows.slice(0, 2).map(row => (
      <span key={row.key} className="block">
        <Row left={row.name} right={row.due} />
        {row.pay && <span className="block tabular-nums text-[var(--muted)]">{row.pay}</span>}
      </span>
    )),
  };
}

function monthSheet({ board }: MarketData): Sheet {
  return {
    body: (
      <span className="flex h-full items-center justify-between gap-2">
        {LAYER_NAMES.map((name, index) => (
          <span key={name} className="flex flex-col">
            <span className="font-human text-2xl font-semibold tabular-nums leading-8 text-[var(--ink)]">{board ? board.counts[index] : '—'}</span>
            <span className="text-[var(--muted)]">{name}</span>
          </span>
        ))}
      </span>
    ),
  };
}

const SHEETS: Record<WorkbenchId, (data: MarketData) => Sheet> = {
  interview: interviewSheet, exam: examSheet, resume: resumeSheet, apply: applySheet, company: companySheet, offer: offerSheet, month: monthSheet,
};

export function WorkbenchSheet({ item, data, onOpen }: { item: Workbench; data: MarketData; onOpen: () => void }) {
  const sheet = SHEETS[item.id](data);
  return (
    <button type="button" onClick={onOpen} className="group flex w-full flex-col gap-2 text-left focus-visible:outline-none">
      <span className="relative flex h-[108px] w-full flex-col gap-1 overflow-hidden rounded-md border border-[var(--line-2)] bg-[var(--paper)] p-3 text-xs leading-5 transition-colors duration-150 group-hover:border-[var(--hard)] group-focus-visible:ring-2 group-focus-visible:ring-[var(--primary)]">
        {sheet.body}
        {sheet.example && <span className="absolute bottom-1.5 right-2 text-[var(--subtle)]">示例</span>}
      </span>
      <span className="flex items-baseline gap-2 px-0.5">
        <span className="text-sm font-semibold text-[var(--ink)]">{item.name}</span>
        {sheet.count && <span className="text-xs tabular-nums text-[var(--subtle)]">{sheet.count}</span>}
      </span>
    </button>
  );
}
