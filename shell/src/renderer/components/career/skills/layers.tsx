/**
 * 工作台页的两层结构（2026-11-05 用户定，公司调研是样板，其余工作台照这个想）：
 *   第一层 PointRow：宏观上的两三个点——一眼知道结论和最要紧的事；
 *   第二层 TileTabs：一排数字块当页签，每块是一个分项和它的量；点哪块，下面摊开哪一项，一次只看一项。
 * 这样一页不是从上到下一长串：先看总的，再挑自己关心的那一项看细的。
 */
import { useState, type ReactNode } from 'react';

import { StepCircle, toneColor, type Tone } from './visual';

/** 宏观的几个点：带圈数字 + 一句话，并排。最多三个，多了就不是「点」了。 */
export function PointRow({ label, points }: { label: string; points: ReactNode[] }) {
  if (points.length === 0) return null;
  return (
    <ol aria-label={label} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {points.map((point, index) => (
        <li key={index} className="flex items-start gap-2.5 rounded-lg bg-[var(--inset)] p-3">
          <StepCircle n={index + 1} />
          <span className="min-w-0 pt-0.5 text-sm leading-relaxed text-[var(--ink-2)]">{point}</span>
        </li>
      ))}
    </ol>
  );
}

export interface TileTab {
  id: string;
  label: string;
  /** 块上的大字：一个数，或者一枚章。 */
  value: ReactNode;
  /** 数字的颜色；不给就是墨色。 */
  tone?: Tone;
  /** 给读屏的完整说法，比如「高风险 3 条」；不给就读 value 和 label。 */
  summary?: string;
  body: ReactNode;
}

/** 分项块：选中的那块描墨线、带硬投影，下面是它的细节。 */
export function TileTabs({ label, tabs, numbered = false }: { label: string; tabs: TileTab[]; numbered?: boolean }) {
  const [picked, setPicked] = useState<string | null>(null);
  const active = tabs.find(tab => tab.id === picked) ?? tabs[0];
  if (!active) return null;
  return (
    <section aria-label={label}>
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
        {tabs.map((tab, index) => {
          const selected = tab.id === active.id;
          return (
            <button
              key={tab.id} type="button" role="tab" aria-selected={selected} aria-label={tab.summary ? `${tab.label}：${tab.summary}` : undefined}
              onClick={() => setPicked(tab.id)}
              className={`flex min-h-[76px] min-w-24 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border-[1.5px] px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${selected ? 'border-[var(--hard)] bg-[var(--paper)] shadow-hard' : 'border-transparent bg-[var(--inset)] hover:bg-[var(--hover)]'}`}
            >
              <span className="flex min-h-8 items-center font-human text-2xl font-semibold tabular-nums leading-8" style={{ color: tab.tone ? toneColor(tab.tone) : 'var(--ink)' }}>{tab.value}</span>
              <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                {numbered && <span className="tabular-nums text-[var(--subtle)]">{index + 1}</span>}
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={active.label} className="pt-5">{active.body}</div>
    </section>
  );
}
