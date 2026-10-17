/**
 * 投递记录：一张表列出每条投递走到哪一步；点一行看岗位（JD 与岗位页面）。不再有单条投递的档案页——
 * 投的哪版简历、说过什么、面试准备都交给助理在对话里摊开。
 * 视图：投递记录 / 岗位收藏 / 助力记录（笔试、面试、模拟面试合一）；面试工作台和 Offer 对比从功能市场打开。
 */
import { ExternalLink as ExternalLinkIcon, Search, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { onEvent } from '@/api/eventBus';
import { ExternalLink } from '@/components/ExternalLink';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { Popover } from '@/components/ui/Popover';
import { CompactStepper, FullStepper } from '@/components/career/ApplicationStepper';
import { AssistRecords } from '@/components/career/AssistRecords';
import { applicationStepper } from '@/components/career/applicationSteps';
import { careerApi } from '@/components/career/careerApi';
import { STAGE_LABELS, STAGE_TONES } from '@/components/career/careerConstants';
import { Badge, CareerPage, EmptyState, ErrorRow, LoadingRow, TextInput, formatDate } from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type { ApplicationStage, CareerFocusEvent, DossierSummary } from '@/components/career/types';
import { useCareerQuery } from '@/components/career/useCareerData';
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
  line: { title: '投递记录', subtitle: '投了哪些，走到了哪一步' },
  assist: { title: '助力记录', subtitle: '笔试、面试、模拟面试，每一次助力都在这里' },
  interview: { title: '面试工作台', subtitle: '面试记录、题库、模拟面试和深挖点预测' },
  offer: { title: 'Offer 对比', subtitle: '把拿到的 Offer 放在一起比' },
};
/** 已合并进助力记录的旧视图。 */
const RENAMED_VIEWS: Record<string, View> = { exam: 'assist' };

const DOSSIER_TABLES = ['application', 'application_history', 'job', 'deadline', 'interview', 'dossier_note', 'mail_message', 'material_use', 'offer', 'action_queue'] as const;

const ACTIVE_STAGES: ReadonlySet<ApplicationStage> = new Set(['applied', 'responded', 'interview']);
// ─── 本地小工具 ───

function stageTone(stage: ApplicationStage): BadgeTone {
  return STAGE_TONES[stage] ?? 'neutral';
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
  const [search, setSearch] = useState('');
  const [jdFor, setJdFor] = useState<DossierSummary | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = summaries ?? [];
    return (q ? list.filter(s => `${s.company_name ?? ''} ${s.title}`.toLowerCase().includes(q)) : [...list])
      .sort((x, y) => submittedAt(y).localeCompare(submittedAt(x)));
  }, [summaries, search]);

  // 别处跳过来（小芽面板、消息、今日）：不再摊开档案，只在列表里高亮那一条并滚过去
  const focusedId = focus ? resolveFocus(focus, summaries) : null;

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
          <EmptyState title="还没有投递" hint="投出去之后每条投递都会列在这里：投到哪一步、有没有面试和截止。" example="这个月投了多少、几个进了面试" />
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
              {rows.map(s => <LineRow key={s.application_id} summary={s} focused={s.application_id === focusedId} onShowJd={() => setJdFor(s)} />)}
            </tbody>
          </table>
        )}
        {summaries && summaries.length > 0 && rows.length === 0 && <div className="py-8 text-center text-xs text-[var(--subtle)]">没有匹配「{search.trim()}」的投递</div>}
      </div>
      {jdFor && <JdDialog summary={jdFor} onClose={() => setJdFor(null)} />}
      <PageAskBar target={{ kind: 'career-dossier', view: 'line' }} placeholder="问问投递情况，比如「这个月投了多少、几个进了面试」" />
    </div>
  );
}

/** 投递时间：第一次进入「已投递」的时刻；还没投出去的按建档时间排。 */
function submittedAt(s: DossierSummary): string {
  return s.applied_at ?? s.created_at ?? s.updated_at;
}

/** 整行可点（Enter 也行）看这个岗位（JD 原文 + 岗位页面）；状态格浮出完整步骤条。行内控件阻止冒泡（7.5）。 */
function LineRow({ summary, focused, onShowJd }: { summary: DossierSummary; focused: boolean; onShowJd: () => void }) {
  const company = summary.company_name ?? '未知公司';
  const days = summary.days_since_update;
  const quiet = days >= 7 && ACTIVE_STAGES.has(summary.stage);
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }, [focused]);
  return (
    <tr
      ref={ref}
      tabIndex={0}
      aria-label={`${company} · ${summary.title}`}
      title={`查看岗位：${summary.title}`}
      onClick={onShowJd}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onShowJd(); }}
      className={`cursor-pointer border-b border-[var(--line)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)] ${focused ? 'bg-[var(--hover)] shadow-[inset_3px_0_0_var(--primary)]' : ''} ${summary.stage === 'discarded' ? 'text-[var(--subtle)]' : ''}`}
    >
      <td className="truncate px-2 py-2 font-medium text-[var(--ink)]" title={company}>{company}</td>
      <td className="truncate px-2 py-2 text-[var(--ink-2)]" title={summary.title}>{summary.title}</td>
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
function JdDialog({ summary, onClose }: { summary: DossierSummary; onClose: () => void }) {
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
            : <p className="text-sm text-[var(--muted)]">没有保存这个岗位的 JD 原文{url ? '，可以打开岗位页面看。' : '。'}</p>)}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--line)] px-5 py-3">
          {url && <ExternalLink href={url} className="inline-flex items-center gap-1 text-sm text-[var(--primary)] hover:underline"><ExternalLinkIcon className="h-4 w-4" strokeWidth={1.75} />岗位页面</ExternalLink>}
        </div>
      </div>
    </OverlayBackdrop>
  );
}
