/**
 * 我的求职 › 助力记录：笔试、测评、面试、模拟面试、笔试练习一张表（行的合并规则见 assistRecords.ts）。
 * 最后一列「助力」把这一条交给助理；整行点开对应的投递档案。
 *
 * 右上角「新建」三种入口（2026-10-13 会议定）：手动填表、粘贴招聘平台的分享链接、从邮箱同步。
 * 邮箱没绑定时引导绑定，绑定了就给一个同步按钮（低频，用户自己点）。
 */
import { Mail, Plus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { requestNavigation } from '@/features/career-shell/navModel';
import { expandWorkSurface } from '@/features/career-shell/workSurfaceStore';
import { useCloseLayer } from '@/hooks/useCloseLayer';

import { ASSIST_TYPE_LABELS, assistRecords, filterAssists, type AssistFilter, type AssistRow } from './assistModel';
import { careerApi } from './careerApi';
import { INTERVIEW_ROUND_LABELS } from './careerConstants';
import { Badge, Button, EmptyState, ErrorRow, Field, LoadingRow, Select, TextArea, TextInput, formatDate, textOrUnknown, useSuggestToChat } from './CareerPrimitives';
import type { CareerFocusEvent, IntakeResult, MailAccount, MailPreset } from './types';
import { BindMailForm, MailAccountRow } from './MailBinding';
import { useCareerAction, useCareerQuery } from './useCareerData';

const ASSIST_TABLES = ['deadline', 'application', 'job', 'interview', 'mock_interview', 'exam_practice', 'mail_account'] as const;
const FILTERS: Array<{ id: AssistFilter; label: string }> = [
  { id: 'all', label: '全部' }, { id: 'exam', label: '笔试' }, { id: 'interview', label: '面试' }, { id: 'mock', label: '模拟面试' },
];

// ─── 从别的页面（功能市场的「笔试助力」）带筛选跳进来 ───

const ASSIST_FILTER_EVENT = 'career:assist-filter';
let pendingFilter: AssistFilter | null = null;

/** 打开助力记录前调用：页面已挂载时立刻切换，没挂载时挂载后取用。 */
export function requestAssistFilter(filter: AssistFilter): void {
  pendingFilter = filter;
  emitEvent(ASSIST_FILTER_EVENT, filter);
}

function takePendingFilter(): AssistFilter | null {
  const f = pendingFilter;
  pendingFilter = null;
  return f;
}

async function loadAssists() {
  const [deadlines, dossiers, interviews, mocks, practices, mail] = await Promise.all([
    careerApi.deadlines(),
    careerApi.dossiers().catch(() => []),
    careerApi.interviews().catch(() => []),
    careerApi.mockInterviews().catch(() => []),
    careerApi.examPractices().catch(() => []),
    careerApi.mailAccounts().catch(() => ({ accounts: [] as MailAccount[], presets: {} as Record<string, MailPreset> })),
  ]);
  return { rows: assistRecords({ deadlines, dossiers, interviews, mocks, practices }), mail };
}

/** 本地时区的「10 月 15 日 14:00」。 */
function formatLocalDateTime(iso: string | null): string {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (iso.length <= 10) return formatDate(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function AssistRecords() {
  const query = useCareerQuery(loadAssists, ASSIST_TABLES);
  const [filter, setFilter] = useState<AssistFilter>(() => takePendingFilter() ?? 'all');
  const [dialog, setDialog] = useState<NewMethod | null>(null);
  const sync = useCareerAction();
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const suggest = useSuggestToChat();

  useEffect(() => onEvent<AssistFilter>(ASSIST_FILTER_EVENT, f => { takePendingFilter(); setFilter(f); }), []);

  const allRows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const rows = useMemo(() => filterAssists(allRows, filter), [allRows, filter]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.id, filterAssists(allRows, f.id).length])) as Record<AssistFilter, number>, [allRows]);
  const accounts = query.data?.mail.accounts ?? [];

  const syncMail = () => sync.run(async () => {
    const results = await careerApi.syncMail();
    const fetched = results.reduce((n, r) => n + r.fetched, 0);
    const related = results.reduce((n, r) => n + r.job_related, 0);
    const failed = results.find(r => r.error);
    setSyncNote(failed ? `同步失败：${failed.error}` : `拉到 ${fetched} 封，${related} 封与求职相关；识别出的笔试 / 面试已经加进来了`);
    query.reload();
  });

  const assist = (row: AssistRow) => {
    const refs = { application_id: row.application_id };
    const company = row.company_name ?? '这家公司';
    switch (row.type) {
      case 'written_test':
      case 'assessment':
        suggest(`帮我准备${company}的${ASSIST_TYPE_LABELS[row.type]}`, { surface: 'dossier', refs: { ...refs, deadline_id: row.id } });
        return;
      case 'interview':
        suggest(`帮我准备${company}的这场面试`, { surface: 'dossier', refs: { ...refs, interview_id: row.id } });
        return;
      case 'mock_interview':
        expandWorkSurface('mock-interview', { refId: row.id });
        requestNavigation({ kind: 'chat' });
        return;
      case 'exam_practice':
        expandWorkSurface('exam', { refId: row.id });
        requestNavigation({ kind: 'chat' });
    }
  };
  const openDossier = (row: AssistRow) => {
    if (row.application_id) emitEvent('career:focus', { surface: 'dossier', application_id: row.application_id, origin: 'user' } satisfies CareerFocusEvent);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div role="group" aria-label="按类型筛选" className="flex flex-wrap items-center gap-1">
          {FILTERS.map(f => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`h-7 rounded-full px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${filter === f.id ? 'bg-[var(--ink)] font-medium text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
            >
              {f.label} <span className="tabular-nums">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {query.data && (accounts.length > 0
          ? <Button variant="ghost" busy={sync.busy} onClick={() => void syncMail()}><RefreshCw className="h-4 w-4" strokeWidth={1.75} />同步邮箱</Button>
          : <Button variant="ghost" onClick={() => setDialog('mail')}><Mail className="h-4 w-4" strokeWidth={1.75} />绑定邮箱</Button>)}
        <Button variant="primary" onClick={() => setDialog('manual')}><Plus className="h-4 w-4" strokeWidth={1.75} />新建</Button>
      </div>
      {(syncNote || sync.error) && (
        <div role="status" className="px-6 pb-2 text-xs text-[var(--muted)]">{sync.error ?? syncNote}</div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !query.data && <LoadingRow />}
        {query.data && allRows.length === 0 && (
          <EmptyState title="还没有助力记录" hint="收到笔试、面试通知就点右上角「新建」：可以手填、粘贴招聘平台的分享链接，或者从邮箱同步。" />
        )}
        {allRows.length > 0 && rows.length === 0 && <div className="py-8 text-center text-xs text-[var(--subtle)]">这一类还没有记录</div>}
        {rows.length > 0 && (
          <table className="w-full min-w-[720px] table-fixed border-collapse text-sm">
            <thead className="text-left text-xs text-[var(--muted)] [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[var(--bg)] [&_th]:shadow-[inset_0_-1px_0_var(--line-2)]">
              <tr>
                <th className="w-[160px] px-2 py-2 font-medium">公司</th>
                <th className="px-2 py-2 font-medium">岗位</th>
                <th className="w-[160px] px-2 py-2 font-medium">时间</th>
                <th className="w-[180px] px-2 py-2 font-medium">类型</th>
                <th className="w-[88px] px-2 py-2 font-medium"><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const clickable = !!r.application_id;
                return (
                  <tr
                    key={r.key}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => openDossier(r) : undefined}
                    onKeyDown={clickable ? e => { if (e.key === 'Enter' && e.target === e.currentTarget) openDossier(r); } : undefined}
                    className={`border-b border-[var(--line)] transition-colors hover:bg-[var(--hover)] ${clickable ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]' : ''} ${r.detail === '已过' ? 'text-[var(--muted)]' : ''}`}
                  >
                    <td className="truncate px-2 py-2 font-medium text-[var(--ink)]" title={r.company_name ?? undefined}>{textOrUnknown(r.company_name)}</td>
                    <td className="truncate px-2 py-2 text-[var(--ink-2)]" title={r.title ?? undefined}>{r.title ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs tabular-nums text-[var(--muted)]">{formatLocalDateTime(r.at)}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <Badge tone={r.upcoming ? 'accent' : 'neutral'}>{ASSIST_TYPE_LABELS[r.type]}</Badge>
                      {r.detail && <span className="ml-2 text-xs text-[var(--muted)]">{r.detail}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); assist(r); }} onKeyDown={e => e.stopPropagation()}>助力</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {dialog && (
        <NewAssistDialog
          initial={dialog}
          accounts={accounts}
          presets={query.data?.mail.presets ?? {}}
          onClose={() => setDialog(null)}
          onChanged={query.reload}
        />
      )}
    </div>
  );
}

// ─── 新建 ───

type NewMethod = 'manual' | 'link' | 'mail';
const METHODS: Array<{ id: NewMethod; label: string; hint: string }> = [
  { id: 'manual', label: '手动填写', hint: '自己填公司、岗位和时间' },
  { id: 'link', label: '粘贴分享链接', hint: 'Boss、猎聘转发的通知' },
  { id: 'mail', label: '从邮箱同步', hint: '笔试、面试邮件自动识别' },
];

function NewAssistDialog({ initial, accounts, presets, onClose, onChanged }: {
  initial: NewMethod; accounts: MailAccount[]; presets: Record<string, MailPreset>; onClose: () => void; onChanged: () => void;
}) {
  const [method, setMethod] = useState<NewMethod>(initial);
  const close = useCallback(() => onClose(), [onClose]);
  useCloseLayer(() => { close(); return true; }, 60);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  const done = () => { onChanged(); close(); };

  return (
    <OverlayBackdrop onClose={close} className="z-[60] px-4" portal>
      <div role="dialog" aria-modal="true" aria-label="新建助力记录" className="flex max-h-[85vh] w-full max-w-[600px] flex-col rounded-2xl border border-[var(--line)] bg-[var(--paper)] shadow-lg">
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-4">
          <h2 className="flex-1 font-human text-lg font-semibold text-[var(--ink)]">新建</h2>
          <button type="button" aria-label="关闭" onClick={close} className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"><X className="h-4 w-4" /></button>
        </div>
        <div role="tablist" aria-label="新建方式" className="grid grid-cols-3 gap-2 px-5 pt-4">
          {METHODS.map(m => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={method === m.id}
              onClick={() => setMethod(m.id)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${method === m.id ? 'border-[var(--primary)] bg-[var(--primary-soft)]' : 'border-[var(--line)] hover:bg-[var(--hover)]'}`}
            >
              <div className="text-sm font-medium text-[var(--ink)]">{m.label}</div>
              <div className="mt-0.5 text-xs text-[var(--muted)]">{m.hint}</div>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {method === 'manual' && <ManualForm onDone={done} />}
          {method === 'link' && <LinkForm onDone={onChanged} />}
          {method === 'mail' && <MailPanel accounts={accounts} presets={presets} onChanged={onChanged} />}
        </div>
      </div>
    </OverlayBackdrop>
  );
}

type ManualKind = 'written_test' | 'assessment' | 'interview';
const MANUAL_KIND_OPTIONS: Array<{ value: ManualKind; label: string }> = [
  { value: 'written_test', label: '笔试' }, { value: 'assessment', label: '测评' }, { value: 'interview', label: '面试' },
];
const ROUND_OPTIONS = Object.entries(INTERVIEW_ROUND_LABELS).map(([value, label]) => ({ value, label }));

function ManualForm({ onDone }: { onDone: () => void }) {
  const action = useCareerAction();
  const [form, setForm] = useState({ kind: 'written_test' as ManualKind, company_name: '', title: '', at: '', url: '', round: 'first' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = () => action.run(async () => {
    const company = form.company_name.trim();
    if (!company) throw new Error('请填写公司');
    const at = form.at ? new Date(form.at) : null;
    if (at && Number.isNaN(at.getTime())) throw new Error('时间格式不对');
    if (form.kind === 'interview') {
      await careerApi.createInterview({ company_name: company, title: form.title.trim() || null, round: form.round, date: at?.toISOString() ?? null, result: 'none', result_source: 'none', tags_json: '[]' });
    } else {
      if (!at) throw new Error('请填写笔试时间');
      await careerApi.createExam({ company_name: company, title: form.title.trim() || null, kind: form.kind, due_at: at.toISOString(), url: form.url.trim() || null });
    }
    onDone();
  });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="类型"><Select ariaLabel="类型" value={form.kind} onChange={v => setForm(f => ({ ...f, kind: v as ManualKind }))} options={MANUAL_KIND_OPTIONS} /></Field>
        {form.kind === 'interview'
          ? <Field label="轮次"><Select ariaLabel="轮次" value={form.round} onChange={v => setForm(f => ({ ...f, round: v }))} options={ROUND_OPTIONS} /></Field>
          : <span className="hidden md:block" />}
        <Field label="公司"><TextInput aria-label="公司" value={form.company_name} onChange={set('company_name')} /></Field>
        <Field label="岗位（可选）"><TextInput aria-label="岗位" value={form.title} onChange={set('title')} /></Field>
        <Field label="时间"><TextInput aria-label="时间" type="datetime-local" value={form.at} onChange={set('at')} /></Field>
        {form.kind !== 'interview' && <Field label="笔试链接（可选）"><TextInput aria-label="笔试链接" value={form.url} onChange={set('url')} placeholder="https://" /></Field>}
      </div>
      {action.error && <ErrorRow message={action.error} />}
      <div className="flex justify-end">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>保存</Button>
      </div>
    </div>
  );
}

/** 分享页没抓到、只靠文字也没认出笔试 / 面试时，交给小芽用浏览器打开（多半要登录，登录交给用户）。 */
export function linkHandoffMessage(url: string, inboxId: string): string {
  return `帮我打开这个分享链接，看看是什么笔试或面试通知，记进助力记录：${url}\n需要登录就交给我。记好后把收件箱里那条（${inboxId}）忽略掉。`;
}

function recognized(r: IntakeResult): boolean {
  return (r.created?.deadline_ids?.length ?? 0) > 0 || !!r.created?.interview_id;
}

function LinkForm({ onDone }: { onDone: () => void }) {
  const action = useCareerAction();
  const suggest = useSuggestToChat();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const submit = () => action.run(async () => {
    const pasted = url.trim() || text.match(/https?:\/\/\S+/)?.[0] || '';
    if (!pasted) throw new Error('请粘贴分享链接');
    const r = await careerApi.captureLink({ url: pasted, text: text.trim() || null });
    setUrl('');
    setText('');
    onDone();
    if (r.fetched === false && !recognized(r)) {
      setResult('分享页要登录才能看，已交给小芽用浏览器打开，需要登录时会请你来。');
      suggest(linkHandoffMessage(pasted, r.item.id), { surface: 'dossier', refs: { inbox_id: r.item.id }, note: '助力记录 · 分享链接没抓到页面' });
      return;
    }
    setResult(r.summary ?? '已识别');
  });
  return (
    <div className="space-y-3">
      <Field label="分享链接" hint="在 Boss、猎聘等 App 里点「分享 › 复制链接」，粘到这里">
        <TextInput aria-label="分享链接" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" />
      </Field>
      <Field label="分享文字（可选）" hint="复制出来的整段分享内容也可以直接粘进来，链接会自动取出来">
        <TextArea aria-label="分享文字" value={text} onChange={e => setText(e.target.value)} className="min-h-[72px]" />
      </Field>
      {action.error && <ErrorRow message={action.error} />}
      {result && <div role="status" className="border-l-2 border-[var(--primary)] pl-3 text-sm text-[var(--ink)]">{result}</div>}
      <div className="flex justify-end">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>识别</Button>
      </div>
    </div>
  );
}

function MailPanel({ accounts, presets, onChanged }: { accounts: MailAccount[]; presets: Record<string, MailPreset>; onChanged: () => void }) {
  const [bound, setBound] = useState<string | null>(null);
  if (accounts.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--muted)]">还没有绑定邮箱。绑定后笔试、面试通知会自动识别进来，你只需要偶尔点一下「同步邮箱」。</p>
        {bound && <div role="status" className="text-xs text-[var(--success)]">{bound}</div>}
        <BindMailForm presets={presets} onBound={message => { setBound(message); onChanged(); }} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-[var(--muted)]">邮箱已绑定。点「立即同步」拉一次新邮件，识别出的笔试 / 面试会直接出现在列表里。</p>
      <ul className="divide-y divide-[var(--line)]">
        {accounts.map(acc => <MailAccountRow key={acc.id} account={acc} preset={presets[acc.provider]} onChanged={onChanged} />)}
      </ul>
    </div>
  );
}
