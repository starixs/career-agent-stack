/**
 * 方向探索（direction-explore）的成果：每个方向的依据、还差什么、拿不准的地方、怎么验证；状态由用户自己标。
 * 提示词前后几版字段名不一样（fit_reasons / reason / rationale / evidence…），这里都认。
 */
import { careerApi } from '../../careerApi';
import { DIRECTION_STATUSES, DIRECTION_STATUS_LABELS } from '../../careerConstants';
import { Badge, Button, type BadgeTone } from '../../CareerPrimitives';
import type { Direction } from '../../types';
import { useCareerAction } from '../../useCareerData';
import { dict, parseJson, texts, type Dict } from '../read';

import { Bullets, Disclosure, ResultList } from './parts';

const STATUS_TONE: Record<Direction['status'], BadgeTone> = { candidate: 'neutral', tentative: 'info', chosen: 'success', dropped: 'neutral' };

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

function DirectionRow({ direction, onChanged }: { direction: Direction; onChanged: () => void }) {
  const parsed = parseJson(direction.rationale_json, `direction ${direction.id}.rationale_json`);
  // 旧数据里整段理由就是一句话
  const rationale = typeof parsed === 'string' ? { reason: parsed } : dict(parsed);
  const titles = firstTexts(rationale, 'typical_titles', 'typical_jd');
  return (
    <Disclosure
      summary={(
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[var(--ink)]">{direction.name}</span>
            {titles.length > 0 && <span className="block truncate text-xs text-[var(--muted)]">{titles.join(' / ')}</span>}
          </span>
          <Badge tone={STATUS_TONE[direction.status] ?? 'neutral'}>{DIRECTION_STATUS_LABELS[direction.status] ?? direction.status}</Badge>
        </span>
      )}
    >
      <Bullets label="为什么适合你" items={firstTexts(rationale, 'fit_reasons', 'reason', 'rationale', 'why', 'evidence')} />
      <Bullets label="还差什么" items={firstTexts(rationale, 'gaps')} />
      <Bullets label="拿不准的地方" items={firstTexts(rationale, 'uncertainty', 'uncertainties', 'risks')} />
      <Bullets label="怎么验证" items={firstTexts(rationale, 'how_to_validate')} />
      <StatusButtons direction={direction} onChanged={onChanged} />
    </Disclosure>
  );
}

export function DirectionList({ directions, onChanged }: { directions: Direction[]; onChanged: () => void }) {
  return (
    <ResultList label="看过的方向">
      {directions.map(direction => <DirectionRow key={direction.id} direction={direction} onChanged={onChanged} />)}
    </ResultList>
  );
}
