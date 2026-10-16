/**
 * 卷宗：每条投递一个档案。面试当天一键摊开——投的是哪版简历、对这家说过什么、听到什么、邮件与截止、历史轮次。
 * 视图：投递记录 / 岗位收藏 / 助力记录（笔试、面试、模拟面试合一）；面试工作台和 Offer 对比从功能市场打开。
 */
import { ArrowLeft, ExternalLink as ExternalLinkIcon, Search, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { onEvent } from '@/api/eventBus';
import { ExternalLink } from '@/components/ExternalLink';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { Popover } from '@/components/ui/Popover';
import { CompactStepper, FullStepper } from '@/components/career/ApplicationStepper';
import { AssistRecords } from '@/components/career/AssistRecords';
import { applicationStepper } from '@/components/career/applicationSteps';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { ACTION_KIND_LABELS, INTERVIEW_RESULT_LABELS, INTERVIEW_ROUND_LABELS, STAGE_LABELS, STAGE_TONES, TRAFFIC_LIGHT_LABELS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, ChatActionButton, EmptyState, ErrorRow, Field, LoadingRow, Select, StructuredJson, TextArea, TextInput,
  formatDate, textOrUnknown,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type {
  ActionQueueItem, ApplicationStage, CareerFocusEvent, Deadline, DeadlineKind, Dossier, DossierNote, DossierSummary,
} from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';
import { DEFAULT_SUB_VIEWS } from '@/features/career-shell/navModel';
import { PageAskBar } from '@/features/career-shell/PageAskBar';
import { takeCareerFocus } from '@/features/career-shell/pendingFocus';
import { useCareerSubView } from '@/features/career-shell/subViewStore';
import { useCloseLayer } from '@/hooks/useCloseLayer';

const CareerApply = lazy(() => import('@/pages/CareerApply'));
const CareerInterview = lazy(() => import('@/pages/CareerInterview'));
const CareerOffer = lazy(() => import('@/pages/CareerOffer'));

// 子视图由二级导航选择（features/career-shell/navModel.ts），页面本身不再放切换控件。
type View = 'line' | 'apply' | 'assist' | 'interview' | 'offer';
const VIEW_HEADINGS: Record<View, { title: string; subtitle: string }> = {
  apply: { title: '岗位收藏', subtitle: '想投的岗位和准备好的申请' },
  line: { title: '投递记录', subtitle: '每条投递一个档案' },
  assist: { title: '助力记录', subtitle: '笔试、面试、模拟面试，每一次助力都在这里' },
  interview: { title: '面试工作台', subtitle: '面试记录、题库、模拟面试和深挖点预测' },
  offer: { title: 'Offer 对比', subtitle: '把拿到的 Offer 放在一起比' },
};
/** 已合并进助力记录的旧视图。 */
const RENAMED_VIEWS: Record<string, View> = { exam: 'assist' };

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
  return STAGE_TONES[stage] ?? 'neutral';
}

function daysSince(iso: string | null | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 86_400_000)) : 0;
}

function isStale(stage: ApplicationStage, days: number): boolean {
  return days >= 14 && ACTIVE_STAGES.has(stage);
}

/** 截止时间相对现在：今天 / 明天 / x 天后 / 已过 x 天。 */
function relativeDue(iso: string | null): string {
  if (!iso) return '时间待定';
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
  const [storedView, setView] = useCareerSubView<View>('career-dossier', DEFAULT_SUB_VIEWS['career-dossier']);
  const view: View = RENAMED_VIEWS[storedView] ?? (storedView in VIEW_HEADINGS ? storedView : DEFAULT_SUB_VIEWS['career-dossier']);
  // 从别的面（小芽面板、今日）跳进来时，事件可能在本页挂载前就发了
  const [focus, setFocus] = useState<FocusRequest | null>(() => {
    const pending = takeCareerFocus('dossier');
    return pending ? { application_id: pending.application_id ?? pending.id ?? null, job_id: pending.job_id ?? null } : null;
  });

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'dossier') return;
    setView('line');
    setFocus({ application_id: payload.application_id ?? payload.id ?? null, job_id: payload.job_id ?? null });
  }), [setView]);

  const heading = VIEW_HEADINGS[view] ?? VIEW_HEADINGS.line;
  return (
    <CareerPage
      embedded={embedded}
      title={heading.title}
      subtitle={heading.subtitle}
    >
      {view === 'line' && <DossierLine focus={focus} />}
      {view === 'assist' && <AssistRecords />}
      {view === 'assist' && <PageAskBar target={{ kind: 'career-dossier', view }} placeholder="问问笔试面试安排，比如「下周有哪些笔试和面试」" />}
      {view !== 'line' && view !== 'assist' && (
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
  // 手动选择记住它是在哪次焦点之后做的：新焦点到来时焦点优先，之后用户再点（或返回列表）则用户优先。全部是派生，不在 effect 里写 state。
  const [manual, setManual] = useState<{ id: string | null; afterFocus: FocusRequest | null } | null>(null);
  const [search, setSearch] = useState('');
  const [interviewMode, setInterviewMode] = useState(false);
  const [jdFor, setJdFor] = useState<DossierSummary | null>(null);
  const select = (id: string | null) => setManual({ id, afterFocus: focus });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = summaries ?? [];
    return (q ? list.filter(s => `${s.company_name ?? ''} ${s.title}`.toLowerCase().includes(q)) : [...list])
      .sort((x, y) => submittedAt(y).localeCompare(submittedAt(x)));
  }, [summaries, search]);

  const effectiveId = manual && manual.afterFocus === focus ? manual.id : focus ? resolveFocus(focus, summaries) : null;
  const selectedSummary = summaries?.find(s => s.application_id === effectiveId) ?? null;
  // 页面输入框跟着当前摊开的档案走：问的就是这一条（application_id 带给助理）。
  const askBar = (
    <PageAskBar
      target={{ kind: 'career-dossier', view: 'line' }}
      refs={effectiveId ? { application_id: effectiveId } : undefined}
      placeholder={effectiveId ? '问问这条投递，比如「下一步该做什么」' : '问问投递情况，比如「这个月投了多少、几个进了面试」'}
    />
  );

  if (effectiveId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => select(null)}><ArrowLeft className="h-4 w-4" />投递记录</Button>
          {selectedSummary && <span className="min-w-0 truncate text-xs text-[var(--muted)]">{selectedSummary.company_name ?? '未知公司'} · {selectedSummary.title}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <DossierDetail
            key={effectiveId}
            id={effectiveId}
            summary={selectedSummary}
            interviewMode={interviewMode}
            onToggleInterviewMode={() => setInterviewMode(v => !v)}
            onListChanged={query.reload}
          />
        </div>
        {askBar}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-6 pb-2 pt-4">
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--subtle)]" strokeWidth={1.75} aria-hidden />
          <TextInput aria-label="搜索投递线" placeholder="搜公司或岗位" value={search} onChange={e => setSearch(e.target.value)} className="!h-8 !w-56 pl-8" />
        </label>
        {summaries && <span className="text-xs tabular-nums text-[var(--muted)]">{rows.length} 条投递</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !summaries && <LoadingRow />}
        {summaries && summaries.length === 0 && (
          <EmptyState title="还没有投递" hint="投出去之后每条线会在这里有一份档案：面试当天一键看到投的哪版简历、说过什么、听到什么、邮件和截止。" example="帮我准备这场面试" />
        )}
        {rows.length > 0 && (
          <table className="w-full min-w-[720px] table-fixed border-collapse text-sm">
            <thead className="text-left text-xs text-[var(--muted)] [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[var(--bg)] [&_th]:shadow-[inset_0_-1px_0_var(--line-2)]">
              <tr>
                <th className="w-[180px] px-2 py-2 font-medium">公司</th>
                <th className="px-2 py-2 font-medium">岗位</th>
                <th className="w-[112px] px-2 py-2 font-medium">投递时间</th>
                <th className="w-[280px] px-2 py-2 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(s => <LineRow key={s.application_id} summary={s} onOpen={() => select(s.application_id)} onShowJd={() => setJdFor(s)} />)}
            </tbody>
          </table>
        )}
        {summaries && summaries.length > 0 && rows.length === 0 && <div className="py-8 text-center text-xs text-[var(--subtle)]">没有匹配「{search.trim()}」的投递</div>}
      </div>
      {jdFor && <JdDialog summary={jdFor} onClose={() => setJdFor(null)} onOpenDossier={() => { setJdFor(null); select(jdFor.application_id); }} />}
      {askBar}
    </div>
  );
}

/** 投递时间：第一次进入「已投递」的时刻；还没投出去的按建档时间排。 */
function submittedAt(s: DossierSummary): string {
  return s.applied_at ?? s.created_at ?? s.updated_at;
}

/** 整行可点（Enter 也行）打开档案；岗位名单独可点，看 JD；状态格浮出完整步骤条。行内控件阻止冒泡（7.5）。 */
function LineRow({ summary, onOpen, onShowJd }: { summary: DossierSummary; onOpen: () => void; onShowJd: () => void }) {
  const company = summary.company_name ?? '未知公司';
  const days = summary.days_since_update;
  const quiet = days >= 7 && ACTIVE_STAGES.has(summary.stage);
  return (
    <tr
      tabIndex={0}
      aria-label={`${company} · ${summary.title}`}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}
      className={`cursor-pointer border-b border-[var(--line)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)] ${summary.stage === 'discarded' ? 'text-[var(--subtle)]' : ''}`}
    >
      <td className="truncate px-2 py-2 font-medium text-[var(--ink)]" title={company}>{company}</td>
      <td className="px-2 py-2">
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onShowJd(); }}
          onKeyDown={e => e.stopPropagation()}
          title={`查看 JD：${summary.title}`}
          className="block max-w-full truncate rounded-sm text-left text-[var(--ink-2)] underline decoration-[var(--line-2)] decoration-dotted underline-offset-4 hover:text-[var(--primary)] hover:decoration-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        >
          {summary.title}
        </button>
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-xs tabular-nums text-[var(--muted)]" title={summary.applied_at ? undefined : '还没投出去'}>
        {summary.applied_at ? formatDate(summary.applied_at) : <span className="text-[var(--subtle)]">未投出</span>}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5">
        <StatusCell summary={summary} />
        {quiet && <span className={`ml-2 text-xs ${days >= 14 ? 'text-[var(--warning)]' : 'text-[var(--subtle)]'}`}>{days} 天无动静</span>}
      </td>
    </tr>
  );
}

/** 行内紧凑步骤条；鼠标移上 / 键盘聚焦 / 点击时浮出完整的带文字步骤条。 */
function StatusCell({ summary }: { summary: DossierSummary }) {
  const model = useMemo(() => applicationStepper(summary), [summary]);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const open = hover || pinned;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        aria-label={`投递状态：${model.label}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={e => { e.stopPropagation(); setPinned(v => !v); }}
        onKeyDown={e => e.stopPropagation()}
        className="inline-flex rounded-sm py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        <CompactStepper model={model} />
      </button>
      <Popover open={open} onClose={() => { setPinned(false); setHover(false); }} anchorRef={anchor} placement="bottom-start" zIndex={50} className="w-[360px] p-3">
        <div className="space-y-2">
          <FullStepper model={model} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--line)] pt-2 text-xs text-[var(--muted)]">
            <Badge tone={stageTone(summary.stage)}>{STAGE_LABELS[summary.stage] ?? summary.stage}</Badge>
            {summary.next_deadline && <span>{summary.next_deadline.title} · {relativeDue(summary.next_deadline.due_at)}</span>}
            {summary.interview_count > 0 && <span>面试 {summary.interview_count} 轮</span>}
          </div>
        </div>
      </Popover>
    </>
  );
}

/** 岗位 JD：从卷宗里取岗位原文；没有原文时给标题和链接。 */
function JdDialog({ summary, onClose, onOpenDossier }: { summary: DossierSummary; onClose: () => void; onOpenDossier: () => void }) {
  const query = useCareerQuery(() => careerApi.dossier(summary.application_id), ['job']);
  const job = query.data?.job;
  const url = job?.url ?? summary.job_url ?? null;
  const jd = job?.jd_raw?.trim() || null;
  // 关闭后焦点回到打开它的岗位名（7.6）
  const [returnFocus] = useState<Element | null>(() => (typeof document !== 'undefined' ? document.activeElement : null));
  const close = useCallback(() => {
    onClose();
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  }, [onClose, returnFocus]);
  useCloseLayer(() => { close(); return true; }, 60);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <OverlayBackdrop onClose={close} className="z-[60] px-4" portal>
      <div role="dialog" aria-modal="true" aria-label={`${summary.title} 的 JD`} className="flex max-h-[80vh] w-full max-w-[640px] flex-col rounded-2xl border border-[var(--line)] bg-[var(--paper)] shadow-lg">
        <div className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-[var(--muted)]">{summary.company_name ?? '未知公司'}</div>
            <h2 className="font-human text-lg font-semibold text-[var(--ink)]">{summary.title}</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={close} className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
          {query.loading && !query.data && <LoadingRow text="取 JD…" />}
          {query.data && (jd
            ? <div className="max-w-[40em] whitespace-pre-wrap break-words text-base leading-7 text-[var(--ink)]">{jd}</div>
            : <Muted>没有保存这个岗位的 JD 原文{url ? '，可以打开岗位页面看。' : '。'}</Muted>)}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--line)] px-5 py-3">
          {url && <ExternalLink href={url} className="inline-flex items-center gap-1 text-sm text-[var(--primary)] hover:underline"><ExternalLinkIcon className="h-4 w-4" strokeWidth={1.75} />岗位页面</ExternalLink>}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onOpenDossier}>打开档案</Button>
        </div>
      </div>
    </OverlayBackdrop>
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
    <div className={`max-w-4xl space-y-8 px-6 py-5 ${big ? 'text-base' : ''}`}>
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
          <div className={`font-human font-semibold text-[var(--ink)] ${interviewMode ? 'text-3xl' : 'text-2xl'}`}>{textOrUnknown(d.job?.company_name)}</div>
          <h2 className={`mt-0.5 font-medium text-[var(--ink-2)] ${interviewMode ? 'text-lg' : 'text-base'}`}>{d.job?.title ?? '未知岗位'}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
            <Badge tone={stageTone(stage)}>{STAGE_LABELS[stage] ?? stage}</Badge>
            <span>{days === 0 ? '今天有更新' : `${days} 天没有更新`}</span>
            {d.job?.location && <span>{d.job.location}</span>}
            {d.job?.url && <ExternalLink href={d.job.url} className="text-[var(--primary)] underline underline-offset-2">岗位页面</ExternalLink>}
          </div>
        </div>
        <Button variant={interviewMode ? 'primary' : 'ghost'} aria-pressed={interviewMode} onClick={onToggleInterviewMode}>
          {interviewMode ? '退出面试模式' : '面试模式'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ChatActionButton text="帮我准备这场面试" context={{ surface: 'dossier', refs: { application_id: app.id } }} />
        <ChatActionButton variant="ghost" text="用主简历给这个岗位改一版简历" context={{ surface: 'dossier', refs }} />
        <ChatActionButton variant="ghost" text="帮我给这个岗位写投递邮件" context={{ surface: 'dossier', refs }} />
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
        <div role="status" className="flex flex-wrap items-center gap-2 border-l-[3px] border-[var(--warning)] pl-3 text-sm text-[var(--ink-2)]">
          <span className="min-w-0 flex-1">已经 {days} 天没有动静。沉默比被拒常见，可以关掉这条线，把注意力留给别处。</span>
          <Button variant="ghost" size="sm" busy={closeAction.busy} onClick={() => void close()}>关闭这条线</Button>
        </div>
      )}
    </header>
  );
}

function Spread({ title, extra, big = false, children }: { title: string; extra?: ReactNode; big?: boolean; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className={`font-semibold text-[var(--ink)] ${big ? 'text-base' : 'text-sm'}`}>{title}</h3>
        {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
      </div>
      <div className={big ? 'space-y-3 text-base' : 'space-y-2 text-sm'}>{children}</div>
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div className="text-sm text-[var(--muted)]">{children}</div>;
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
        <ul className="divide-y divide-[var(--line)]">
          {upcoming.map(dl => (
            <li key={dl.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Badge tone="accent">{DEADLINE_KIND_LABELS[dl.kind] ?? dl.kind}</Badge>
              <span className={`min-w-0 flex-1 font-medium text-[var(--ink)] ${big ? 'text-lg' : ''}`}>{dl.title}</span>
              <span className="text-xs tabular-nums text-[var(--muted)]">{dl.due_at ? `${formatDateTime(dl.due_at)} · ${relativeDue(dl.due_at)}` : '时间未知'}</span>
              {dl.url && <ExternalLink href={dl.url} className="text-xs text-[var(--primary)] underline underline-offset-2">打开链接</ExternalLink>}
              <Button variant="ghost" size="sm" busy={action.busy} onClick={() => void done(dl)}>完成</Button>
            </li>
          ))}
        </ul>
      )}
      {interviews.length > 0 && (
        <ul className="space-y-1.5">
          {interviews.map(iv => (
            <li key={iv.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge tone="accent">{INTERVIEW_ROUND_LABELS[iv.round] ?? iv.round}</Badge>
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
        <ul className="space-y-3">
          {uses.map(u => (
            <li key={u.id} className="border-l-2 border-[var(--line-2)] pl-3">
              <div className="mb-1 flex flex-wrap items-center gap-x-3 text-xs text-[var(--muted)]">
                <span className="font-medium text-[var(--ink-2)]">{u.context}</span>
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
        <li key={n.id} className="flex items-start gap-3">
          <span className="w-12 shrink-0 pt-0.5 text-xs font-medium text-[var(--muted)]">{NOTE_KIND_LABELS[n.kind] ?? n.kind}</span>
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
        <ul className="divide-y divide-[var(--line)]">
          {mails.map(m => (
            <li key={m.id} className="py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-xs font-medium text-[var(--muted)]">{m.direction === 'in' ? '收' : '发'}</span>
                <span className={`min-w-0 flex-1 font-medium text-[var(--ink)] ${big ? 'text-base' : 'text-sm'}`}>{m.subject ?? '（无主题）'}</span>
                <span className="text-xs tabular-nums text-[var(--muted)]">{formatDateTime(m.received_at ?? m.created_at)}</span>
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
          <ChatActionButton variant="ghost" size="sm" text="帮我查查这家公司靠不靠谱" context={{ surface: 'dossier', refs: { application_id: d.application.id } }} />
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
        <ul className="space-y-3">
          {pending.map(a => {
            const payload = safeJson<Record<string, unknown>>(a.payload_json, {});
            const isMail = a.kind === 'send_mail';
            const summary = typeof payload.summary === 'string' ? payload.summary : typeof payload.text === 'string' ? payload.text : null;
            return (
              <li key={a.id} className="rounded-lg border-[1.5px] border-[var(--hard)] bg-[var(--paper)] p-4 shadow-hard-lg">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{ACTION_KIND_LABELS[a.kind] ?? a.kind}</Badge>
                  <span className="text-xs text-[var(--subtle)]">{formatDate(a.created_at)}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="primary" busy={review.busy} onClick={() => void decide(a, 'approved')}>{isMail ? '批准并发送' : '批准'}</Button>
                    <Button variant="ghost" busy={review.busy} onClick={() => void decide(a, 'rejected')}>不发了</Button>
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
