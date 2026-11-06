/**
 * 邮件投递工作台的一列：一行一份。公司小签（底条颜色是状态）+ 公司名（主字）+ 岗位名（第二行小字），记号在行尾。
 * 等他过目的那几份公司名是钢笔蓝。开始条里的那一列能勾选（和岗位库同一套框选：Shift 连选、按住拖过几行）。
 */
import type { MailBoardRow } from '../../../../shared/careerMailApply';
import { CompanyPoster } from '../delivery/CompanyPoster';
import { useRangeSelect } from '../useRangeSelect';
import { isTrouble, STATION_POSTER } from './mailBoard';
import { RowMark } from './MailMarks';

export interface RowPick {
  picked: ReadonlySet<string>;
  setPicked: (next: Set<string>) => void;
}

/** 没有打包标志的公司：小签上只放名字的第一个字，名字本身在旁边那一行写（不在一行里把名字说两遍）。 */
const chipMark = (company: MailBoardRow['company']): MailBoardRow['company'] =>
  (company.logo ? company : { ...company, name: Array.from(company.name)[0] ?? company.name });

/** 公司小签；被退回、没发出去的带一个红点。 */
export function RowChip({ row }: { row: MailBoardRow }) {
  return (
    <span className="cm-chip-wrap">
      <CompanyPoster company={chipMark(row.company)} size="xs" state={STATION_POSTER[row.station]} />
      {isTrouble(row) && <i className="cm-red-dot" aria-hidden />}
    </span>
  );
}

function Line({ row, current, pick, sel, onShow }: {
  row: MailBoardRow; current: boolean; pick?: RowPick; sel: ReturnType<typeof useRangeSelect>; onShow?: (key: string) => void;
}) {
  const checked = !!pick && pick.picked.has(row.key);
  const waiting = row.station === 'waiting';
  return (
    <li className={`cm-line${current ? ' is-current' : ''}${waiting ? ' is-waiting' : ''}`} data-testid={`mail-line-${row.key}`}>
      {pick && (
        <span className="cm-line-box" onMouseDown={() => sel.pressStart(row.key)} onMouseEnter={() => sel.dragOver(row.key)}>
          <input type="checkbox" aria-label={`选 ${row.company.name} ${row.role}`} checked={checked} readOnly onClick={e => sel.click(row.key, e.shiftKey)} />
        </span>
      )}
      <button type="button" className="cm-line-main" aria-current={current || undefined} onClick={() => (onShow ? onShow(row.key) : sel.click(row.key, false))}>
        <RowChip row={row} />
        <span className="cm-line-name">
          <span className="cm-line-co">{row.company.name}</span>
          <span className="cm-line-role">{row.role}</span>
        </span>
        <span className="cm-line-mark"><RowMark row={row} /></span>
      </button>
    </li>
  );
}

export function MailRowList({ rows, label, current = null, onShow, pick }: {
  rows: readonly MailBoardRow[]; label: string; current?: string | null; onShow?: (key: string) => void; pick?: RowPick;
}) {
  const ids = pick ? rows.map(r => r.key) : [];
  const sel = useRangeSelect(ids, pick?.picked ?? new Set(), next => pick?.setPicked(next));
  return (
    <ul className="cm-lines" aria-label={label}>
      {rows.map(row => <Line key={row.key} row={row} current={row.key === current} pick={pick} sel={sel} onShow={onShow} />)}
    </ul>
  );
}
