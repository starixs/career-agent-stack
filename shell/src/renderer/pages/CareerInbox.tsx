/**
 * 收件箱：把任何东西丢进来（JD / 邀请 / 拒信 / Offer / 内推码）→ 助理识别归档；邮箱绑定与同步；待处理条目的归属与忽略。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import {
  Badge, Button, CareerPage, Card, ChatActionButton, ErrorRow, Field, LoadingRow, SectionTitle, Select, TextArea, TextInput, formatDate,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type { CareerFocusEvent, DossierSummary, InboxItem, IntakeResult, MailAccount, MailPreset } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

const INBOX_TABLES = ['inbox_item', 'mail_message', 'mail_account'] as const;
const MAIL_TABLES = ['mail_account', 'mail_message'] as const;
const DOSSIER_TABLES = ['application', 'job'] as const;

type Filter = InboxItem['status'];
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'new', label: '待处理' }, { value: 'processed', label: '已归档' }, { value: 'dismissed', label: '已忽略' },
];

const SOURCE_LABELS: Record<InboxItem['source'], string> = { paste: '粘贴', mail: '邮件', file: '文件', url: '链接', chat: '对话' };
const KIND_LABELS: Record<string, string> = {
  jd: '岗位 JD', interview_invite: '面试邀请', assessment: '测评', written_test: '笔试', rejection: '拒信', offer: 'Offer', referral: '内推', deadline: '截止提醒', other: '未识别',
};
const LINKED_TYPE_LABELS: Record<string, string> = { application: '投递', interview: '面试', offer: 'Offer', job: '岗位', deadline: '截止', inbox_item: '收件' };
const ACCOUNT_STATUS: Record<MailAccount['status'], { label: string; tone: BadgeTone }> = {
  ok: { label: '已连接', tone: 'success' }, unverified: { label: '待验证', tone: 'warning' }, auth_failed: { label: '授权失败', tone: 'error' }, error: { label: '出错', tone: 'error' },
};
const PREVIEW_LIMIT = 160;

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前；解析失败退回日期。 */
export function relativeTime(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '从未';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return formatDate(value);
  const diffMin = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  return `${Math.round(diffHour / 24)} 天前`;
}

/** 按邮箱域名猜 provider；猜不到就走通用 IMAP 并让用户补 host。 */
export function detectProvider(address: string): MailAccount['provider'] {
  const domain = address.split('@')[1]?.trim().toLowerCase() ?? '';
  if (!domain) return 'imap';
  if (domain === 'qq.com' || domain === 'foxmail.com') return 'qq';
  if (domain === '163.com') return '163';
  if (domain === '126.com') return '126';
  if (domain.includes('gmail') || domain === 'googlemail.com') return 'gmail';
  if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live.')) return 'outlook';
  return 'imap';
}

export default function CareerInbox({ embedded = false }: CareerPageProps) {
  const inbox = useCareerQuery(careerApi.inbox, INBOX_TABLES);
  const mail = useCareerQuery(careerApi.mailAccounts, MAIL_TABLES);
  const dossiers = useCareerQuery(careerApi.dossiers, DOSSIER_TABLES);
  const [filter, setFilter] = useState<Filter>('new');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const itemsRef = useRef<InboxItem[]>([]);
  useEffect(() => { itemsRef.current = inbox.data ?? []; });

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'inbox') return;
    if (!payload.id) return;
    const id = payload.id;
    setHighlightId(id);
    const target = itemsRef.current.find(it => it.id === id);
    if (target) setFilter(target.status);
  }), []);

  const items = useMemo(() => (inbox.data ?? []).filter(it => it.status === filter), [inbox.data, filter]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { new: 0, processed: 0, dismissed: 0 };
    for (const it of inbox.data ?? []) c[it.status] += 1;
    return c;
  }, [inbox.data]);

  return (
    <CareerPage embedded={embedded} title="收件箱" subtitle="任何东西丢进来，助理识别后归到对应投递" examples={['我收到一封面试邀请，帮我安排', '这个 JD 值不值得投', '帮我处理收件箱里没看懂的那条']}>
      <div className="space-y-5 px-4 py-3">
        <CaptureBox onCaptured={inbox.reload} />
        <MailSection accounts={mail.data?.accounts ?? []} presets={mail.data?.presets ?? {}} loading={mail.loading && !mail.data} error={mail.error} onChanged={mail.reload} />

        <section>
          <SectionTitle extra={(
            <div className="flex items-center gap-1">
              {FILTERS.map(f => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${filter === f.value ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--line)] text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
                >
                  {f.label} {counts[f.value]}
                </button>
              ))}
            </div>
          )}>
            条目
          </SectionTitle>
          {inbox.error && <ErrorRow message={inbox.error} onRetry={inbox.reload} />}
          {inbox.loading && !inbox.data && <LoadingRow />}
          {inbox.data && items.length === 0 && (
            <div className="py-6 text-center text-xs text-[var(--ink-subtle)]">
              {filter === 'new' ? '没有待处理的条目。邮箱里的面试邀请和拒信会自动到这里。' : '这里还没有东西。'}
            </div>
          )}
          <ul className="space-y-2">
            {items.map(item => (
              <InboxRow key={item.id} item={item} dossiers={dossiers.data ?? []} highlighted={item.id === highlightId} onChanged={inbox.reload} />
            ))}
          </ul>
        </section>
      </div>
    </CareerPage>
  );
}

function CaptureBox({ onCaptured }: { onCaptured: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<IntakeResult | null>(null);
  const capture = useCareerAction();
  const submit = () => capture.run(async () => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('先把内容贴进来');
    const r = await careerApi.captureInbox({ text: trimmed });
    setResult(r);
    setText('');
    onCaptured();
  });
  return (
    <Card>
      <TextArea
        aria-label="丢进收件箱"
        placeholder="把任何东西丢进来：群里的 JD、面试邀请短信、测评链接、拒信、Offer、内推码…"
        value={text}
        onChange={e => setText(e.target.value)}
        className="min-h-[96px]"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={capture.busy} onClick={() => void submit()}>丢进来</Button>
        {text.trim() && (
          <ChatActionButton text={`帮我处理这个，我刚收到的：\n${text.trim()}`} context={{ surface: 'inbox', note: '用户从收件箱手动交给助理的原文' }} variant="secondary">交给助理处理</ChatActionButton>
        )}
        <span className="text-xs text-[var(--ink-subtle)]">助理识别后会自动建岗位 / 面试 / 截止，并归到对应卷宗。</span>
      </div>
      {capture.error && <ErrorRow message={capture.error} />}
      {result && (
        <div role="status" className="mt-2 rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-3 py-2 text-xs">
          <div className="text-[var(--ink)]">{result.summary}</div>
          {result.item?.status === 'new' && <div className="mt-0.5 text-[var(--ink-muted)]">助理没完全看懂，可以在下面指定归属或交给对话。</div>}
        </div>
      )}
    </Card>
  );
}

function MailSection({ accounts, presets, loading, error, onChanged }: {
  accounts: MailAccount[]; presets: Record<string, MailPreset>; loading: boolean; error: string | null; onChanged: () => void;
}) {
  const [showBind, setShowBind] = useState(false);
  const [bindResult, setBindResult] = useState<string | null>(null);
  return (
    <Card title="邮箱同步" extra={<Button variant={showBind ? 'ghost' : 'secondary'} onClick={() => setShowBind(s => !s)}>{showBind ? '收起' : '绑定邮箱'}</Button>}>
      {error && <ErrorRow message={error} onRetry={onChanged} />}
      {bindResult && <div role="status" className="mb-2 text-xs text-[var(--success)]">{bindResult}</div>}
      {loading && <LoadingRow />}
      {!loading && accounts.length === 0 && !showBind && (
        <div className="text-xs text-[var(--ink-subtle)]">还没有绑定邮箱。绑定后面试邀请、笔试测评、拒信会自动进收件箱，你不用天天刷。</div>
      )}
      <ul className="space-y-2">
        {accounts.map(acc => <MailAccountRow key={acc.id} account={acc} preset={presets[acc.provider]} onChanged={onChanged} />)}
      </ul>
      {showBind && <BindMailForm presets={presets} onBound={message => { setBindResult(message); setShowBind(false); onChanged(); }} />}
    </Card>
  );
}

function MailAccountRow({ account, preset, onChanged }: { account: MailAccount; preset?: MailPreset; onChanged: () => void }) {
  const act = useCareerAction();
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const status = ACCOUNT_STATUS[account.status] ?? { label: account.status, tone: 'neutral' as BadgeTone };
  const sync = () => act.run(async () => {
    const results = await careerApi.syncMail(account.id);
    const mine = results.find(r => r.account_id === account.id) ?? results[0];
    setSyncSummary(mine ? (mine.error ? `同步失败：${mine.error}` : `拉到 ${mine.fetched} 封，其中 ${mine.job_related} 封与求职相关`) : '同步完成');
    onChanged();
  });
  const unbind = () => act.run(async () => {
    if (!window.confirm(`解绑 ${account.address}？已同步的邮件会保留，之后不再自动拉取。`)) return;
    await careerApi.deleteMailAccount(account.id);
    onChanged();
  });
  return (
    <li className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-[var(--ink)]">{account.address}</span>
        <Badge tone="neutral">{preset?.label ?? account.provider}</Badge>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-[var(--ink-subtle)]">上次同步：{relativeTime(account.last_sync_at)}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="secondary" busy={act.busy} onClick={() => void sync()}>立即同步</Button>
          <Button variant="ghost" busy={act.busy} onClick={() => void unbind()}>解绑</Button>
        </div>
      </div>
      {account.last_error && <div className="mt-1 text-xs text-[var(--error)]">{account.last_error}</div>}
      {syncSummary && <div role="status" className="mt-1 text-xs text-[var(--ink-muted)]">{syncSummary}</div>}
      {act.error && <ErrorRow message={act.error} />}
    </li>
  );
}

function BindMailForm({ presets, onBound }: { presets: Record<string, MailPreset>; onBound: (message: string) => void }) {
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const act = useCareerAction();
  const provider = detectProvider(address);
  const preset = presets[provider];

  const submit = () => act.run(async () => {
    const addr = address.trim();
    if (!addr.includes('@')) throw new Error('请输入完整的邮箱地址');
    if (!password.trim()) throw new Error('请输入授权码 / 应用密码');
    if (provider === 'imap' && (!imapHost.trim() || !smtpHost.trim())) throw new Error('这个邮箱不在预设里，请填写 IMAP 与 SMTP 服务器');
    const r = await careerApi.bindMailAccount({
      address: addr, password: password.trim(), display_name: displayName.trim() || undefined,
      ...(provider === 'imap' ? { imap_host: imapHost.trim(), smtp_host: smtpHost.trim() } : {}),
    });
    setPassword('');
    if (r.verify?.error) {
      setVerifyError(`连接失败：${r.verify.error}。账号已保存，修正授权码后可重新绑定。`);
      return;
    }
    setVerifyError(null);
    onBound(`已连接，拉到 ${r.verify?.fetched ?? 0} 封，其中 ${r.verify?.job_related ?? 0} 封与求职相关`);
  });

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-3">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="邮箱地址">
          <TextInput aria-label="邮箱地址" placeholder="you@qq.com" value={address} onChange={e => setAddress(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="授权码 / 应用密码" hint="不是登录密码；只保存在本机，不会发给对话或任何第三方。">
          <TextInput aria-label="授权码" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="显示名（可选）">
          <TextInput aria-label="显示名" placeholder="投递邮件署名" value={displayName} onChange={e => setDisplayName(e.target.value)} />
        </Field>
      </div>
      {address.includes('@') && (
        <div className="text-xs text-[var(--ink-muted)]">
          识别为 <Badge tone="info">{preset?.label ?? (provider === 'imap' ? '通用 IMAP' : provider)}</Badge>
          {preset?.help && <span className="ml-1">{preset.help}</span>}
        </div>
      )}
      {provider === 'imap' && address.includes('@') && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Field label="IMAP 服务器"><TextInput aria-label="IMAP 服务器" placeholder="imap.example.com" value={imapHost} onChange={e => setImapHost(e.target.value)} /></Field>
          <Field label="SMTP 服务器"><TextInput aria-label="SMTP 服务器" placeholder="smtp.example.com" value={smtpHost} onChange={e => setSmtpHost(e.target.value)} /></Field>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={act.busy} onClick={() => void submit()}>绑定并验证</Button>
        {verifyError && <span role="status" className="text-xs text-[var(--error)]">{verifyError}</span>}
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

function InboxRow({ item, dossiers, highlighted, onChanged }: { item: InboxItem; dossiers: DossierSummary[]; highlighted: boolean; onChanged: () => void }) {
  const act = useCareerAction();
  const [expanded, setExpanded] = useState(false);
  const [assignTo, setAssignTo] = useState('');
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [highlighted]);

  const raw = item.raw_text ?? '';
  const preview = expanded || raw.length <= PREVIEW_LIMIT ? raw : `${raw.slice(0, PREVIEW_LIMIT)}…`;
  const run = (fn: () => Promise<unknown>) => act.run(async () => { await fn(); onChanged(); });
  const dossierOptions = dossiers.map(d => ({ value: d.application_id, label: `${d.company_name ?? '未知公司'} · ${d.title}` }));

  return (
    <li ref={ref} className={`rounded-lg border bg-[var(--paper-elevated)] px-3 py-2 ${highlighted ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30' : 'border-[var(--line)]'}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone="neutral">{SOURCE_LABELS[item.source] ?? item.source}</Badge>
        <Badge tone={item.kind && item.kind !== 'other' ? 'accent' : 'warning'}>{item.kind ? KIND_LABELS[item.kind] ?? item.kind : '未识别'}</Badge>
        <span className="text-[var(--ink-subtle)]">{formatDate(item.created_at)}</span>
        {item.note && <span className="text-[var(--ink-muted)]">{item.note}</span>}
      </div>
      {raw && (
        <div className="mt-1 whitespace-pre-wrap break-words text-xs text-[var(--ink)]">
          {preview}
          {raw.length > PREVIEW_LIMIT && (
            <button type="button" onClick={() => setExpanded(e => !e)} className="ml-1 text-[var(--accent)] underline underline-offset-2">{expanded ? '收起' : '展开'}</button>
          )}
        </div>
      )}
      {act.error && <ErrorRow message={act.error} />}
      {item.status === 'new' && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {dossierOptions.length > 0 && (
            <div className="w-56">
              <Select ariaLabel={`归属投递 ${item.id}`} value={assignTo} placeholder="归到某条投递（可选）" options={dossierOptions} onChange={setAssignTo} disabled={act.busy} />
            </div>
          )}
          <Button variant="secondary" busy={act.busy} onClick={() => void run(() => careerApi.retryInbox(item.id, assignTo || undefined))}>重新识别</Button>
          <Button variant="ghost" busy={act.busy} onClick={() => void run(() => careerApi.dismissInbox(item.id))}>忽略</Button>
          <ChatActionButton text="帮我处理这条" context={{ surface: 'inbox', refs: { inbox_id: item.id } }} />
        </div>
      )}
      {item.status === 'processed' && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
          <span>已归入{item.linked_type ? `：${LINKED_TYPE_LABELS[item.linked_type] ?? item.linked_type}` : ''}</span>
          {item.linked_type === 'application' && item.linked_id && (
            <Button variant="secondary" onClick={() => emitEvent('career:focus', { surface: 'dossier', application_id: item.linked_id } satisfies CareerFocusEvent)}>打开卷宗</Button>
          )}
        </div>
      )}
    </li>
  );
}
