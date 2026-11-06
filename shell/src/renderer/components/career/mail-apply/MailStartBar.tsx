/**
 * 邮件投递工作台顶上的开始条（功能市场已确认的「选一下、点一下」）：
 *  - 选岗位：库里写了投递邮箱、还没投的岗位，一家公司默认只勾一个；收着时按钮上就是勾上的那几家的公司小签，点开是一列可勾选的；
 *  - 主按钮「写这 N 封」；还没有简历时是「先放一份简历」（还差什么用控件说，同没连邮箱时的「连邮箱」）；
 *  - 旁边一格把库里没有的岗位贴进来，里面得明写投递邮箱。
 */
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { requestNavigation } from '@/features/career-shell/navModel';

import type { MailBoardRow } from '../../../../shared/careerMailApply';
import { careerApi } from '../careerApi';
import { Button } from '../CareerPrimitives';
import { CompanyPoster } from '../delivery/CompanyPoster';
import { useFieldSave } from './MailFields';
import { mailApplyApi } from './mailApplyApi';
import { defaultReadyPicks } from './mailBoard';
import { MailRowList } from './MailRowList';

/** 按钮上最多摆几个公司小签；再多收成「+N」（真数）。 */
const CHIP_MAX = 4;

function PasteBox({ onAdded }: { onAdded: (row: MailBoardRow) => void }) {
  const [text, setText] = useState('');
  const save = useFieldSave('mail-paste');
  const add = () => void save.run(async () => { const row = await mailApplyApi.pasteJob(text.trim()); setText(''); onAdded(row); });
  return (
    <div className="cm-paste">
      <input className="cm-paste-box" aria-label="贴一段写着投递邮箱的岗位" placeholder="贴一段写着投递邮箱的岗位"
        value={text} disabled={save.saving} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) add(); }} />
      <Button disabled={!text.trim() || save.saving} busy={save.saving} onClick={add}>加进来</Button>
      {save.error && <p role="alert" className="cd-err cm-paste-err">{save.error}</p>}
    </div>
  );
}

/** 收着时：勾上的那几家的公司小签；一家没勾时是「选岗位」。 */
function PickedChips({ rows, open, onToggle }: { rows: MailBoardRow[]; open: boolean; onToggle: () => void }) {
  const shown = rows.slice(0, CHIP_MAX);
  return (
    <button type="button" className="cm-pick-toggle" aria-expanded={open} aria-label={`选岗位：已勾 ${rows.length} 家`} onClick={onToggle}>
      {shown.length ? shown.map(r => <CompanyPoster key={r.key} company={r.company} size="xs" state="wait" />) : <span>选岗位</span>}
      {rows.length > CHIP_MAX && <span className="cm-pile-more">+{rows.length - CHIP_MAX}</span>}
      <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
    </button>
  );
}

export function MailStartBar({ rows, hasResume, defaultOpen = false, onWritten, onChanged }: {
  rows: MailBoardRow[]; hasResume: boolean; defaultOpen?: boolean; onWritten: () => void; onChanged: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => defaultReadyPicks(rows));
  const [open, setOpen] = useState(defaultOpen);
  const save = useFieldSave('mail-write');
  const chosen = rows.filter(r => picked.has(r.key));
  const added = (row: MailBoardRow) => { setPicked(p => new Set(p).add(row.key)); onChanged(); };
  const write = () => void save.run(async () => { await careerApi.applyJobs(chosen.map(r => r.job_id)); setOpen(false); onWritten(); });
  return (
    <section className="cm-start" aria-label="开始投">
      <div className="cm-start-row">
        {rows.length > 0 && <PickedChips rows={chosen} open={open} onToggle={() => setOpen(o => !o)} />}
        {rows.length > 0 && (hasResume
          ? <Button variant="primary" disabled={!chosen.length || save.saving} busy={save.saving} onClick={write}>写这 {chosen.length} 封</Button>
          : <Button variant="primary" onClick={() => requestNavigation({ kind: 'career-material', view: 'resume' })}>先放一份简历</Button>)}
        <PasteBox onAdded={added} />
      </div>
      {save.error && <p role="alert" className="cd-err">{save.error}</p>}
      {open && rows.length > 0 && <div className="cm-start-list"><MailRowList rows={rows} label="可以投的岗位" pick={{ picked, setPicked }} /></div>}
    </section>
  );
}
