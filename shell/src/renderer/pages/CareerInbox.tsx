/**
 * 通知中心：所有要你知道的事在一条流里，新的在前——收进来的邮件 / 内容、等你批准的动作、批量投递进度、截止提醒。
 * 每条带一个小类型标签（邮件 / 待批准 / 投递进度 / 提醒）。下面是「丢进来」和邮箱绑定。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { ACTION_KIND_LABELS } from '@/components/career/careerConstants';
import { BatchProgressCard, useBatchState } from '@/components/career/CareerFlowCards';
import {
  Badge, Button, CareerPage, Card, ChatActionButton, DueLabel, ErrorRow, LoadingRow, Select, TextArea, formatDate,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import { PageAskBar } from '@/features/career-shell/PageAskBar';
import { isManualSend, isManualSendKind, manualSendText } from '@/components/career/manualSendActions';
import { ManualSendText } from '@/components/career/ManualSendText';
import { StrikeText } from '@/components/career/StrikeText';
import { SubmitReviewList, approvalLabel } from '@/components/career/SubmitReviewList';
import type {
  ActionQueueItem, CareerFocusEvent, Deadline, DossierSummary, InboxItem, IntakeResult, MailAccount, MailPreset, SubmitReviewSummary,
} from '@/components/career/types';
import { BindMailForm, MailAccountRow } from '@/components/career/MailBinding';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

const INBOX_TABLES = ['inbox_item', 'mail_message', 'mail_account'] as const;
const MAIL_TABLES = ['mail_account', 'mail_message'] as const;
const DOSSIER_TABLES = ['application', 'job'] as const;
const ACTION_TABLES = ['action_queue'] as const;
const DEADLINE_TABLES = ['deadline'] as const;

/** 截止提醒只放快到的和已经过了的；更远的在招聘概览的月历上。 */
const REMIND_WITHIN_DAYS = 7;

type FeedType = 'mail' | 'review' | 'batch' | 'remind';
type Filter = 'all' | FeedType;
const TYPE_LABELS: Record<FeedType, string> = { mail: '邮件', review: '待批准', batch: '投递进度', remind: '提醒' };
const TYPE_TONES: Record<FeedType, BadgeTone> = { mail: 'info', review: 'accent', batch: 'success', remind: 'warning' };
const FILTERS: Filter[] = ['all', 'mail', 'review', 'batch', 'remind'];

const SOURCE_LABELS: Record<InboxItem['source'], string> = { paste: '粘贴', mail: '邮件', file: '文件', url: '链接', chat: '对话' };
const KIND_LABELS: Record<string, string> = {
  jd: '岗位 JD', interview_invite: '面试邀请', assessment: '测评', written_test: '笔试', rejection: '拒信', offer: 'Offer', referral: '内推', deadline: '截止提醒', other: '未识别',
};
const LINKED_TYPE_LABELS: Record<string, string> = { application: '投递', interview: '面试', offer: 'Offer', job: '岗位', deadline: '截止', inbox_item: '收件' };
const PREVIEW_LIMIT = 160;

export { detectProvider, relativeTime } from '@/components/career/MailBinding';

/** 待批准动作的一句话摘要（与投递页同一套取字段顺序）。 */
export function actionSummary(action: ActionQueueItem): string {
  const payload = safeJson<Record<string, unknown>>(action.payload_json, {});
  if (action.kind === 'submit') return `停在「${typeof payload.submitButton === 'string' ? payload.submitButton : '提交'}」前，批准后产品替你点提交`;
  if (typeof payload.summary === 'string') return payload.summary;
  if (typeof payload.subject === 'string') return `${payload.subject}${typeof payload.to === 'string' ? ` → ${payload.to}` : ''}`;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.message === 'string') return payload.message;
  return Object.keys(payload).length ? JSON.stringify(payload).slice(0, 160) : '（无摘要）';
}

/** 截止是否该进通知流：没做完，且已经过了或 REMIND_WITHIN_DAYS 天内到期。 */
export function isDueSoon(d: Deadline, now: Date = new Date()): boolean {
  if (d.status !== 'open' && d.status !== 'missed') return false;
  if (!d.due_at) return false; // 时间未知：原邮件本身已在通知流里，不再单列一条截止
  const due = new Date(d.due_at).getTime();
  if (Number.isNaN(due)) return false;
  return due - now.getTime() <= REMIND_WITHIN_DAYS * 86_400_000;
}

type FeedEntry =
  | { type: 'mail'; key: string; at: string; item: InboxItem }
  | { type: 'review'; key: string; at: string; action: ActionQueueItem; confirm?: boolean; manual?: boolean }
  | { type: 'remind'; key: string; at: string; deadline: Deadline };

/** 本地处理过的条目：批准后原地变成「已发送 · 10:42」，不跳走（7.2）。 */
interface Resolved { label: string; at: string }

export default function CareerInbox({ embedded = false }: CareerPageProps) {
  const inbox = useCareerQuery(careerApi.inbox, INBOX_TABLES);
  const mail = useCareerQuery(careerApi.mailAccounts, MAIL_TABLES);
  const dossiers = useCareerQuery(careerApi.dossiers, DOSSIER_TABLES);
  const pending = useCareerQuery(careerApi.pendingActions, ACTION_TABLES);
  const needsUser = useCareerQuery(() => careerApi.actionsNeedingUser().catch(() => []), ACTION_TABLES);
  const deadlines = useCareerQuery(() => careerApi.deadlines('open_or_missed'), DEADLINE_TABLES);
  const batchSnapshot = useCareerQuery(() => careerApi.batchState().catch(() => null), ACTION_TABLES);
  const liveBatch = useBatchState();
  const batch = liveBatch ?? batchSnapshot.data;
  const showBatch = !!batch && (batch.status === 'running' || batch.status === 'paused');

  const [filter, setFilter] = useState<Filter>('all');
  const [showDismissed, setShowDismissed] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // 本次会话里处理掉的条目留在原位（服务端刷新后它们会从列表里消失）。
  const [resolved, setResolved] = useState<ReadonlyMap<string, Resolved>>(() => new Map());
  const [kept, setKept] = useState<ReadonlyMap<string, FeedEntry>>(() => new Map());
  const itemsRef = useRef<InboxItem[]>([]);
  useEffect(() => { itemsRef.current = inbox.data ?? []; });

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'inbox') return;
    if (!payload.id) return;
    const id = payload.id;
    setHighlightId(id);
    setFilter('all');
    if (itemsRef.current.find(it => it.id === id)?.status === 'dismissed') setShowDismissed(true);
  }), []);

  const appLabel = useMemo(() => {
    const map = new Map((dossiers.data ?? []).map(d => [d.application_id, `${d.company_name ?? '未知公司'} · ${d.title}`]));
    return (applicationId: string | null) => (applicationId ? map.get(applicationId) ?? '未关联岗位' : '未关联岗位');
  }, [dossiers.data]);

  const entries = useMemo(() => {
    const now = new Date();
    const list: FeedEntry[] = [];
    for (const item of inbox.data ?? []) if (item.status !== 'dismissed') list.push({ type: 'mail', key: `mail:${item.id}`, at: item.created_at, item });
    for (const action of pending.data ?? []) list.push({ type: 'review', key: `review:${action.id}`, at: action.created_at, action });
    for (const action of needsUser.data ?? []) {
      if (action.kind === 'submit') list.push({ type: 'review', key: `confirm:${action.id}`, at: action.updated_at, action, confirm: true });
      else if (isManualSend(action)) list.push({ type: 'review', key: `manual:${action.id}`, at: action.updated_at, action, manual: true });
    }
    for (const d of deadlines.data ?? []) if (isDueSoon(d, now)) list.push({ type: 'remind', key: `remind:${d.id}`, at: d.created_at, deadline: d });
    const seen = new Set(list.map(e => e.key));
    for (const [key, entry] of kept) if (!seen.has(key)) list.push(entry);
    return list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [inbox.data, pending.data, needsUser.data, deadlines.data, kept]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: entries.length + (showBatch ? 1 : 0), mail: 0, review: 0, batch: showBatch ? 1 : 0, remind: 0 };
    for (const e of entries) c[e.type] += 1;
    return c;
  }, [entries, showBatch]);
  const visible = filter === 'all' ? entries : entries.filter(e => e.type === filter);
  const dismissed = useMemo(() => (inbox.data ?? []).filter(it => it.status === 'dismissed'), [inbox.data]);

  const resolve = (entry: FeedEntry, label: string) => {
    setResolved(prev => new Map(prev).set(entry.key, { label, at: new Date().toISOString() }));
    setKept(prev => new Map(prev).set(entry.key, entry));
  };
  const reloadFeed = () => { inbox.reload(); pending.reload(); needsUser.reload(); deadlines.reload(); };
  const loading = (inbox.loading && !inbox.data) || (pending.loading && !pending.data);
  const error = inbox.error ?? pending.error ?? deadlines.error;

  return (
    <CareerPage embedded={embedded} title="通知中心" subtitle="邮件、待批准、投递进度和截止提醒都在这里，新的在前">
      <div className="max-w-5xl space-y-8 px-6 py-6">
        <section aria-label="通知">
          <div role="group" aria-label="按类型筛选" className="mb-3 inline-flex flex-wrap rounded-full border border-[var(--line-2)] p-0.5">
            {FILTERS.map(f => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`h-7 rounded-full px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${filter === f ? 'bg-[var(--ink)] font-medium text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
              >
                {f === 'all' ? '全部' : TYPE_LABELS[f]} <span className="tabular-nums">{counts[f]}</span>
              </button>
            ))}
          </div>
          {error && <ErrorRow message={error} onRetry={reloadFeed} />}
          {loading && <LoadingRow />}
          {showBatch && (filter === 'all' || filter === 'batch') && (
            <div className="mb-3" data-feed-type="batch">
              <TypeLabel type="batch" />
              <div className="mt-1.5"><BatchProgressCard batch={batch} /></div>
            </div>
          )}
          {!loading && visible.length === 0 && !(showBatch && (filter === 'all' || filter === 'batch')) && (
            <div className="py-8 text-sm text-[var(--muted)]">
              {filter === 'all' ? '暂时没有新通知。邮箱里的面试邀请和拒信、等你批准的投递、快到的截止都会出现在这里。' : `没有${TYPE_LABELS[filter]}类的通知。`}
            </div>
          )}
          <ul className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {visible.map(entry => (
              <li key={entry.key} data-feed-type={entry.type} className="py-3">
                {entry.type === 'mail' && (
                  <InboxRow item={entry.item} dossiers={dossiers.data ?? []} highlighted={entry.item.id === highlightId} onChanged={inbox.reload} />
                )}
                {entry.type === 'review' && (
                  <ReviewRow entry={entry} label={appLabel(entry.action.application_id)} resolved={resolved.get(entry.key)} onResolved={label => { resolve(entry, label); reloadFeed(); }} />
                )}
                {entry.type === 'remind' && (
                  <RemindRow deadline={entry.deadline} label={entry.deadline.application_id ? appLabel(entry.deadline.application_id) : null} resolved={resolved.get(entry.key)} onResolved={label => { resolve(entry, label); reloadFeed(); }} />
                )}
              </li>
            ))}
          </ul>
          {dismissed.length > 0 && (filter === 'all' || filter === 'mail') && (
            <div className="mt-3">
              <button type="button" onClick={() => setShowDismissed(s => !s)} className="text-xs text-[var(--muted)] underline-offset-2 hover:text-[var(--ink)] hover:underline">
                {showDismissed ? '收起已忽略的' : `看已忽略的 ${dismissed.length} 条`}
              </button>
              {showDismissed && (
                <ul className="mt-2 divide-y divide-[var(--line)]">
                  {dismissed.map(item => (
                    <li key={item.id} className="py-3">
                      <InboxRow item={item} dossiers={dossiers.data ?? []} highlighted={item.id === highlightId} onChanged={inbox.reload} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section aria-label="丢进来" className="space-y-6 border-t border-[var(--line)] pt-6">
          <CaptureBox onCaptured={inbox.reload} />
          <MailSection accounts={mail.data?.accounts ?? []} presets={mail.data?.presets ?? {}} loading={mail.loading && !mail.data} error={mail.error} onChanged={mail.reload} />
        </section>
      </div>
      <PageAskBar target={{ kind: 'career-inbox' }} placeholder="问问这些通知，比如「哪封邮件要我回」" />
    </CareerPage>
  );
}

function TypeLabel({ type }: { type: FeedType }) {
  return <Badge tone={TYPE_TONES[type]}>{TYPE_LABELS[type]}</Badge>;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ReviewRow({ entry, label, resolved, onResolved }: {
  entry: Extract<FeedEntry, { type: 'review' }>; label: string; resolved?: Resolved; onResolved: (label: string) => void;
}) {
  const act = useCareerAction();
  const { action, confirm, manual } = entry;
  const payload = safeJson<Record<string, unknown>>(action.payload_json, {});
  const isSubmit = action.kind === 'submit';
  const result = safeJson<Record<string, unknown>>(action.result_json, {});
  const run = (fn: () => Promise<unknown>, doneLabel: string) => act.run(async () => { await fn(); onResolved(doneLabel); });
  const head = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TypeLabel type="review" />
      <span className="text-xs text-[var(--muted)]">{confirm ? '等你确认' : manual ? '等你发出去' : ACTION_KIND_LABELS[action.kind] ?? action.kind}</span>
      <span className="min-w-0 truncate text-sm font-medium text-[var(--ink)]">{label}</span>
      <span className="ml-auto text-xs tabular-nums text-[var(--muted)]">{formatDate(entry.at)}</span>
    </div>
  );
  if (resolved) {
    return (
      <div>
        {head}
        <div className="mt-1 text-sm"><StrikeText done animate>{actionSummary(action)}</StrikeText></div>
        <div role="status" className="mt-1 text-xs font-medium text-[var(--success)]">{`${resolved.label} · ${hhmm(resolved.at)}`}</div>
      </div>
    );
  }
  if (manual) {
    const text = manualSendText(action);
    return (
      <div className="border-l-[3px] border-[var(--warning)] pl-3">
        {head}
        <div className="mt-1 text-sm text-[var(--ink-2)]">
          {`${ACTION_KIND_LABELS[action.kind] ?? action.kind}已批准，产品不替你在平台上发，复制下面的文字自己发出去`}
        </div>
        {text ? <ManualSendText text={text} actionId={action.id} onSent={onResolved} /> : <div className="mt-1 text-sm text-[var(--muted)]">{actionSummary(action)}</div>}
      </div>
    );
  }
  if (confirm) {
    return (
      <div className="border-l-[3px] border-[var(--warning)] pl-3">
        {head}
        <div className="mt-1 text-sm text-[var(--ink-2)]">
          {typeof result.message === 'string' ? result.message : '提交结果不确定，请到页面上看一下'}
          {approvalLabel(action.approved_by) && <span className="text-[var(--subtle)]">（{approvalLabel(action.approved_by)}）</span>}
        </div>
        {act.error && <ErrorRow message={act.error} />}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" busy={act.busy} onClick={() => void run(() => careerApi.confirmSubmit(action.id, true), '已确认投递')}>已投递成功</Button>
          <Button size="sm" variant="ghost" busy={act.busy} onClick={() => void run(() => careerApi.confirmSubmit(action.id, false), '已退回重新审核')}>没投出去，重新审核</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-[var(--radius-lg)] border-[1.5px] border-[var(--hard)] bg-[var(--paper)] p-4 shadow-hard-lg">
      {head}
      <div className="mt-2 break-words text-base leading-7 text-[var(--ink)]">{actionSummary(action)}</div>
      {isSubmit && <SubmitReviewList review={payload.review as SubmitReviewSummary | null} />}
      {act.error && <ErrorRow message={act.error} />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={act.busy} onClick={() => void run(() => careerApi.reviewActions([action.id], 'approved'), action.kind === 'send_mail' ? '已发送' : isManualSendKind(action.kind) ? '已批准，待你发送' : '已批准')}>
          {action.kind === 'send_mail' ? '批准并发送' : '批准'}
        </Button>
        <Button variant="ghost" busy={act.busy} onClick={() => void run(() => careerApi.reviewActions([action.id], 'rejected'), '不发了')}>不发了</Button>
      </div>
    </div>
  );
}

function RemindRow({ deadline, label, resolved, onResolved }: { deadline: Deadline; label: string | null; resolved?: Resolved; onResolved: (label: string) => void }) {
  const act = useCareerAction();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TypeLabel type="remind" />
        {label && <span className="text-xs text-[var(--muted)]">{label}</span>}
        <span className="ml-auto text-xs tabular-nums">{resolved ? <span className="text-[var(--success)]">{`${resolved.label} · ${hhmm(resolved.at)}`}</span> : <DueLabel at={deadline.due_at} />}</span>
      </div>
      <div className="mt-1 text-sm"><StrikeText done={!!resolved} animate className={resolved ? '' : 'font-medium text-[var(--ink)]'}>{deadline.title}</StrikeText></div>
      {act.error && <ErrorRow message={act.error} />}
      {!resolved && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" busy={act.busy} onClick={() => void act.run(async () => { await careerApi.setDeadlineStatus(deadline.id, 'done'); onResolved('已完成'); })}>完成</Button>
          {deadline.application_id && (
            <Button variant="ghost" size="sm" onClick={() => emitEvent('career:focus', { surface: 'dossier', application_id: deadline.application_id } satisfies CareerFocusEvent)}>在投递记录里看</Button>
          )}
        </div>
      )}
    </div>
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
    <section>
      <TextArea
        aria-label="丢进通知中心"
        placeholder="把任何东西丢进来：群里的 JD、面试邀请短信、测评链接、拒信、Offer、内推码…"
        value={text}
        onChange={e => setText(e.target.value)}
        className="min-h-[72px]"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" busy={capture.busy} onClick={() => void submit()}>丢进来</Button>
        {text.trim() && (
          <ChatActionButton text={`帮我处理这个，我刚收到的：\n${text.trim()}`} context={{ surface: 'inbox', note: '用户从通知中心手动交给助理的原文' }} variant="secondary">交给助理处理</ChatActionButton>
        )}
        <span className="text-xs text-[var(--subtle)]">助理识别后会自动建岗位 / 面试 / 截止，并归到对应卷宗。</span>
      </div>
      {capture.error && <ErrorRow message={capture.error} />}
      {result && (
        <div role="status" className="mt-3 border-l-2 border-[var(--primary)] pl-3 text-sm">
          <div className="text-[var(--ink)]">{result.summary}</div>
          {result.item?.status === 'new' && <div className="mt-0.5 text-[var(--muted)]">助理没完全看懂，可以在下面指定归属或交给对话。</div>}
        </div>
      )}
    </section>
  );
}

function MailSection({ accounts, presets, loading, error, onChanged }: {
  accounts: MailAccount[]; presets: Record<string, MailPreset>; loading: boolean; error: string | null; onChanged: () => void;
}) {
  const [showBind, setShowBind] = useState(false);
  const [bindResult, setBindResult] = useState<string | null>(null);
  return (
    <Card title="邮箱同步" extra={<Button variant="ghost" size="sm" onClick={() => setShowBind(s => !s)}>{showBind ? '收起' : '绑定邮箱'}</Button>}>
      {error && <ErrorRow message={error} onRetry={onChanged} />}
      {bindResult && <div role="status" className="mb-2 text-xs text-[var(--success)]">{bindResult}</div>}
      {loading && <LoadingRow />}
      {!loading && accounts.length === 0 && !showBind && (
        <div className="text-sm text-[var(--muted)]">还没有绑定邮箱。绑定后面试邀请、笔试测评、拒信会自动进通知中心，你不用天天刷。</div>
      )}
      <ul className="divide-y divide-[var(--line)]">
        {accounts.map(acc => <MailAccountRow key={acc.id} account={acc} preset={presets[acc.provider]} onChanged={onChanged} />)}
      </ul>
      {showBind && <BindMailForm presets={presets} onBound={message => { setBindResult(message); setShowBind(false); onChanged(); }} />}
    </Card>
  );
}

function InboxRow({ item, dossiers, highlighted, onChanged }: { item: InboxItem; dossiers: DossierSummary[]; highlighted: boolean; onChanged: () => void }) {
  const act = useCareerAction();
  const [expanded, setExpanded] = useState(false);
  const [assignTo, setAssignTo] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [highlighted]);

  const raw = item.raw_text ?? '';
  const preview = expanded || raw.length <= PREVIEW_LIMIT ? raw : `${raw.slice(0, PREVIEW_LIMIT)}…`;
  const run = (fn: () => Promise<unknown>) => act.run(async () => { await fn(); onChanged(); });
  const dossierOptions = dossiers.map(d => ({ value: d.application_id, label: `${d.company_name ?? '未知公司'} · ${d.title}` }));

  return (
    <div ref={ref} data-inbox-id={item.id} className={highlighted ? '-mx-3 -my-1 rounded-md bg-[var(--primary-soft)] px-3 py-1' : ''}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TypeLabel type="mail" />
        <span className={`text-xs font-medium ${item.kind && item.kind !== 'other' ? 'text-[var(--ink-2)]' : 'text-[var(--warning)]'}`}>{item.kind ? KIND_LABELS[item.kind] ?? item.kind : '未识别'}</span>
        <span className="text-xs text-[var(--muted)]">{SOURCE_LABELS[item.source] ?? item.source}</span>
        {item.note && <span className="text-xs text-[var(--muted)]">{item.note}</span>}
        <span className="ml-auto text-xs tabular-nums text-[var(--muted)]">{formatDate(item.created_at)}</span>
      </div>
      {raw && (
        <div className="mt-1.5 whitespace-pre-wrap break-words text-sm text-[var(--ink)]">
          {preview}
          {raw.length > PREVIEW_LIMIT && (
            <button type="button" onClick={() => setExpanded(e => !e)} className="ml-1 text-[var(--primary)] underline underline-offset-2">{expanded ? '收起' : '展开'}</button>
          )}
        </div>
      )}
      {act.error && <ErrorRow message={act.error} />}
      {item.status === 'new' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ChatActionButton size="sm" text="帮我处理这条" context={{ surface: 'inbox', refs: { inbox_id: item.id } }} />
          {dossierOptions.length > 0 && (
            <div className="w-56">
              <Select ariaLabel={`归属投递 ${item.id}`} value={assignTo} placeholder="归到某条投递（可选）" options={dossierOptions} onChange={setAssignTo} disabled={act.busy} />
            </div>
          )}
          <Button variant="ghost" size="sm" busy={act.busy} onClick={() => void run(() => careerApi.retryInbox(item.id, assignTo || undefined))}>重新识别</Button>
          <Button variant="ghost" size="sm" busy={act.busy} onClick={() => void run(() => careerApi.dismissInbox(item.id))}>忽略</Button>
        </div>
      )}
      {item.status === 'processed' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
          <span>已归入{item.linked_type ? `：${LINKED_TYPE_LABELS[item.linked_type] ?? item.linked_type}` : ''}</span>
          {item.linked_type === 'application' && item.linked_id && (
            <Button variant="ghost" size="sm" onClick={() => emitEvent('career:focus', { surface: 'dossier', application_id: item.linked_id } satisfies CareerFocusEvent)}>在投递记录里看</Button>
          )}
        </div>
      )}
    </div>
  );
}
