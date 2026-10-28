/**
 * 每一天的投递，后来怎么样了：按投出那天分，柱高 = 那天投出的份数，往上长出它们后来最远走到的层。
 * 颜色就是漏斗的颜色（不放图例）；最近 7 天还没结果，只画虚线空心；悬停一天浮出那天的小结。
 */
import { useState } from 'react';

import type { MonthBoard } from '@/components/career/types';

import { LAYER_COLORS, LAYER_INK } from './monthFunnelGeometry';

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const BASE_LIGHT = '#BCC8EC';

interface DayLine { text: string; color: string; strong?: boolean }

export function MonthDays({ board, layer }: { board: MonthBoard; layer: number | null }) {
  const [day, setDay] = useState<number | null>(null);
  const { month, days } = board;
  const max = Math.max(1, ...days.map((d) => d.sent));
  const unit = 100 / max;
  const lit = (k: number) => (layer === null || layer === k ? 1 : 0.22);
  return (
    <section aria-label="每一天的投递，后来怎么样了" className="flex flex-col gap-2.5">
      <h2 className="m-0 font-human text-xl font-normal text-[var(--ink)]">每一天的投递，后来怎么样了</h2>
      <div className="relative" onMouseLeave={() => setDay(null)}>
        <div className="flex h-[124px] items-end">
          {days.map((d, i) => {
            const label = `${month.month}/${d.day} ${WD[(month.dow1 + i) % 7]}`;
            const future = month.today !== null && d.day > month.today;
            const lines: DayLine[] = [];
            if (d.split[3] > 0) lines.push({ text: `拿到 Offer · ${d.companies.offer.join('、')}`, color: LAYER_INK[3], strong: true });
            if (d.split[2] > 0) lines.push({ text: `${d.split[2]} 份进了面试 · ${d.companies.interview.join('、')}`, color: LAYER_INK[2] });
            if (d.split[1] > 0) lines.push({ text: `${d.split[1]} 份收到笔试或测评 · ${d.companies.exam.join('、')}`, color: LAYER_INK[1] });
            if (d.split[0] > 0) lines.push({ text: d.pending ? `${d.split[0]} 份投出不满 7 天，还在等` : `${d.split[0]} 份停在投出`, color: 'var(--muted)' });
            const on = day === i;
            return (
              <button
                key={d.day} type="button"
                aria-label={future ? `${label}，还没到` : `${label}，投出 ${d.sent} 份${lines.length ? '，' + lines.map((l) => l.text).join('，') : ''}`}
                className="relative flex min-w-0 flex-1 cursor-pointer flex-col items-stretch rounded-[var(--radius-md)] border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]"
                style={on ? { background: 'rgba(47,75,160,0.07)' } : undefined}
                onMouseEnter={() => setDay(i)} onFocus={() => setDay(i)}
              >
                <span className="flex h-[120px] flex-col-reverse items-center gap-[2px]">
                  {d.split.map((c, k) => {
                    if (c <= 0) return null;
                    const top = d.split.slice(k + 1).every((x) => x <= 0);
                    const fill = k === 0
                      ? (d.pending ? { background: 'rgba(110,134,218,0.08)', boxShadow: 'inset 0 0 0 1.5px rgba(110,134,218,0.75)' } : { background: BASE_LIGHT })
                      : { background: LAYER_COLORS[k], boxShadow: k === 3 ? '0 0 12px rgba(212,154,42,0.75)' : undefined };
                    return (
                      <span
                        key={k}
                        className="w-[56%] max-w-[22px] flex-none"
                        style={{ height: Math.max(4, c * unit - 2), borderRadius: top ? '7px 7px 3px 3px' : 3, opacity: lit(k), transition: 'opacity var(--motion-base) cubic-bezier(.2,0,0,1)', ...fill }}
                      />
                    );
                  })}
                </span>
                {on && !future && (
                  <span
                    className="absolute bottom-[calc(100%+8px)] z-30 w-[250px] rounded-[var(--radius-lg)] bg-[var(--paper)] px-3.5 py-2.5 text-left text-xs leading-[21px] shadow-[var(--shadow-md)]"
                    style={i < 4 ? { left: 0 } : i > days.length - 6 ? { right: 0 } : { left: '50%', transform: 'translateX(-50%)' }}
                  >
                    <b className="mb-0.5 block text-sm text-[var(--ink)]">{label} · 投出 {d.sent} 份</b>
                    {lines.map((l) => <span key={l.text} className="block" style={{ color: l.color, fontWeight: l.strong ? 600 : 400 }}>{l.text}</span>)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <svg width="100%" height="8" viewBox="0 0 1000 8" preserveAspectRatio="none" aria-hidden className="block">
          <path d="M 2 4 C 120 2, 240 6, 380 4 S 640 2, 780 5 S 940 3, 998 4" fill="none" stroke="var(--ink)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <div className="flex pt-1">
          {days.map((d, i) => {
            const wd = (month.dow1 + i) % 7;
            const isToday = month.today === d.day;
            const future = month.today !== null && d.day > month.today;
            return (
              <span
                key={d.day}
                className={`min-w-0 flex-1 py-0.5 text-center text-xs ${isToday ? 'mx-2 rounded-full bg-[var(--primary)] font-semibold text-[var(--on-primary)]' : future ? 'text-[var(--line-2)]' : wd === 0 || wd === 6 ? 'text-[var(--subtle)]' : 'text-[var(--ink-2)]'}`}
              >{d.day}</span>
            );
          })}
        </div>
      </div>
    </section>
  );
}
