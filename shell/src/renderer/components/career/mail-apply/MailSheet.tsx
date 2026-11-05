/**
 * 一封待发邮件的整张预览（face-mail-apply §3.1）：看到的就是发出去的。
 * 自上而下：到岗点选（实习且没说全时）·（回信）对方那封 · 收件人 · 「接着那封」· 标题 · 正文 · 附件 · 发件。每格都能就地改，失焦即存。
 * 不写规则说明（规范 §6.0）；还不能发的原因只体现在主按钮和标红的那一格上。
 */
import { Paperclip } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { InternAvailability, MailDraftPatch, MailDraftView } from '../../../../shared/careerMailApply';
import { Select } from '../CareerPrimitives';
import { openResumeDrawer } from '../CareerResumeDrawer';
import { AvailabilityRow, availabilityComplete, TextField, useFieldSave } from './MailFields';
import { MailQuote } from './MailQuote';

import './mail-apply.css';

/** 资料里没填上的占位符（服务端解析不出时原样留着）：在哪一格就标哪一格。 */
const UNRESOLVED = /\{\{\s*vault:/;

/** 「接着 11月3日 那封」：只要日子。 */
export function threadDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}月${d.getDate()}日`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="cm-row"><span className="cm-label">{label}</span><div className="cm-val">{children}</div></div>;
}

type Patch = (p: MailDraftPatch) => Promise<unknown>;

/** 回信默认不带附件：一个安静的「附上简历」；只有一份可选就直接附上，几份就展开选哪份。 */
function AttachResume({ options, onPatch }: { options: MailDraftView['resume_options']; onPatch: Patch }) {
  const save = useFieldSave('resume');
  const [choosing, setChoosing] = useState(false);
  const attach = (id: string) => void save.run(() => onPatch({ resume_id: id }));
  return (
    <Row label="附件">
      {choosing
        ? <span className="cm-swap"><Select ariaLabel="附上哪份简历" value="" placeholder="选一份" disabled={save.saving}
            options={options.map(o => ({ value: o.id, label: o.label }))} onChange={attach} /></span>
        : <button type="button" className="cm-attach" disabled={save.saving}
            onClick={() => (options.length === 1 ? attach(options[0].id) : setChoosing(true))}>附上简历</button>}
      {save.error && <p role="alert" className="cd-err">{save.error}</p>}
    </Row>
  );
}

function AttachedFiles({ draft, onPatch }: { draft: MailDraftView; onPatch: Patch }) {
  const save = useFieldSave('resume');
  const others = draft.resume_options.filter(o => !draft.attachments.some(a => a.resume_id === o.id));
  return (
    <Row label="附件">
      <div className="cm-files">
        {draft.attachments.map(a => (
          <button key={a.filename} type="button" className="cm-file" title={a.filename} disabled={!a.resume_id} onClick={() => openResumeDrawer(a.resume_id)}
            aria-label={`看附件 ${a.filename}`}>
            <Paperclip className="cm-file-icon" aria-hidden />
            <span className="cm-file-name">{a.filename}</span>
            <span className="cm-file-note">{a.tailored_changes === null ? '主简历' : `按岗位改了 ${a.tailored_changes} 处`}</span>
          </button>
        ))}
        {draft.resume_options.length > 1 && (
          <span className="cm-swap">
            <Select ariaLabel="换一份简历" value="" placeholder="换一份" disabled={save.saving}
              options={others.map(o => ({ value: o.id, label: o.label }))} onChange={id => void save.run(() => onPatch({ resume_id: id }))} />
          </span>
        )}
      </div>
      {save.error && <p role="alert" className="cd-err">{save.error}</p>}
    </Row>
  );
}

/** 有附件：文件签 + 换一份；没附件但有简历可附：「附上简历」；都没有：这一行不出现。 */
function AttachmentRow({ draft, onPatch }: { draft: MailDraftView; onPatch: Patch }) {
  if (draft.attachments.length) return <AttachedFiles draft={draft} onPatch={onPatch} />;
  return draft.resume_options.length ? <AttachResume options={draft.resume_options} onPatch={onPatch} /> : null;
}

function FromRow({ draft, onPatch }: { draft: MailDraftView; onPatch: (p: MailDraftPatch) => Promise<unknown> }) {
  const save = useFieldSave('account');
  if (!draft.from) return null;
  return (
    <div className="cm-row cm-from">
      <span className="cm-label">发件</span>
      <div className="cm-val">
        {draft.accounts.length > 1
          ? <span className="cm-from-pick"><Select ariaLabel="从哪个邮箱发" value={draft.from.account_id} disabled={save.saving}
              options={draft.accounts.map(a => ({ value: a.account_id, label: a.address }))} onChange={id => void save.run(() => onPatch({ account_id: id }))} /></span>
          : <span>{draft.from.address}</span>}
        {save.error && <p role="alert" className="cd-err">{save.error}</p>}
      </div>
    </div>
  );
}

export function MailSheet({ draft, onPatch, onAvailability }: {
  draft: MailDraftView;
  onPatch: (patch: MailDraftPatch) => Promise<unknown>;
  onAvailability: (value: InternAvailability) => Promise<unknown>;
}) {
  const unresolved = draft.blockers.includes('unresolved');
  const askAvailability = !!draft.availability && !availabilityComplete(draft.availability);
  return (
    <div className={`cm-sheet${askAvailability ? ' has-avail' : ''}`} data-testid={`mail-sheet-${draft.action_id}`}>
      {draft.availability && askAvailability && <AvailabilityRow value={draft.availability} onSave={onAvailability} />}
      {draft.incoming && <MailQuote incoming={draft.incoming} />}
      <Row label="收件人">
        <TextField label="收件人" value={draft.to} invalid={draft.blockers.includes('bad_recipient')} onSave={to => onPatch({ to })} />
      </Row>
      {/* 回信顶上已经引了对方那封，「接着哪封」不再重复说 */}
      {draft.thread && !draft.incoming && <p className="cm-thread">接着 {threadDate(draft.thread.sent_at)} 那封</p>}
      <Row label="标题">
        <TextField label="标题" value={draft.subject} invalid={unresolved && UNRESOLVED.test(draft.subject)} onSave={subject => onPatch({ subject })} />
      </Row>
      <TextField label="正文" multiline value={draft.body} invalid={unresolved && UNRESOLVED.test(draft.body)} onSave={body => onPatch({ body })} />
      <AttachmentRow draft={draft} onPatch={onPatch} />
      <FromRow draft={draft} onPatch={onPatch} />
    </div>
  );
}
