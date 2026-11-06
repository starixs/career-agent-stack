/**
 * 邮件预览的附件那一行（R1）：几个文件签（简历 + 作品集 + 成绩单…），每个文件能拿掉；
 * 存过的文件排在后面，点一下附上（能做一次就不再做）；末尾安静的「加附件」。
 * 岗位描述要作品集 / 成绩单而这封还没带上：钢笔蓝的「加作品集」「加成绩单」（控件，不拦发出）。
 * 正文里带着作品集链接那一行时有「作品集链接」签，点了去掉；有链接没带时签是灰的，点了带上。
 */
import { Paperclip, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import {
  MAIL_FILE_EXTENSIONS, MAIL_FILE_MAX_BYTES,
  type MailAttachmentView, type MailDraftPatch, type MailDraftView, type MailFileUpload,
} from '../../../../shared/careerMailApply';
import { Select } from '../CareerPrimitives';
import { openResumeDrawer } from '../CareerResumeDrawer';
import { readAsBase64 } from '../fileBase64';
import { useFieldSave } from './MailFields';

export type Patch = (p: MailDraftPatch) => Promise<unknown>;
export type Upload = (u: Omit<MailFileUpload, 'action_id'>) => Promise<unknown>;
type Act = (fn: () => Promise<unknown>) => void;

const MB = 1024 * 1024;
const ACCEPT = MAIL_FILE_EXTENSIONS.map(e => `.${e}`).join(',');
const HTTP_URL = /^https?:\/\/\S+$/i;

/** 上传前先挡一道（服务端还会再查）：返回给他看的一句，能传返回 null。 */
export function checkMailFile(file: { name: string; size: number }): string | null {
  const ext = file.name.includes('.') ? (file.name.split('.').at(-1) ?? '').toLowerCase() : '';
  if (!(MAIL_FILE_EXTENSIONS as readonly string[]).includes(ext)) return '这种文件发不了';
  if (file.size > MAIL_FILE_MAX_BYTES) return `文件超过 ${MAIL_FILE_MAX_BYTES / MB}MB，换成链接更合适`;
  return null;
}

/** 选一个本地文件：一个看得见的按钮 + 藏起来的文件框。 */
export function PickFile({ className, children, disabled, onFile }: { className: string; children: ReactNode; disabled: boolean; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => input.current?.click()}>{children}</button>
      <input ref={input} type="file" accept={ACCEPT} hidden aria-hidden tabIndex={-1}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
    </>
  );
}

function ResumeChip({ a }: { a: MailAttachmentView }) {
  return (
    <button type="button" className="cm-file" title={a.filename} disabled={!a.resume_id} onClick={() => openResumeDrawer(a.resume_id)} aria-label={`看附件 ${a.filename}`}>
      <Paperclip className="cm-file-icon" aria-hidden />
      <span className="cm-file-name">{a.filename}</span>
      <span className="cm-file-note">{a.tailored_changes === null ? '主简历' : `按岗位改了 ${a.tailored_changes} 处`}</span>
    </button>
  );
}

/** 存过的文件附在这封上：名字 + 悬停 / 聚焦才出现的「拿掉」。 */
function FileChip({ a, busy, act, onPatch }: { a: MailAttachmentView; busy: boolean; act: Act; onPatch: Patch }) {
  return (
    <span className="cm-file cm-chip" title={a.filename}>
      <Paperclip className="cm-file-icon" aria-hidden />
      <span className="cm-file-name">{a.resume_label || a.filename}</span>
      <button type="button" className="cm-chip-x" disabled={busy} aria-label={`拿掉 ${a.resume_label || a.filename}`}
        onClick={() => act(() => onPatch({ remove_attachment_id: a.id }))}><X aria-hidden />拿掉</button>
    </span>
  );
}

/** 换简历 / 附上简历：有简历附件且不止一份可选时「换一份」；没带简历时安静的「附上简历」。 */
function ResumePick({ draft, busy, act, onPatch }: { draft: MailDraftView; busy: boolean; act: Act; onPatch: Patch }) {
  const [choosing, setChoosing] = useState(false);
  const has = draft.attachments.some(a => a.kind === 'resume');
  const options = draft.resume_options.filter(o => !draft.attachments.some(a => a.resume_id === o.id));
  const pick = (id: string) => act(() => onPatch({ resume_id: id }));
  if (has && draft.resume_options.length > 1) {
    return <span className="cm-swap"><Select ariaLabel="换一份简历" value="" placeholder="换一份" disabled={busy} options={options.map(o => ({ value: o.id, label: o.label }))} onChange={pick} /></span>;
  }
  if (has || !options.length) return null;
  if (choosing) {
    return <span className="cm-swap"><Select ariaLabel="附上哪份简历" value="" placeholder="选一份" disabled={busy} options={options.map(o => ({ value: o.id, label: o.label }))} onChange={pick} /></span>;
  }
  return <button type="button" className="cm-attach" disabled={busy} onClick={() => (options.length === 1 ? pick(options[0].id) : setChoosing(true))}>附上简历</button>;
}

/** 作品集链接签：带着时可取消；有链接没带时灰的、点了带上。岗位要作品集时由「加作品集」管，这里不重复出。 */
function PortfolioChip({ draft, busy, act, onPatch }: { draft: MailDraftView; busy: boolean; act: Act; onPatch: Patch }) {
  const { url, included } = draft.portfolio;
  if (included) {
    return (
      <span className="cm-file cm-chip" title={url ?? undefined}>
        <span className="cm-file-name">作品集链接</span>
        <button type="button" className="cm-chip-x is-shown" disabled={busy} aria-label="去掉作品集链接" onClick={() => act(() => onPatch({ include_portfolio: false }))}><X aria-hidden /></button>
      </span>
    );
  }
  if (!url || draft.wanted.includes('portfolio')) return null;
  return <button type="button" className="cm-opt" disabled={busy} title={url} onClick={() => act(() => onPatch({ include_portfolio: true }))}>+ 作品集链接</button>;
}

/** 「加作品集」：资料里有链接就一点带上；没有就原地贴链接（存进资料，以后不再问）或选文件。 */
function WantPortfolio({ draft, busy, act, onPatch, onFile }: { draft: MailDraftView; busy: boolean; act: Act; onPatch: Patch; onFile: (f: File, label: string) => void }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState('');
  const save = () => act(async () => {
    const v = link.trim();
    if (!HTTP_URL.test(v)) throw new Error('这不像一个网址');
    await onPatch({ portfolio_url: v });
  });
  if (draft.portfolio.url) return <button type="button" className="cm-want" disabled={busy} onClick={() => act(() => onPatch({ include_portfolio: true }))}>加作品集</button>;
  if (!open) return <button type="button" className="cm-want" disabled={busy} onClick={() => setOpen(true)}>加作品集</button>;
  return (
    <span className="cm-want-open">
      <input className="cm-link" type="url" autoFocus aria-label="作品集链接" placeholder="贴作品集链接" value={link} disabled={busy}
        onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); }} />
      <button type="button" className="cm-want" disabled={busy || !link.trim()} onClick={save}>带上</button>
      <PickFile className="cm-attach" disabled={busy} onFile={f => onFile(f, '作品集')}>选文件</PickFile>
    </span>
  );
}

export function AttachmentRow({ draft, onPatch, onUpload }: { draft: MailDraftView; onPatch: Patch; onUpload: Upload }) {
  const save = useFieldSave('attachments');
  const act: Act = fn => void save.run(fn);
  const busy = save.saving;
  const onFile = (file: File, label?: string) => act(async () => {
    const bad = checkMailFile(file);
    if (bad) throw new Error(bad);
    await onUpload({ name: file.name, base64: await readAsBase64(file), ...(label ? { label } : {}) });
  });
  const p = { draft, busy, act, onPatch };
  return (
    <div className="cm-row">
      <span className="cm-label">附件</span>
      <div className="cm-val">
        <div className="cm-files is-wrap" data-testid="mail-attachments">
          {/* 简历和「换一份」挨着（F2），存过的文件跟在后面 */}
          <span className="cm-files-resume">
            {draft.attachments.filter(a => a.kind === 'resume').map(a => <ResumeChip key={a.id} a={a} />)}
            <ResumePick {...p} />
          </span>
          {draft.attachments.filter(a => a.kind === 'file').map(a => <FileChip key={a.id} a={a} busy={busy} act={act} onPatch={onPatch} />)}
          <PortfolioChip {...p} />
          {draft.file_options.map(f => <button key={f.id} type="button" className="cm-opt" disabled={busy} onClick={() => act(() => onPatch({ add_file_id: f.id }))}>+ {f.label}</button>)}
          {draft.wanted.includes('portfolio') && <WantPortfolio {...p} onFile={onFile} />}
          {draft.wanted.includes('transcript') && <PickFile className="cm-want" disabled={busy} onFile={f => onFile(f, '成绩单')}>加成绩单</PickFile>}
          <PickFile className="cm-attach" disabled={busy} onFile={f => onFile(f)}>加附件</PickFile>
        </div>
        {save.error && <p role="alert" className="cd-err">{save.error}</p>}
      </div>
    </div>
  );
}
