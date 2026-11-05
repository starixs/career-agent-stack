/**
 * 几封一起过目时左边那一列：一行一封（公司 · 岗位，标星的带星），默认全勾。
 * 勾选和岗位库同一套框选（useRangeSelect：Shift 点连选、按住拖过几行）；点行本身是切到右边看那一封。
 * 还差东西的那封行尾一个小点。
 */
import type { MailDraftView } from '../../../../shared/careerMailApply';
import { useRangeSelect } from '../useRangeSelect';

function PickLine({ draft, checked, current, pick, onShow }: {
  draft: MailDraftView; checked: boolean; current: boolean; pick: ReturnType<typeof useRangeSelect>; onShow: (id: string) => void;
}) {
  const id = draft.action_id;
  const name = `${draft.company} · ${draft.role}`;
  return (
    <li className={`cm-pick${current ? ' is-current' : ''}${checked ? '' : ' is-off'}`} data-testid={`mail-row-${id}`}>
      <span className="cm-pick-box" onMouseDown={() => pick.pressStart(id)} onMouseEnter={() => pick.dragOver(id)}>
        <input type="checkbox" aria-label={`发 ${name}`} checked={checked} readOnly onClick={e => pick.click(id, e.shiftKey)} />
      </span>
      <button type="button" className="cm-pick-name" aria-current={current || undefined} onClick={() => onShow(id)}>
        {draft.target && <i className="cm-star" aria-label="目标">★</i>}
        <span className="cm-pick-co">{draft.company}</span>
        <span className="cm-pick-role">{draft.role}</span>
        {draft.blockers.length > 0 && <i className="cm-dot" aria-label="还差东西" />}
      </button>
    </li>
  );
}

export function MailPickList({ drafts, picked, setPicked, current, onShow }: {
  drafts: readonly MailDraftView[]; picked: ReadonlySet<string>; setPicked: (next: Set<string>) => void;
  current: string | null; onShow: (id: string) => void;
}) {
  const ids = drafts.map(d => d.action_id);
  const pick = useRangeSelect(ids, picked, setPicked);
  return (
    <ul className="cm-picks" aria-label="这几封">
      {drafts.map(d => (
        <PickLine key={d.action_id} draft={d} checked={picked.has(d.action_id)} current={d.action_id === current} pick={pick} onShow={onShow} />
      ))}
    </ul>
  );
}
