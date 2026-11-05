/**
 * 方向探索（direction-explore）的成果：几个方向并排成路牌，点哪个看哪个的依据、还差什么、拿不准的地方、怎么验证；状态由用户自己标。
 * 提示词前后几版字段名不一样（fit_reasons / reason / rationale / evidence…），这里都认。
 */
import { useState } from 'react';

import { careerApi } from '../../careerApi';
import { DIRECTION_STATUSES, DIRECTION_STATUS_LABELS } from '../../careerConstants';
import { Button } from '../../CareerPrimitives';
import type { Direction } from '../../types';
import { useCareerAction } from '../../useCareerData';
import { dict, parseJson, texts, type Dict } from '../read';
import { Stamp, toneColor, type Tone } from '../visual';

import { Bullets } from './parts';

const STATUS_TONE: Record<Direction['status'], Tone> = { candidate: 'neutral', tentative: 'info', chosen: 'success', dropped: 'neutral' };

/** 依次试几个字段，取第一组有内容的要点。 */
function firstTexts(source: Dict, ...keys: string[]): string[] {
  for (const key of keys) {
    const found = texts(source[key]);
    if (found.length) return found;
  }
  return [];
}

function StatusButtons({ direction, onChanged }: { direction: Direction; onChanged: () => void }) {
  const action = useCareerAction();
  const setStatus = (status: Direction['status']) => action.run(async () => {
    await careerApi.setDirectionStatus(direction.id, status);
    onChanged();
  });
  return (
    <div>
      {action.error && <div role="alert" className="mb-2 text-xs text-[var(--danger)]">{action.error}</div>}
      <div className="flex flex-wrap gap-2">
        {DIRECTION_STATUSES.filter(status => status !== direction.status).map(status => (
          <Button key={status} size="sm" variant={status === 'dropped' ? 'ghost' : 'secondary'} busy={action.busy} onClick={() => void setStatus(status)}>
            {status === 'dropped' ? '放弃' : `设为${DIRECTION_STATUS_LABELS[status]}`}
          </Button>
        ))}
      </div>
    </div>
  );
}

type Rationale = { titles: string[]; fits: string[]; gaps: string[]; unsure: string[]; validate: string[] };

function rationaleOf(direction: Direction): Rationale {
  const parsed = parseJson(direction.rationale_json, `direction ${direction.id}.rationale_json`);
  // 旧数据里整段理由就是一句话
  const source = typeof parsed === 'string' ? { reason: parsed } : dict(parsed);
  return {
    titles: firstTexts(source, 'typical_titles', 'typical_jd'),
    fits: firstTexts(source, 'fit_reasons', 'reason', 'rationale', 'why', 'evidence'),
    gaps: firstTexts(source, 'gaps'),
    unsure: firstTexts(source, 'uncertainty', 'uncertainties', 'risks'),
    validate: firstTexts(source, 'how_to_validate'),
  };
}

/** 一排小圆点：有几条就几颗。 */
function Tally({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]" role="img" aria-label={`${label} ${count} 条`}>
      {label}
      <span className="inline-flex gap-0.5">
        {Array.from({ length: count }, (_, index) => <span key={index} className="h-2 w-2 rounded-full" style={{ background: toneColor(tone) }} />)}
      </span>
    </span>
  );
}

/** 一个方向一张路牌：状态章、方向名、常见岗位名，下面两排圆点是「对得上几条 / 还差几条」。 */
function DirectionCard({ direction, rationale, selected, onPick }: { direction: Direction; rationale: Rationale; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button" role="tab" aria-selected={selected} aria-label={`${direction.name}：${DIRECTION_STATUS_LABELS[direction.status] ?? direction.status}`} onClick={onPick}
      className={`flex min-w-0 flex-col items-start gap-2 rounded-lg border-[1.5px] p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${selected ? 'border-[var(--hard)] bg-[var(--paper)] shadow-hard' : 'border-transparent bg-[var(--inset)] hover:bg-[var(--hover)]'} ${direction.status === 'dropped' ? 'opacity-60' : ''}`}
    >
      <Stamp tone={STATUS_TONE[direction.status] ?? 'neutral'}>{DIRECTION_STATUS_LABELS[direction.status] ?? direction.status}</Stamp>
      <span className="w-full min-w-0">
        <span className="block font-human text-lg font-semibold leading-snug text-[var(--ink)]">{direction.name}</span>
        {rationale.titles.length > 0 && <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">{rationale.titles.join(' / ')}</span>}
      </span>
      <span className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-1">
        <Tally label="对得上" count={rationale.fits.length} tone="success" />
        <Tally label="还差" count={rationale.gaps.length} tone="warning" />
      </span>
    </button>
  );
}

/**
 * 他是没方向、或者投了没回音时来的，最想知道的是「有哪几条路、哪条更适合我」。
 * 第一层：几个方向并排成路牌，一眼比出哪条对得上的多、差的少；
 * 第二层：点哪个方向，下面摊开它的依据、差距、拿不准的地方和怎么验证，状态由他自己标。
 */
export function DirectionList({ directions, onChanged }: { directions: Direction[]; onChanged: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const active = directions.find(direction => direction.id === picked) ?? directions[0];
  if (!active) return null;
  const rationale = rationaleOf(active);
  return (
    <section aria-label="看过的方向">
      <div role="tablist" aria-label="看过的方向" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {directions.map(direction => (
          <DirectionCard key={direction.id} direction={direction} rationale={rationaleOf(direction)} selected={direction.id === active.id} onPick={() => setPicked(direction.id)} />
        ))}
      </div>
      <div role="tabpanel" aria-label={active.name} className="space-y-5 pt-5">
        <div className="grid grid-cols-1 gap-x-10 gap-y-5 md:grid-cols-2">
          <Bullets label="为什么适合你" items={rationale.fits} />
          <Bullets label="还差什么" items={rationale.gaps} />
          <Bullets label="拿不准的地方" items={rationale.unsure} />
          <Bullets label="怎么验证" items={rationale.validate} />
        </div>
        <StatusButtons direction={active} onChanged={onChanged} />
      </div>
    </section>
  );
}
