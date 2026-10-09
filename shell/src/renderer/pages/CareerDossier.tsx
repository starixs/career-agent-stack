/**
 * 卷宗：每条投递一个档案。面试当天一键摊开——投的是哪版简历、对这家说过什么、听到什么、邮件与截止、历史轮次。
 * 视图：投递线（新）/ 岗位池与投递台 / 面试 / Offer（后三者嵌入既有页面）。
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { onEvent } from '@/api/eventBus';
import { ExternalLink } from '@/components/ExternalLink';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { ACTION_KIND_LABELS, INTERVIEW_RESULT_LABELS, INTERVIEW_ROUND_LABELS, STAGE_LABELS, TRAFFIC_LIGHT_LABELS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, ChatActionButton, EmptyState, ErrorRow, Field, LoadingRow, SectionTitle, Select, StructuredJson, TextArea, TextInput,
  formatDate, textOrUnknown,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type {
  ActionQueueItem, ApplicationStage, CareerFocusEvent, Deadline, DeadlineKind, Dossier, DossierNote, DossierSummary,
} from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

const CareerApply = lazy(() => import('@/pages/CareerApply'));
const CareerInterview = lazy(() => import('@/pages/CareerInterview'));
const CareerOffer = lazy(() => import('@/pages/CareerOffer'));

type View = 'line' | 'apply' | 'interview' | 'offer';
const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'line', label: '投递线' }, { value: 'apply', label: '岗位池与投递台' }, { value: 'interview', label: '面试' }, { value: 'offer', label: 'Offer' },
];

const DOSSIER_TABLES = ['application', 'application_history', 'job', 'deadline', 'interview', 'dossier_note', 'mail_message', 'material_use', 'offer', 'action_queue'] as const;

const ACTIVE_STAGES: ReadonlySet<ApplicationStage> = new Set(['applied', 'responded', 'interview']);
const STAGE_MENU: ApplicationStage[] = ['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired'];
const NOTE_KIND_LABELS: Record<DossierNote['kind'], string> = { said: '我说过', heard: '听到的', contact: '联系人', referral: '内推人', note: '备注', mail: '邮件' };
const NOTE_KIND_OPTIONS: Array<{ value: DossierNote['kind']; label: string }> = (['said', 'heard', 'contact', 'referral', 'note'] as const).map(k => ({ value: k, label: NOTE_KIND_LABELS[k] }));
const DEADLINE_KIND_LABELS: Record<DeadlineKind, string> = {
  interview: '面试', assessment: '测评', written_test: '笔试', application_deadline: '投递截止', offer_reply: 'Offer 回复', referral_expiry: '内推失效', other: '其他',
};
const INTERVIEW_DEADLINE_KINDS: ReadonlySet<DeadlineKind> = new Set(['interview', 'assessment', 'written_test']);
const TRAFFIC_TONE: Record<string, BadgeTone> = { green: 'success', yellow: 'warning', red: 'error' };

// ─── 本地小工具 ───

function stageTone(stage: ApplicationStage): BadgeTone {
  if (stage === 'interview' || stage === 'offer' || stage === 'hired') return 'success';
  if (stage === 'blocked' || stage === 'needs_user') return 'warning';
  if (stage === 'applied' || stage === 'responded' || stage === 'pending') return 'info';
  return 'neutral';
}

function daysSince(iso: string | null | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 86_400_000)) : 0;
}

function isStale(stage: ApplicationStage, days: number): boolean {
  return days >= 14 && ACTIVE_STAGES.has(stage);
}

/** 截止时间相对现在：今天 / 明天 / x 天后 / 已过 x 天。 */
function relativeDue(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diffH = (ms - Date.now()) / 3_600_000;
  if (diffH < -24) return `已过 ${Math.floor(-diffH / 24)} 天`;
  if (diffH < 0) return '刚过';
  if (diffH < 1) return '一小时内';
  if (diffH < 24) return `${Math.floor(diffH)} 小时后`;
  const days = Math.floor(diffH / 24);
  return days === 1 ? '明天' : `${days} 天后`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '未知';
  return value.length > 16 ? value.slice(0, 16).replace('T', ' ') : value;
}

function hasContent(v: unknown): boolean {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0;
  return true;
}

interface ResumeSummary { name: string | null; experiences: number; projects: number }
function summarizeResumeSchema(schema: unknown): ResumeSummary | null {
  let obj: unknown = schema;
  if (typeof obj === 'string') obj = safeJson<unknown>(obj, null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const d = obj as Record<string, unknown>;
  const basics = d.basics && typeof d.basics === 'object' ? d.basics as Record<string, unknown> : {};
  const count = (...keys: string[]) => keys.reduce((n, k) => n + (Array.isArray(d[k]) ? (d[k] as unknown[]).length : 0), 0);
  return {
    name: typeof basics.name === 'string' ? basics.name : typeof d.name === 'string' ? d.name : null,
    experiences: count('experience', 'experiences', 'work'),
    projects: count('projects', 'project'),
  };
}

function manualChecksOf(raw: string | null | undefined): string[] {
  const list = safeJson<unknown>(raw, []);
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const text = typeof o.item === 'string' ? o.item : typeof o.title === 'string' ? o.title : JSON.stringify(o);
      return o.done ? `${text}（已核）` : text;
    }
    return String(item);
  });
}

function riskTone(risk: string): BadgeTone {
  const r = risk.toLowerCase();
  if (r === 'high' || r === '高') return 'error';
  if (r === 'mid' || r === 'medium' || r === '中') return 'warning';
  if (r === 'low' || r === '低') return 'success';
  return 'neutral';
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-[var(--line)] bg-[var(--inset)] p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${o.value === value ? 'bg-[var(--bg)] text-[var(--ink)] shadow-sm' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ClampText({ text, big = false }: { text: string; big?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 120 || text.split('\n').length > 3;
  return (
    <div>
      <div className={`whitespace-pre-wrap break-words ${big ? 'text-base leading-7' : 'text-sm'} ${open || !long ? '' : 'line-clamp-3'}`}>{text}</div>
      {long && <button type="button" onClick={() => setOpen(v => !v)} className="mt-0.5 text-xs text-[var(--primary)] underline-offset-2 hover:underline">{open ? '收起' : '展开'}</button>}
    </div>
  );
}

// ─── 页面 ───

interface FocusRequest { application_id: string | null; job_id: string | null }

export default function CareerDossier({ embedded = false }: CareerPageProps) {
  const [view, setView] = useState<View>('line');
  const [focus, setFocus] = useState<FocusRequest | null>(null);

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'dossier') return;
    setView('line');
    setFocus({ application_id: payload.application_id ?? payload.id ?? null, job_id: payload.job_id ?? null });
  }), []);

  return (
    <CareerPage
      embedded={embedded}
      title="卷宗"
      subtitle="每条投递一个档案"
      examples={['帮我准备明天的面试', '这家公司我之前说过什么', '把没动静的投递线关掉']}
      actions={<Segmented value={view} options={VIEWS} onChange={setView} />}
    >
      {view === 'line' && <DossierLine focus={focus} />}
      {view !== 'line' && (
        <Suspense fallback={<div className="px-4"><LoadingRow /></div>}>
          {view === 'apply' && <CareerApply embedded />}
          {view === 'interview' && <CareerInterview embedded />}
          {view === 'offer' && <CareerOffer embedded />}
        </Suspense>
      )}
    </CareerPage>
  );
}

// ─── 投递线 ───

function resolveFocus(focus: FocusRequest, summaries: DossierSummary[] | null): string | null {
  if (focus.application_id) return focus.application_id;
  if (focus.job_id && summaries) return summaries.find(s => s.job_id === focus.job_id)?.application_id ?? null;
  return null;
}

function DossierLine({ focus }: { focus: FocusRequest | null }) {
  const query = useCareerQuery(careerApi.dossiers, DOSSIER_TABLES);
  const summaries = query.data;
  // 手动选择记住它是在哪次焦点之后做的：新焦点到来时焦点优先，之后用户再点则用户优先。全部是派生，不在 effect 里写 state。
  const [manual, setManual] = useState<{ id: string; afterFocus: FocusRequest | null } | null>(null);
  const [search, setSearch] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [interviewMode, setInterviewMode] = useState(false);
  const select = (id: string) => setManual({ id, afterFocus: focus });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = summaries ?? [];
    return q ? list.filter(s => `${s.company_name ?? ''} ${s.title}`.toLowerCase().includes(q)) : list;
  }, [summaries, search]);
  const open = filtered.filter(s => !s.closed);
  const closed = filtered.filter(s => s.closed);

  const manualId = manual && manual.afterFocus === focus ? manual.id : null;
  const focusId = focus ? resolveFocus(focus, summaries) : null;
  const effectiveId = manualId ?? focusId ?? (summaries ?? []).find(s => !s.closed)?.application_id ?? summaries?.[0]?.application_id ?? null;
  const selectedSummary = summaries?.find(s => s.application_id === effectiveId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--line)]">
        <div className="border-b border-[var(--line)] p-2">
          <TextInput aria-label="搜索投递线" placeholder="搜公司或岗位" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
          {query.loading && !summaries && <LoadingRow />}
          {summaries && summaries.length === 0 && (
            <div className="px-1 py-6 text-center text-xs text-[var(--subtle)]">还没有投递。投出去之后每条线会在这里有一份档案。</div>
          )}
          {open.length > 0 && <div className="px-1 pb-1 text-xs font-semibold text-[var(--muted)]">进行中（{open.length}）</div>}
          <ul className="space-y-1">
            {open.map(s => <SummaryRow key={s.application_id} summary={s} selected={s.application_id === effectiveId} onSelect={() => select(s.application_id)} />)}
          </ul>
          {closed.length > 0 && (
            <>
              <button type="button" onClick={() => setShowClosed(v => !v)} className="mt-3 flex w-full items-center px-1 pb-1 text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)]">
                已关闭（{closed.length}）<span className="ml-auto">{showClosed ? '收起' : '展开'}</span>
              </button>
              {showClosed && (
                <ul className="space-y-1">
                  {closed.map(s => <SummaryRow key={s.application_id} summary={s} selected={s.application_id === effectiveId} onSelect={() => select(s.application_id)} />)}
                </ul>
              )}
            </>
          )}
        </div>
      </aside>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {effectiveId ? (
          <DossierDetail
            key={effectiveId}
            id={effectiveId}
            summary={selectedSummary}
            interviewMode={interviewMode}
            onToggleInterviewMode={() => setInterviewMode(v => !v)}
            onListChanged={query.reload}
          />
        ) : summaries && summaries.length === 0 ? (
          <EmptyState title="没有可以摊开的卷宗" hint="投递之后，面试当天在这里一键看到：投的哪版简历、说过什么、听到什么、邮件和截止。" example="帮我准备这场面试" />
        ) : null}
      </div>
    </div>
  );
}

function SummaryRow({ summary, selected, onSelect }: { summary: DossierSummary; selected: boolean; onSelect: () => void }) {
  const days = summary.days_since_update;
  const showQuiet = days >= 7 && ACTIVE_STAGES.has(summary.stage);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`w-full rounded-lg border px-2 py-1.5 text-left transition-colors ${selected ? 'border-[var(--primary)] bg-[var(--paper)]' : 'border-transparent hover:bg-[var(--inset)]'}`}
      >
        <div className="truncate text-sm font-medium text-[var(--ink)]">{summary.company_name ?? '未知公司'} · {summary.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
          <Badge tone={stageTone(summary.stage)}>{STAGE_LABELS[summary.stage] ?? summary.stage}</Badge>
          {showQuiet && <span className={days >= 14 ? 'text-[var(--warning)]' : 'text-[var(--muted)]'}>{days} 天无动静</span>}
        </div>
        {summary.next_deadline && (
          <div className="mt-0.5 truncate text-xs text-[var(--muted)]">{summary.next_deadline.title} · {relativeDue(summary.next_deadline.due_at)}</div>
        )}
      </button>
    </li>
  );
}

// ─── 右侧摊开 ───

function DossierDetail({ id, summary, interviewMode, onToggleInterviewMode, onListChanged }: {
  id: string; summary: DossierSummary | null; interviewMode: boolean; onToggleInterviewMode: () => void; onListChanged: () => void;
}) {
  const query = useCareerQuery(() => careerApi.dossier(id), DOSSIER_TABLES);
  const d = query.data;
  const onChanged = () => { query.reload(); onListChanged(); };

  if (query.error && !d) return <div className="p-4"><ErrorRow message={query.error} onRetry={query.reload} /></div>;
  if (!d || !d.application) return <div className="p-4"><LoadingRow text="翻开卷宗…" /></div>;

  const big = interviewMode;
  return (
    <div className={`space-y-6 px-5 py-4 ${big ? 'max-w-4xl' : ''}`}>
      {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
      <DossierHeader d={d} summary={summary} interviewMode={interviewMode} onToggleInterviewMode={onToggleInterviewMode} onChanged={onChanged} />
      <InterviewInfo d={d} big={big} onChanged={onChanged} />
      <ResumeSent d={d} big={big} />
      <SaidSection d={d} big={big} />
      <HeardSection d={d} big={big} />
      <CompanySection d={d} />
      <PredictionsSection d={d} />
      {!interviewMode && (
        <>
          <PendingActions d={d} onChanged={onChanged} />
          <Timeline d={d} />
          <NoteForm applicationId={d.application.id} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}

function DossierHeader({ d, summary, interviewMode, onToggleInterviewMode, onChanged }: {
  d: Dossier; summary: DossierSummary | null; interviewMode: boolean; onToggleInterviewMode: () => void; onChanged: () => void;
}) {
  const app = d.application;
  const stage = app.stage;
  const days = summary?.days_since_update ?? daysSince(app.updated_at);
  const stageAction = useCareerAction();
  const closeAction = useCareerAction();
  const refs = { application_id: app.id, job_id: d.job?.id ?? app.job_id };

  const changeStage = (to: string) => stageAction.run(async () => {
    if (!to) return;
    await careerApi.setStage(app.id, to);
    onChanged();
  });
  const close = () => closeAction.run(async () => {
    await careerApi.closeSilent(app.id);
    onChanged();
  });

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-[var(--muted)]">{textOrUnknown(d.job?.company_name)}</div>
          <h2 className={`font-semibold text-[var(--ink)] ${interviewMode ? 'text-2xl' : 'text-lg'}`}>{d.job?.title ?? '未知岗位'}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <Badge tone={stageTone(stage)}>{STAGE_LABELS[stage] ?? stage}</Badge>
            <span>{days === 0 ? '今天有更新' : `${days} 天没有更新`}</span>
            {d.job?.location && <span>· {d.job.location}</span>}
            {d.job?.url && <ExternalLink href={d.job.url} className="text-[var(--primary)] underline underline-offset-2">岗位页面</ExternalLink>}
          </div>
        </div>
        <Button variant={interviewMode ? 'primary' : 'secondary'} aria-pressed={interviewMode} onClick={onToggleInterviewMode}>
          {interviewMode ? '退出面试模式' : '面试模式'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ChatActionButton text="帮我准备这场面试" context={{ surface: 'dossier', refs: { application_id: app.id } }} />
        <ChatActionButton variant="secondary" text="用主简历给这个岗位改一版简历" context={{ surface: 'dossier', refs }} />
        <ChatActionButton variant="secondary" text="帮我给这个岗位写投递邮件" context={{ surface: 'dossier', refs }} />
        <div className="ml-auto w-32">
          <Select
            ariaLabel="移动阶段"
            value=""
            placeholder="改阶段…"
            disabled={stageAction.busy}
            onChange={v => void changeStage(v)}
            options={STAGE_MENU.filter(s => s !== stage).map(s => ({ value: s, label: STAGE_LABELS[s] }))}
          />
        </div>
      </div>
      {stageAction.error && <ErrorRow message={stageAction.error} />}
      {closeAction.error && <ErrorRow message={closeAction.error} />}
      {isStale(stage, days) && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]">
          <span className="min-w-0 flex-1">已经 {days} 天没有动静。沉默比被拒常见，可以关掉这条线，把注意力留给别处。</span>
          <Button variant="secondary" busy={closeAction.busy} onClick={() => void close()}>关闭这条线</Button>
        </div>
      )}
    </header>
  );
}

function Spread({ title, extra, big = false, children }: { title: string; extra?: ReactNode; big?: boolean; children: ReactNode }) {
  return (
    <section className={big ? 'rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4' : ''}>
      <SectionTitle extra={extra}>{title}</SectionTitle>
      <div className={big ? 'space-y-3 text-base' : 'space-y-2 text-sm'}>{children}</div>
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div className="text-xs text-[var(--subtle)]">{children}</div>;
}

function InterviewInfo({ d, big, onChanged }: { d: Dossier; big: boolean; onChanged: () => void }) {
  const action = useCareerAction();
  const upcoming = (d.deadlines ?? []).filter(x => x.status === 'open' && INTERVIEW_DEADLINE_KINDS.has(x.kind));
  const done = (dl: Deadline) => action.run(async () => { await careerApi.setDeadlineStatus(dl.id, 'done'); onChanged(); });
  const interviews = d.interviews ?? [];
  return (
    <Spread title="面试信息" big={big}>
      {action.error && <ErrorRow message={action.error} />}
      {upcoming.length === 0 && interviews.length === 0 && <Muted>还没有面试、笔试或测评安排。收到邀约丢进收件箱就会出现在这里。</Muted>}
      {upcoming.length > 0 && (
        <ul className="space-y-1.5">
          {upcoming.map(dl => (
            <li key={dl.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
              <Badge tone="accent">{DEADLINE_KIND_LABELS[dl.kind] ?? dl.kind}</Badge>
              <span className={`min-w-0 flex-1 font-medium text-[var(--ink)] ${big ? 'text-lg' : ''}`}>{dl.title}</span>
              <span className="text-xs text-[var(--muted)]">{formatDateTime(dl.due_at)} · {relativeDue(dl.due_at)}</span>
              {dl.url && <ExternalLink href={dl.url} className="text-xs text-[var(--primary)] underline underline-offset-2">打开链接</ExternalLink>}
              <Button variant="ghost" busy={action.busy} onClick={() => void done(dl)}>完成</Button>
            </li>
          ))}
        </ul>
      )}
      {interviews.length > 0 && (
        <ul className="space-y-1">
          {interviews.map(iv => (
            <li key={iv.id} className="flex flex-wrap items-center gap-2">
              <Badge tone="info">{INTERVIEW_ROUND_LABELS[iv.round] ?? iv.round}</Badge>
              <span className="text-[var(--ink)]">{formatDateTime(iv.date) === '未知' ? '时间未知' : formatDateTime(iv.date)}</span>
              {iv.interviewer_role_guess && <span className="text-xs text-[var(--muted)]">面试官可能是 {iv.interviewer_role_guess}</span>}
              <span className="text-xs text-[var(--muted)]">· {INTERVIEW_RESULT_LABELS[iv.result] ?? iv.result}</span>
            </li>
          ))}
        </ul>
      )}
    </Spread>
  );
}

function ResumeSent({ d, big }: { d: Dossier; big: boolean }) {
  const r = d.resume;
  const summary = r ? summarizeResumeSchema(r.schema) : null;
  return (
    <Spread title="投的是哪版简历" big={big}>
      {!r && <Muted>没有记录这条投递用了哪版简历。可以让助理按主简历给这个岗位改一版。</Muted>}
      {r && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={r.kind === 'tailored' ? 'accent' : 'neutral'}>{r.kind === 'tailored' ? '定制版' : '主简历'}</Badge>
          <Badge tone={r.confirmed ? 'success' : 'warning'}>{r.confirmed ? '已确认' : '未确认'}</Badge>
          <span className="text-xs text-[var(--subtle)]" title={r.id}>#{r.id.slice(0, 8)}</span>
          {summary && (
            <span className="text-xs text-[var(--muted)]">
              {summary.name ? `${summary.name} · ` : ''}{summary.experiences} 段经历 · {summary.projects} 个项目
            </span>
          )}
          <ExternalLink href={careerApi.resumeFilePath(r.id, 'pdf')} className="text-xs text-[var(--primary)] underline underline-offset-2">预览 PDF</ExternalLink>
        </div>
      )}
    </Spread>
  );
}

function SaidSection({ d, big }: { d: Dossier; big: boolean }) {
  const uses = d.material_uses ?? [];
  const said = (d.notes ?? []).filter(n => n.kind === 'said');
  const answers = d.answers_used;
  const empty = uses.length === 0 && said.length === 0 && !hasContent(answers);
  return (
    <Spread title="对这家公司说过的话" big={big}>
      {empty && <Muted>还没有记录。网申答案、邮件和面试里说过的话会汇总在这里，下一轮前后一致。</Muted>}
      {uses.length > 0 && (
        <ul className="space-y-1.5">
          {uses.map(u => (
            <li key={u.id} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                <Badge tone="accent">{u.context}</Badge>
                <span>{formatDate(u.used_at)}</span>
              </div>
              <ClampText text={u.content_snapshot} big={big} />
            </li>
          ))}
        </ul>
      )}
      {said.length > 0 && <NoteList notes={said} big={big} />}
      {hasContent(answers) && (
        <div>
          <div className="mb-1 text-xs text-[var(--muted)]">网申开放题答案</div>
          <StructuredJson value={answers} />
        </div>
      )}
    </Spread>
  );
}

function NoteList({ notes, big }: { notes: DossierNote[]; big: boolean }) {
  return (
    <ul className="space-y-1.5">
      {notes.map(n => (
        <li key={n.id} className="flex items-start gap-2">
          <Badge tone={n.kind === 'said' ? 'info' : 'neutral'}>{NOTE_KIND_LABELS[n.kind] ?? n.kind}</Badge>
          <div className="min-w-0 flex-1">
            <ClampText text={n.content} big={big} />
            <div className="text-xs text-[var(--subtle)]">{n.round ? `${INTERVIEW_ROUND_LABELS[n.round] ?? n.round} · ` : ''}{formatDate(n.created_at)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function HeardSection({ d, big }: { d: Dossier; big: boolean }) {
  const heard = (d.notes ?? []).filter(n => n.kind === 'heard' || n.kind === 'mail' || n.kind === 'contact' || n.kind === 'referral');
  const mails = d.mails ?? [];
  return (
    <Spread title="听到的 / 邮件往来" big={big}>
      {heard.length === 0 && mails.length === 0 && <Muted>还没有听到的信息或往来邮件。</Muted>}
      {heard.length > 0 && <NoteList notes={heard} big={big} />}
      {mails.length > 0 && (
        <ul className="space-y-1.5">
          {mails.map(m => (
            <li key={m.id} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={m.direction === 'in' ? 'info' : 'accent'}>{m.direction === 'in' ? '收' : '发'}</Badge>
                <span className={`min-w-0 flex-1 font-medium text-[var(--ink)] ${big ? 'text-base' : 'text-sm'}`}>{m.subject ?? '（无主题）'}</span>
                <span className="text-xs text-[var(--muted)]">{formatDateTime(m.received_at ?? m.created_at)}</span>
              </div>
              {m.snippet && <div className={`mt-1 text-[var(--muted)] ${big ? 'text-sm' : 'text-xs'}`}>{m.snippet}</div>}
            </li>
          ))}
        </ul>
      )}
    </Spread>
  );
}

function CompanySection({ d }: { d: Dossier }) {
  const c = d.company;
  const checks = c ? manualChecksOf(c.manual_checks) : [];
  return (
    <Spread title="公司调研">
      {!c && (
        <div className="flex flex-wrap items-center gap-2">
          <Muted>还没有这家公司的调研。</Muted>
          <ChatActionButton variant="secondary" text="帮我查查这家公司靠不靠谱" context={{ surface: 'dossier', refs: { application_id: d.application.id } }} />
        </div>
      )}
      {c && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {c.traffic_light
              ? <Badge tone={TRAFFIC_TONE[c.traffic_light] ?? 'neutral'}>{TRAFFIC_LIGHT_LABELS[c.traffic_light] ?? c.traffic_light}</Badge>
              : <Badge>未评级</Badge>}
            <span className="text-xs text-[var(--muted)]">{c.legal_name ?? textOrUnknown(d.job?.company_name)}</span>
          </div>
          {checks.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-sm text-[var(--ink)]">
              {checks.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          )}
        </div>
      )}
    </Spread>
  );
}

function PredictionsSection({ d }: { d: Dossier }) {
  const list = d.predictions ?? [];
  return (
    <Spread title="预测追问">
      {list.length === 0 && <Muted>还没有针对这版简历的追问预测。让助理准备面试时会生成。</Muted>}
      {list.length > 0 && (
        <ul className="space-y-1">
          {list.map(p => (
            <li key={p.id} className="flex items-start gap-2">
              <Badge tone={riskTone(p.risk)}>{p.risk}</Badge>
              <span className="text-sm text-[var(--ink)]">{p.statement}</span>
            </li>
          ))}
        </ul>
      )}
    </Spread>
  );
}

function PendingActions({ d, onChanged }: { d: Dossier; onChanged: () => void }) {
  const review = useCareerAction();
  const pending = (d.actions ?? []).filter(a => a.status === 'pending_review');
  const decide = (a: ActionQueueItem, decision: 'approved' | 'rejected') => review.run(async () => {
    await careerApi.reviewActions([a.id], decision);
    onChanged();
  });
  return (
    <Spread title="待审动作">
      {review.error && <ErrorRow message={review.error} />}
      {pending.length === 0 && <Muted>这条线上没有等你批准的动作。</Muted>}
      {pending.length > 0 && (
        <ul className="space-y-1.5">
          {pending.map(a => {
            const payload = safeJson<Record<string, unknown>>(a.payload_json, {});
            const isMail = a.kind === 'send_mail';
            const summary = typeof payload.summary === 'string' ? payload.summary : typeof payload.text === 'string' ? payload.text : null;
            return (
              <li key={a.id} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{ACTION_KIND_LABELS[a.kind] ?? a.kind}</Badge>
                  <span className="text-xs text-[var(--subtle)]">{formatDate(a.created_at)}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="primary" busy={review.busy} onClick={() => void decide(a, 'approved')}>{isMail ? '批准并发送' : '批准'}</Button>
                    <Button variant="danger" busy={review.busy} onClick={() => void decide(a, 'rejected')}>拒绝</Button>
                  </div>
                </div>
                {isMail && (
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    <div>收件人：{typeof payload.to === 'string' ? payload.to : '未知'}</div>
                    <div>主题：{typeof payload.subject === 'string' ? payload.subject : '未知'}</div>
                  </div>
                )}
                {summary && <div className="mt-1 text-sm text-[var(--ink)]">{summary}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </Spread>
  );
}

function Timeline({ d }: { d: Dossier }) {
  const history = d.history ?? [];
  return (
    <Spread title="时间线">
      {history.length === 0 && <Muted>还没有阶段变化。</Muted>}
      {history.length > 0 && (
        <ol className="space-y-0.5 text-xs">
          {history.map((h, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 tabular-nums text-[var(--subtle)]">{formatDate(h.created_at)}</span>
              <span className="text-[var(--ink)]">
                {h.from_stage ? `${STAGE_LABELS[h.from_stage as ApplicationStage] ?? h.from_stage} → ` : ''}
                {STAGE_LABELS[h.to_stage as ApplicationStage] ?? h.to_stage}
              </span>
              {h.note && <span className="text-[var(--muted)]">· {h.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </Spread>
  );
}

function NoteForm({ applicationId, onChanged }: { applicationId: string; onChanged: () => void }) {
  const [kind, setKind] = useState<DossierNote['kind']>('said');
  const [round, setRound] = useState('');
  const [content, setContent] = useState('');
  const action = useCareerAction();
  const submit = () => action.run(async () => {
    const text = content.trim();
    if (!text) throw new Error('先写点内容');
    await careerApi.addDossierNote(applicationId, { kind, round: round.trim() || null, content: text });
    setContent('');
    setRound('');
    onChanged();
  });
  return (
    <Spread title="记一笔">
      {action.error && <ErrorRow message={action.error} />}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[140px_140px_1fr]">
        <Field label="类型">
          <Select ariaLabel="记录类型" value={kind} onChange={v => setKind(v as DossierNote['kind'])} options={NOTE_KIND_OPTIONS} />
        </Field>
        <Field label="轮次（可选）">
          <TextInput aria-label="轮次" placeholder="如 一面" value={round} onChange={e => setRound(e.target.value)} />
        </Field>
        <Field label="内容" hint="面试里说过的关键信息记成“我说过”，下一轮前后一致">
          <TextArea aria-label="记录内容" placeholder="说过的数字、承诺的时间、听到的团队情况…" value={content} onChange={e => setContent(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" busy={action.busy} onClick={() => void submit()}>记下</Button>
      </div>
    </Spread>
  );
}
