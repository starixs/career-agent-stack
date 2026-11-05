/**
 * Offer 对比的看板。他在这页要看见的是：哪个答复期限先到、钱谁多谁少，然后才是其余的事实。
 *   答复期限：每个 Offer 一根从今天伸到期限的条，同一把尺子，短的先到；
 *   一年的钱：每个 Offer 一根按金额比例画的条，下面一行小字是怎么算的；
 *   其余（地点、内容匹配、风险）：一个 Offer 一张卡并排，缺的留一道虚线。
 * 钱只用他填的数：有「年包合计」用它，否则用 月薪 × 月数（再加签字费）；两样都不够就不画条，写「未知」。
 */
import type { ReactNode } from 'react';

import { safeJson } from '../careerApi';
import { Button, textOrUnknown } from '../CareerPrimitives';
import { num, text, type Dict } from '../skills/read';
import { daysUntil, toneColor, type Tone } from '../skills/visual';
import type { Offer } from '../types';

/** 期限条的尺子至少画这么多天：只有一个很近的期限时，条也不会顶满整行。 */
const MIN_SCALE_DAYS = 14;
/** 离答复期限不到这么多天用提醒色（和 DueLabel 的 72 小时一致）。 */
const SOON_DAYS = 3;
const WAN = 10_000;

const compOf = (offer: Offer): Dict => safeJson<Dict>(offer.comp_json, {});

/** 一年能拿到的钱：有「年包合计」用它；否则 月薪 × 月数 + 签字费。算不出来返回 null。 */
export function annualOf(comp: Dict): number | null {
  const total = num(comp.total);
  if (total !== null) return total;
  const base = num(comp.base);
  const months = num(comp.months);
  return base !== null && months !== null ? base * months + (num(comp.signing) ?? 0) : null;
}

export function formatMoney(value: number): string {
  if (value < WAN) return String(value);
  const wan = value / WAN;
  return `${Number.isInteger(wan) ? wan : wan.toFixed(1)} 万`;
}

/** 这笔钱是怎么来的：「22000 × 15 + 签字费 20000」。 */
function payParts(comp: Dict): string {
  const base = text(comp.base);
  const months = text(comp.months);
  return [base && months ? `${base} × ${months}` : base, text(comp.signing) && `签字费 ${text(comp.signing)}`, text(comp.bonus) && `奖金 ${text(comp.bonus)}`, text(comp.stock) && `股票 ${text(comp.stock)}`]
    .filter(Boolean).join(' + ');
}

function dueText(days: number, deadline: string): string {
  if (days < 0) return `已过 ${-days} 天`;
  if (days === 0) return '今天';
  if (days <= SOON_DAYS) return `剩 ${days} 天`;
  const date = new Date(deadline);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 一行条形：左边名字，中间一根按比例的条，右边读数。 */
function BarRow({ name, percent, color, value, caption }: { name: string; percent: number | null; color: string; value: ReactNode; caption?: string }) {
  return (
    <li className="grid grid-cols-[7rem_minmax(0,1fr)_6rem] items-center gap-x-3">
      <span className="truncate text-sm text-[var(--ink)]">{name}</span>
      <span className="h-3 rounded-full bg-[var(--inset)]">
        {percent !== null && <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, percent))}%`, background: color }} />}
      </span>
      <span className="text-right font-human text-base font-semibold tabular-nums text-[var(--ink)]">{value}</span>
      {caption && <span className="col-start-2 col-end-4 text-xs tabular-nums text-[var(--muted)]">{caption}</span>}
    </li>
  );
}

function Chart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-3 font-human text-base font-semibold text-[var(--ink)]">{title}</h2>
      <ul className="space-y-3">{children}</ul>
    </section>
  );
}

function Deadlines({ offers }: { offers: Offer[] }) {
  const rows = offers.map(offer => ({ offer, days: daysUntil(offer.deadline) }));
  const scale = Math.max(MIN_SCALE_DAYS, ...rows.map(row => row.days ?? 0));
  return (
    <Chart title="答复期限">
      {rows.map(({ offer, days }) => {
        const tone: Tone = days !== null && days <= SOON_DAYS ? (days < 0 ? 'danger' : 'warning') : 'neutral';
        return (
          <BarRow
            key={offer.id} name={textOrUnknown(offer.company_name)}
            percent={days === null ? null : (Math.max(0, days) / scale) * 100}
            color={tone === 'neutral' ? 'var(--ink-2)' : toneColor(tone)}
            value={days === null || !offer.deadline ? <span className="font-sans text-sm font-normal text-[var(--subtle)]">未知</span> : <span style={{ color: tone === 'neutral' ? undefined : toneColor(tone) }}>{dueText(days, offer.deadline)}</span>}
          />
        );
      })}
    </Chart>
  );
}

function Pay({ offers }: { offers: Offer[] }) {
  const rows = offers.map(offer => { const comp = compOf(offer); return { offer, comp, annual: annualOf(comp) }; });
  const max = Math.max(0, ...rows.map(row => row.annual ?? 0));
  return (
    <Chart title="一年的钱">
      {rows.map(({ offer, comp, annual }) => (
        <BarRow
          key={offer.id} name={textOrUnknown(offer.company_name)}
          percent={annual === null || max === 0 ? null : (annual / max) * 100}
          color="var(--primary)" caption={payParts(comp) || undefined}
          value={annual === null ? <span className="font-sans text-sm font-normal text-[var(--subtle)]">未知</span> : formatMoney(annual)}
        />
      ))}
    </Chart>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-3 text-sm leading-relaxed">
      <dt className="w-8 shrink-0 text-xs leading-6 text-[var(--muted)]">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 text-[var(--ink)]">
        {value ?? <span className="mt-3 block w-10 border-t border-dashed border-[var(--line-2)]" role="img" aria-label="未知" />}
      </dd>
    </div>
  );
}

function OfferCard({ offer, onEdit }: { offer: Offer; onEdit: (offer: Offer) => void }) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-human text-lg font-semibold text-[var(--ink)]">{textOrUnknown(offer.company_name)}</div>
          <div className="truncate text-xs text-[var(--muted)]">{textOrUnknown(offer.title)}</div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onEdit(offer)}>编辑</Button>
      </div>
      <dl className="space-y-1.5">
        <Fact label="地点" value={offer.location} />
        <Fact label="内容" value={offer.content_match} />
        <Fact label="风险" value={offer.risk_notes} />
      </dl>
    </li>
  );
}

export function OfferBoard({ offers, onEdit }: { offers: Offer[]; onEdit: (offer: Offer) => void }) {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-x-12 gap-y-8 lg:grid-cols-2">
        <Deadlines offers={offers} />
        <Pay offers={offers} />
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {offers.map(offer => <OfferCard key={offer.id} offer={offer} onEdit={onEdit} />)}
      </ul>
    </div>
  );
}
