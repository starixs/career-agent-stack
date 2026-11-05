/**
 * 公司调研（company-research）的成果。他在这页要看见的是：这家能不能投、哪里要留意、面试时带哪几个问题去问。
 *   要留意的：一条一块，里面贴一张便签写着面试时怎么问；面试时可以问：一排便签；
 *   红线核验：三个数字块（命中 / 没查到记录 / 没法确认）+ 每条红线前一个状态记号；
 *   要你自己核实的：一列待办方框。
 * 没查到不等于没问题（技能约束）：搜不到的写「没查到记录」，查不了的写「没法确认」，都不用表示「好」的绿色。
 * 旧数据不是这个结构：报告原样分段列出来，单独存的人工核实清单照常显示。
 */
import { Check, HelpCircle, X } from 'lucide-react';

import { ExternalLink } from '@/components/ExternalLink';

import { StructuredJson } from '../../CareerPrimitives';
import { dict, dicts, isDict, num, pickText, texts, type Dict } from '../read';
import { StatTile, toneColor, type Tone } from '../visual';

import { Block } from './parts';

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

function RedLines({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  const count = (status: LineStatus) => items.filter(item => statusOf(item) === status).length;
  return (
    <Block level="section" label="红线核验">
      <div className="flex gap-2">
        {(['hit', 'clean', 'unverified'] as const).map(status => (
          <StatTile key={status} value={count(status)} label={LINE_STATUS[status].label} tone={status === 'hit' && count(status) > 0 ? 'danger' : undefined} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
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
    </Block>
  );
}

function Pitfalls({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block level="section" label="要留意的">
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
    </Block>
  );
}

function Questions({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Block level="section" label="面试时可以问">
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map((item, index) => <li key={`${index}:${item}`} className={NOTE}>{item}</li>)}
      </ul>
    </Block>
  );
}

function ManualChecks({ items }: { items: Array<Dict | string> }) {
  if (items.length === 0) return null;
  return (
    <Block level="section" label="要你自己核实的">
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
    </Block>
  );
}

function Signals({ items }: { items: Dict[] }) {
  const hits = items.filter(item => (num(item.hits) ?? 0) > 0);
  if (hits.length === 0) return null;
  return (
    <Block level="section" label="风险信号">
      <ul className="space-y-1.5 text-sm">
        {hits.map((item, index) => (
          <li key={`${index}:${pickText(item, 'category')}`} className="flex flex-wrap items-baseline gap-x-3">
            <span className="rounded bg-[var(--warning-bg)] px-1.5 text-xs leading-5 text-[var(--warning)]">{pickText(item, 'category')}{pickText(item, 'keyword') ? `（${pickText(item, 'keyword')}）` : ''}</span>
            <Sources items={dicts(item.strong)} />
          </li>
        ))}
      </ul>
    </Block>
  );
}

/** 这份报告里有没有技能约定的那几块。 */
function isCompanyReport(report: unknown): boolean {
  const data = dict(report);
  return ['entity', 'red_lines', 'pitfalls', 'interview_questions', 'manual_required', 'signals'].some(key => data[key] != null);
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
  return (
    <div className="space-y-7">
      {isCompanyReport(report) ? (
        <>
          <Pitfalls items={dicts(data.pitfalls)} />
          <Questions items={texts(data.interview_questions)} />
          <RedLines items={dicts(data.red_lines)} />
        </>
      ) : report != null && <StructuredJson value={report} />}
      <ManualChecks items={checks} />
      <Signals items={dicts(data.signals)} />
    </div>
  );
}
