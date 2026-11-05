/**
 * 公司调研（company-research）的成果：一家公司的求职视角报告。
 * 顺序按「投不投、面试问什么」排：坑点（带面试怎么问）→ 面试时可以问 → 红线核验 → 要你自己核实的 → 风险信号。
 * 没查到不等于没问题（技能约束）：查不了的写「没法确认」，不写成「没问题」。
 * 旧数据不是这个结构：报告原样分段列出来，单独存的人工核实清单照常显示。
 */
import { ExternalLink } from '@/components/ExternalLink';

import { Badge, StructuredJson, type BadgeTone } from '../../CareerPrimitives';
import { dict, dicts, isDict, num, pickText, texts, type Dict } from '../read';

import { Block, Bullets } from './parts';

const RED_LINE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  hit: { label: '命中', tone: 'error' },
  // 搜不到只能说「公开网页没有记录」，不能说成没问题，所以不用表示「好」的绿色
  clean: { label: '没查到记录', tone: 'info' },
  unverified: { label: '没法确认', tone: 'neutral' },
};

const LINK = 'text-[var(--primary)] underline-offset-2 hover:underline';

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

function Pitfalls({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block label="要留意的">
      <ul className="space-y-3">
        {items.map((item, index) => (
          <li key={`${index}:${pickText(item, 'risk')}`} className="text-sm leading-relaxed">
            <div className="text-[var(--ink)]">{pickText(item, 'risk')}</div>
            {pickText(item, 'evidence') && <div className="text-[var(--muted)]">{pickText(item, 'evidence')}</div>}
            {pickText(item, 'ask_in_interview') && <div className="text-[var(--ink-2)]">面试时问：{pickText(item, 'ask_in_interview')}</div>}
          </li>
        ))}
      </ul>
    </Block>
  );
}

function RedLines({ items }: { items: Dict[] }) {
  if (items.length === 0) return null;
  return (
    <Block label="红线核验">
      <ul className="space-y-1.5 text-sm">
        {items.map((item, index) => {
          const status = RED_LINE_STATUS[pickText(item, 'status') ?? ''] ?? RED_LINE_STATUS.unverified;
          return (
            <li key={`${index}:${pickText(item, 'name')}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="w-24 shrink-0"><Badge tone={status.tone}>{status.label}</Badge></span>
              <span className="text-[var(--ink-2)]">{pickText(item, 'name')}</span>
              <Sources items={dicts(item.evidence)} />
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function ManualChecks({ items }: { items: Array<Dict | string> }) {
  if (items.length === 0) return null;
  return (
    <Block label="要你自己核实的">
      <ul className="space-y-2 text-sm leading-relaxed">
        {items.map((item, index) => {
          const entry = typeof item === 'string' ? { item } : item;
          const url = pickText(entry, 'entry_url');
          const name = pickText(entry, 'item', 'text');
          return (
            <li key={`${index}:${name}`}>
              <div className="text-[var(--ink)]">{url ? <ExternalLink href={url} className={LINK}>{name}</ExternalLink> : name}</div>
              {pickText(entry, 'why') && <div className="text-[var(--muted)]">{pickText(entry, 'why')}</div>}
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
    <Block label="风险信号">
      <ul className="space-y-1.5 text-sm">
        {hits.map((item, index) => (
          <li key={`${index}:${pickText(item, 'category')}`} className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-[var(--ink-2)]">{pickText(item, 'category')}{pickText(item, 'keyword') ? `（${pickText(item, 'keyword')}）` : ''}</span>
            <Sources items={dicts(item.strong)} />
          </li>
        ))}
      </ul>
    </Block>
  );
}

function basicLine(basic: Dict): string {
  const founded = pickText(basic, 'founded');
  const status = pickText(basic, 'status');
  return [founded && `成立于 ${founded}`, status].filter(Boolean).join(' · ');
}

/** 这份报告里有没有技能约定的那几块。 */
function isCompanyReport(report: unknown): boolean {
  const data = dict(report);
  return ['entity', 'red_lines', 'pitfalls', 'interview_questions', 'manual_required', 'signals'].some(key => data[key] != null);
}

export function CompanyReport({ report, legacyChecks }: { report: unknown; legacyChecks: unknown[] }) {
  const data = dict(report);
  const basic = basicLine(dict(data.basic));
  // 人工核实清单：新报告在 manual_required 里；更早的数据单独存在 company.manual_checks
  const required = dicts(data.manual_required);
  const checks: Array<Dict | string> = required.length ? required : legacyChecks.filter((item): item is Dict | string => typeof item === 'string' || isDict(item));
  return (
    <div className="space-y-5">
      {basic && <p className="text-xs text-[var(--muted)]">{basic}</p>}
      {isCompanyReport(report) ? (
        <>
          <Pitfalls items={dicts(data.pitfalls)} />
          <Bullets label="面试时可以问" items={texts(data.interview_questions)} />
          <RedLines items={dicts(data.red_lines)} />
        </>
      ) : report != null && <StructuredJson value={report} />}
      <ManualChecks items={checks} />
      <Signals items={dicts(data.signals)} />
    </div>
  );
}
