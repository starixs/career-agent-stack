/**
 * 公司调研（company-research）的成果，分两层看（2026-11-05 用户定）。
 * 他用到这页时，多半是要认真投这一家，或者已经进了笔试、面试——想要的是一份汇总：
 *   第一层（宏观）：一句话结论 + 两三个要点；再加科普——这家公司是做什么的、这个岗位来了做什么。
 *   第二层（分项）：一排分项块，每块一个数；点哪块，下面就摊开哪一项的细节，一次只看一项。
 * 要读的文字只有结论、要点、科普和每一项的内容本身；多少、轻重、状态都用数字块、记号和便签表达。
 * 没查到不等于没问题（技能约束）：搜不到的写「没查到记录」，查不了的写「没法确认」，都不用表示「好」的绿色。
 * 旧数据不是这个结构：报告原样分段列出来，单独存的人工核实清单照常显示。
 */
import { Briefcase, Building2, Check, HelpCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { ExternalLink } from '@/components/ExternalLink';

import { StructuredJson } from '../../CareerPrimitives';
import { dict, dicts, isDict, num, pickText, texts, type Dict } from '../read';
import { PointRow, TileTabs, type TileTab } from '../layers';
import { toneColor, type Tone } from '../visual';

type LineStatus = 'hit' | 'clean' | 'unverified';
const LINE_STATUS: Record<LineStatus, { label: string; tone: Tone; Icon: typeof Check }> = {
  hit: { label: '命中', tone: 'danger', Icon: X },
  clean: { label: '没查到记录', tone: 'info', Icon: Check },
  unverified: { label: '没法确认', tone: 'neutral', Icon: HelpCircle },
};
const statusOf = (line: Dict): LineStatus => {
  const status = pickText(line, 'status');
  return status === 'hit' || status === 'clean' ? status : 'unverified';
};

const LINK = 'text-[var(--primary)] underline-offset-2 hover:underline';
/** 便签：一句要带去问的话。 */
const NOTE = 'rounded-md bg-[var(--note)] px-3 py-2 text-sm leading-relaxed text-[var(--ink)]';

function Sources({ items }: { items: Dict[] }) {
  const links = items.map(item => ({ title: pickText(item, 'title') ?? pickText(item, 'url'), url: pickText(item, 'url') })).filter(link => link.title);
  if (links.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-3 text-xs">
      {links.map(link => (link.url
        ? <ExternalLink key={link.url} href={link.url} className={LINK}>{link.title}</ExternalLink>
        : <span key={link.title} className="text-[var(--muted)]">{link.title}</span>))}
    </span>
  );
}

// ─── 第一层：结论、要点、科普 ───

function Summary({ summary }: { summary: Dict }) {
  const line = pickText(summary, 'one_line');
  const points = texts(summary.points);
  if (!line && points.length === 0) return null;
  return (
    <section aria-label="结论">
      {line && <p className="font-human text-lg font-semibold leading-relaxed text-[var(--ink)]">{line}</p>}
      {points.length > 0 && <div className="mt-3"><PointRow label="要点" points={points} /></div>}
    </section>
  );
}

function IntroCard({ icon, label, children, sources }: { icon: ReactNode; label: string; children: string; sources?: Dict[] }) {
  return (
    <div className="flex gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--hard)] bg-[var(--note)] text-[var(--ink)]" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <h3 className="font-human text-base font-semibold text-[var(--ink)]">{label}</h3>
        <p className="mt-1 text-sm leading-relaxed text-[var(--ink-2)]">{children}</p>
        {sources && <div className="mt-1.5"><Sources items={sources} /></div>}
      </div>
    </div>
  );
}

/** 科普：很多人投之前并不清楚这家公司做什么、这个岗位招他来做什么。 */
function Intro({ intro }: { intro: Dict }) {
  const business = pickText(intro, 'business');
  const role = pickText(intro, 'role');
  if (!business && !role) return null;
  return (
    <section aria-label="科普" className={`grid grid-cols-1 gap-3 ${business && role ? 'md:grid-cols-2' : ''}`}>
      {business && <IntroCard icon={<Building2 className="h-4 w-4" strokeWidth={1.75} />} label="这家公司是做什么的" sources={dicts(intro.sources)}>{business}</IntroCard>}
      {role && <IntroCard icon={<Briefcase className="h-4 w-4" strokeWidth={1.75} />} label="这个岗位来了做什么">{role}</IntroCard>}
    </section>
  );
}

// ─── 第二层：分项 ───

function Pitfalls({ items }: { items: Dict[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {items.map((item, index) => (
        <li key={`${index}:${pickText(item, 'risk')}`} className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
          <div>
            <div className="text-sm font-semibold leading-relaxed text-[var(--ink)]">{pickText(item, 'risk')}</div>
            {pickText(item, 'evidence') && <div className="text-xs leading-relaxed text-[var(--muted)]">{pickText(item, 'evidence')}</div>}
          </div>
          {pickText(item, 'ask_in_interview') && <div className={`${NOTE} mt-auto`}>{pickText(item, 'ask_in_interview')}</div>}
        </li>
      ))}
    </ul>
  );
}

function RedLines({ items }: { items: Dict[] }) {
  return (
    <ul className="grid grid-cols-1 gap-x-8 gap-y-2.5 text-sm sm:grid-cols-2">
      {items.map((item, index) => {
        const status = statusOf(item);
        const { label, tone, Icon } = LINE_STATUS[status];
        return (
          <li key={`${index}:${pickText(item, 'name')}`} className="flex items-start gap-2">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: toneColor(tone) }} role="img" aria-label={label}>
              <Icon className="h-4 w-4" strokeWidth={2} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className={status === 'hit' ? 'font-medium text-[var(--ink)]' : 'text-[var(--ink-2)]'}>{pickText(item, 'name')}</span>
              <Sources items={dicts(item.evidence)} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Signals({ items }: { items: Dict[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {items.map((item, index) => (
        <li key={`${index}:${pickText(item, 'category')}`} className="flex flex-wrap items-baseline gap-x-3">
          <span className="rounded bg-[var(--warning-bg)] px-1.5 text-xs leading-5 text-[var(--warning)]">{pickText(item, 'category')}{pickText(item, 'keyword') ? `（${pickText(item, 'keyword')}）` : ''}</span>
          <Sources items={dicts(item.strong)} />
        </li>
      ))}
    </ul>
  );
}

function Questions({ items }: { items: string[] }) {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {items.map((item, index) => <li key={`${index}:${item}`} className={NOTE}>{item}</li>)}
    </ul>
  );
}

function ManualChecks({ items }: { items: Array<Dict | string> }) {
  return (
    <ul className="space-y-2 text-sm leading-relaxed">
      {items.map((item, index) => {
        const entry = typeof item === 'string' ? { item } : item;
        const url = pickText(entry, 'entry_url');
        const name = pickText(entry, 'item', 'text');
        return (
          <li key={`${index}:${name}`} className="flex items-baseline gap-2">
            <span className="h-3 w-3 shrink-0 translate-y-0.5 rounded-sm border-[1.5px] border-[var(--hard)]" aria-hidden />
            <span className="min-w-0">
              <span className="text-[var(--ink)]">{url ? <ExternalLink href={url} className={LINK}>{name}</ExternalLink> : name}</span>
              {pickText(entry, 'why') && <span className="block text-xs text-[var(--muted)]">{pickText(entry, 'why')}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function buildFactors(data: Dict, checks: Array<Dict | string>): TileTab[] {
  const pitfalls = dicts(data.pitfalls);
  const lines = dicts(data.red_lines);
  const hits = lines.filter(line => statusOf(line) === 'hit').length;
  const signals = dicts(data.signals).filter(item => (num(item.hits) ?? 0) > 0);
  const questions = texts(data.interview_questions);
  const all: Array<TileTab & { present: boolean }> = [
    { id: 'pitfalls', label: '要留意', value: pitfalls.length, tone: pitfalls.length ? 'warning' : undefined, present: pitfalls.length > 0, body: <Pitfalls items={pitfalls} /> },
    { id: 'red-lines', label: '红线命中', value: hits, tone: hits ? 'danger' : undefined, present: lines.length > 0, body: <RedLines items={lines} /> },
    { id: 'signals', label: '风险信号', value: signals.length, tone: signals.length ? 'warning' : undefined, present: signals.length > 0, body: <Signals items={signals} /> },
    { id: 'questions', label: '面试时问', value: questions.length, present: questions.length > 0, body: <Questions items={questions} /> },
    { id: 'checks', label: '自己核实', value: checks.length, present: checks.length > 0, body: <ManualChecks items={checks} /> },
  ];
  return all.filter(factor => factor.present).map(({ present: _present, ...tab }) => tab);
}

/** 这份报告里有没有技能约定的那几块。 */
function isCompanyReport(report: unknown): boolean {
  const data = dict(report);
  return ['summary', 'intro', 'entity', 'red_lines', 'pitfalls', 'interview_questions', 'manual_required', 'signals'].some(key => data[key] != null);
}

/** 「成立于 2014 年 · 存续」；报告里没有就是空串。 */
export function companyBasics(report: unknown): string {
  const basic = dict(dict(report).basic);
  const founded = pickText(basic, 'founded');
  return [founded && `成立于 ${founded}`, pickText(basic, 'status')].filter(Boolean).join(' · ');
}

export function CompanyReport({ report, legacyChecks }: { report: unknown; legacyChecks: unknown[] }) {
  const data = dict(report);
  // 人工核实清单：新报告在 manual_required 里；更早的数据单独存在 company.manual_checks
  const required = dicts(data.manual_required);
  const checks: Array<Dict | string> = required.length ? required : legacyChecks.filter((item): item is Dict | string => typeof item === 'string' || isDict(item));
  if (!isCompanyReport(report)) {
    return (
      <div className="space-y-6">
        {report != null && <StructuredJson value={report} />}
        {checks.length > 0 && <ManualChecks items={checks} />}
      </div>
    );
  }
  return (
    <div className="space-y-7">
      <Summary summary={dict(data.summary)} />
      <Intro intro={dict(data.intro)} />
      <TileTabs label="分项" tabs={buildFactors(data, checks)} />
    </div>
  );
}
