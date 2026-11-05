/**
 * 题库：我们整理的 + 自己上传的。搜题先查这里，查到的答案比直接问模型准。
 * 上传后在后台拆题，列表里先显示「导入中」，拆完自动刷新。
 */
import { Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

import { Badge, Button, ErrorRow, Field, LoadingRow, TextInput } from '../CareerPrimitives';
import { useCareerAction, useCareerQuery } from '../useCareerData';
import { blobToBase64, examSearchApi, type ExamBank } from './examSearchApi';

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.webp';

function BankRow({ bank, onRemove }: { bank: ExamBank; onRemove: () => void }) {
  const where = [bank.company_name, bank.role_title, bank.year].filter(Boolean).join(' · ');
  return (
    <li className="group flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-[var(--ink)]">{bank.name}</span>
          <Badge tone={bank.origin === 'builtin' ? 'accent' : 'neutral'}>{bank.origin === 'builtin' ? '我们整理的' : '我上传的'}</Badge>
          {bank.status === 'importing' && <Badge tone="info">导入中</Badge>}
          {bank.status === 'failed' && <Badge tone="error">导入失败</Badge>}
        </div>
        <div className="truncate text-xs text-[var(--muted)]">
          {bank.status === 'failed' ? bank.error : [where, `${bank.item_count} 题`].filter(Boolean).join(' · ')}
        </div>
      </div>
      {bank.origin === 'user' && (
        <button type="button" aria-label={`删除题库 ${bank.name}`} onClick={onRemove} className="rounded p-1 text-[var(--subtle)] opacity-0 hover:text-[var(--danger)] group-hover:opacity-100">
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      )}
    </li>
  );
}

function UploadForm({ onDone }: { onDone: () => void }) {
  const [meta, setMeta] = useState({ company: '', role: '', year: '' });
  const fileInput = useRef<HTMLInputElement>(null);
  const action = useCareerAction();
  const upload = (file: File) => action.run(async () => {
    const year = Number.parseInt(meta.year, 10);
    await examSearchApi.importBank({
      file_name: file.name, data: await blobToBase64(file),
      company_name: meta.company.trim() || undefined, role_title: meta.role.trim() || undefined, year: Number.isInteger(year) ? year : undefined,
    });
    onDone();
  });
  return (
    <div>
      <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="公司（可不填）"><TextInput value={meta.company} placeholder="网易" onChange={e => setMeta(m => ({ ...m, company: e.target.value }))} /></Field>
        <Field label="岗位（可不填）"><TextInput value={meta.role} placeholder="交互设计" onChange={e => setMeta(m => ({ ...m, role: e.target.value }))} /></Field>
        <Field label="年份（可不填）"><TextInput value={meta.year} placeholder="2025" inputMode="numeric" onChange={e => setMeta(m => ({ ...m, year: e.target.value }))} /></Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" busy={action.busy} onClick={() => fileInput.current?.click()}><Upload className="h-3.5 w-3.5" />选文件上传</Button>
        <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" aria-label="选择题库文件"
          onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ''; }} />
      </div>
      {action.error && <div className="mt-2"><ErrorRow message={action.error} /></div>}
    </div>
  );
}

export function BankManager() {
  const query = useCareerQuery(examSearchApi.banks, ['exam_bank']);
  const action = useCareerAction();
  const banks = query.data ?? [];
  const remove = (bank: ExamBank) => {
    if (!window.confirm(`删除题库「${bank.name}」？里面 ${bank.item_count} 道题会一起删掉。`)) return;
    void action.run(async () => { await examSearchApi.removeBank(bank.id); query.reload(); });
  };
  return (
    <div className="space-y-4">
      <UploadForm onDone={query.reload} />
      {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
      {action.error && <ErrorRow message={action.error} />}
      {query.loading && !query.data && <LoadingRow />}
      {query.data && banks.length === 0 && (
        <p className="text-sm text-[var(--muted)]">还没有题库</p>
      )}
      <ul className="divide-y divide-[var(--line)]">
        {banks.map(bank => <BankRow key={bank.id} bank={bank} onRemove={() => remove(bank)} />)}
      </ul>
    </div>
  );
}
