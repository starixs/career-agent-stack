/**
 * 对话内工作面（specs/CAREER_DESIGN.md §5.7）的公共部分：
 *  - 哪些工具调用属于哪个工作面（浏览器 / 改简历 / 模拟面试 / 笔试练习）；
 *  - 收起态：挂在那次工具调用下面的打破式卡片（BreakoutCard.tsx），内容由 tool 返回的字段驱动；
 *  - 展开态：对话页右栏的统一外壳（标题 + 状态点 + 主动作 + 全屏 + 关闭，交接时的提示条）；
 *  - 改简历 / 模拟面试 / 笔试练习三个展开面板。浏览器面板在 components/career/CareerLiveDrawer.tsx。
 */
import { FileText, Globe, Maximize2, Minimize2, PenLine, Users, X, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';

import { careerApi } from '@/components/career/careerApi';
import { Button, LoadingRow } from '@/components/career/CareerPrimitives';
import type { CareerCard, ExamPractice, MockInterview } from '@/components/career/types';
import { useCareerQuery } from '@/components/career/useCareerData';
import { useTabStateOptional } from '@/context/TabContext';
import type { ToolUseSimple } from '@/types/chat';

import { BreakoutCard, ProgressAnchor, type BreakoutTone } from './BreakoutCard';
import { examContent, makeReveal, mockInterviewContent, pendingQuestion, resumeContent, type CardContent, type Reveal } from './cardContent';
import { requestNavigation } from './navModel';
import { collapseWorkSurface, expandWorkSurface, setWorkSurfaceFullscreen, useWorkSurfaces, type WorkSurface } from './workSurfaceStore';

const CareerResume = lazy(() => import('@/pages/CareerResume'));

// ─── 工具 → 工作面 ───

const TOOL_SURFACES: Record<string, WorkSurface> = {
  apply_prepare: 'browser',
  apply_run: 'browser',
  apply_continue: 'browser',
  apply_batch: 'browser',
  resume_master_create: 'resume',
  resume_save: 'resume',
  resume_tailor: 'resume',
  interview_probe: 'mock-interview',
  exam_practice: 'exam',
};

/** Career MCP tools arrive as `mcp__career__<name>`; plain names are accepted too. */
export function surfaceForTool(name: string | undefined): WorkSurface | null {
  if (!name) return null;
  const bare = name.replace(/^mcp__career__/, '');
  return TOOL_SURFACES[bare] ?? null;
}

interface SurfaceMeta { label: string; icon: LucideIcon; openLabel: string }

export const SURFACE_META: Record<WorkSurface, SurfaceMeta> = {
  browser: { label: '浏览器', icon: Globe, openLabel: '打开浏览器' },
  resume: { label: '改简历', icon: FileText, openLabel: '打开简历' },
  'mock-interview': { label: '模拟面试', icon: Users, openLabel: '打开模拟面试' },
  exam: { label: '笔试练习', icon: PenLine, openLabel: '打开笔试' },
};

export function parseToolResult(tool: Pick<ToolUseSimple, 'result'>): Record<string, unknown> | null {
  if (!tool.result) return null;
  try {
    const parsed = JSON.parse(tool.result) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The object a tool call is about: resume / mock interview / exam id. */
export function refIdForTool(surface: WorkSurface, tool: ToolUseSimple): string | null {
  const result = parseToolResult(tool) ?? {};
  const input = (tool.parsedInput ?? {}) as Record<string, unknown>;
  if (surface === 'resume') {
    const nested = (result.master ?? result.resume ?? result.tailored) as Record<string, unknown> | undefined;
    return str(result.tailored_id) ?? str(result.resume_id) ?? str(nested?.id) ?? str(input.resume_id) ?? str(input.master_id);
  }
  if (surface === 'mock-interview') return str(result.mock_interview_id);
  if (surface === 'exam') return str(result.exam_id) ?? str(input.exam_id);
  return null;
}

export { pendingQuestion } from './cardContent';

// ─── 收起态：打破式卡片（BreakoutCard.tsx） ───

type CardState = { tone: BreakoutTone; text: string };

function cardState(surface: WorkSurface, tool: ToolUseSimple, extra: { pendingDiff: boolean }): CardState {
  if (tool.isLoading) return { tone: 'running', text: '正在做…' };
  if (tool.isError || tool.isFailed) return { tone: 'error', text: '出错了，可以让小芽重试' };
  if (tool.isStopped) return { tone: 'idle', text: '已停止' };
  const result = parseToolResult(tool) ?? {};
  if (surface === 'resume' && extra.pendingDiff) return { tone: 'waiting', text: '这几处修改等你采纳' };
  if (surface === 'mock-interview' && pendingQuestion(tool)) return { tone: 'waiting', text: '轮到你回答' };
  if (surface === 'exam' && result.status === 'answering') {
    const total = Number(result.questions ?? 0);
    const answered = Number(result.answered ?? 0);
    if (total > answered) return { tone: 'waiting', text: `轮到你作答 · 已答 ${answered} / ${total}` };
  }
  return { tone: 'idle', text: '已完成 · 查看' };
}

/** 改简历卡片要显示本人信息：向本地取这份简历的「占位符 → 明文」对照表（只给界面预览，不进模型）。 */
function useResumeReveal(resumeId: string | null): Reveal {
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!resumeId) return;
    let alive = true;
    careerApi.getStudio(resumeId).then(out => { if (alive) setPreview(out.preview); }).catch(() => { /* 取不到就不显示占位符 */ });
    return () => { alive = false; };
  }, [resumeId]);
  return useMemo(() => makeReveal(preview), [preview]);
}

function ResumeCardContent({ tool, diffCard, refId, children }: { tool: ToolUseSimple; diffCard: CareerCard | undefined; refId: string | null; children: (content: CardContent) => ReactNode }) {
  const reveal = useResumeReveal(refId);
  return children(resumeContent(tool, diffCard, reveal));
}

function ExamCardContent({ tool, children }: { tool: ToolUseSimple; children: (content: CardContent) => ReactNode }) {
  const result = parseToolResult(tool) ?? {};
  const examId = str(result.exam_id) ?? str((tool.parsedInput as Record<string, unknown> | undefined)?.exam_id);
  const query = useCareerQuery(careerApi.examPractices, ['exam_practice']);
  const exam = examId ? (query.data ?? []).find(item => item.id === examId) ?? null : null;
  const { done, total, ...content } = examContent(tool, exam);
  return children({ ...content, anchor: <ProgressAnchor done={done} total={total} /> });
}

export function WorkSurfaceCard({ surface, tool }: { surface: Exclude<WorkSurface, 'browser'>; tool: ToolUseSimple }) {
  const tab = useTabStateOptional();
  const { expanded, refId: openRef } = useWorkSurfaces();
  const meta = SURFACE_META[surface];
  const refId = refIdForTool(surface, tool);
  const diffCard = surface === 'resume'
    ? (tab?.careerCards ?? []).find(card => card.kind === 'resume_diff' && ((refId && card.id.endsWith(`:${refId}`)) || card.toolUseId === tool.id))
    : undefined;
  const pendingDiff = Boolean(diffCard) && (diffCard?.state ?? 'pending') === 'pending';
  const state = cardState(surface, tool, { pendingDiff });
  const open = expanded === surface && (openRef ?? null) === (refId ?? null);
  const question = surface === 'mock-interview' ? pendingQuestion(tool) : null;

  const render = (content: CardContent) => (
    <BreakoutCard
      testId={`career-surface-card-${surface}`}
      anchor={content.anchor}
      title={content.title}
      aside={content.aside}
      overline={content.overline}
      rows={content.rows}
      status={state}
      open={open}
      action={{
        label: meta.openLabel,
        disabled: tool.isLoading && !refId,
        onOpen: () => {
          expandWorkSurface(surface, { refId, context: question });
          requestNavigation({ kind: 'chat' });
        },
      }}
    >
      {content.body}
    </BreakoutCard>
  );

  if (surface === 'exam') return <ExamCardContent tool={tool}>{render}</ExamCardContent>;
  if (surface === 'resume') return <ResumeCardContent tool={tool} diffCard={diffCard} refId={refId}>{render}</ResumeCardContent>;
  return render(mockInterviewContent(tool));
}

// ─── 展开态：右栏外壳 ───

export function SurfaceShell({ surface, status, primary, handoff, children }: {
  surface: WorkSurface;
  status: { tone: 'running' | 'waiting' | 'idle'; text: string };
  primary?: ReactNode;
  handoff?: { title: string; detail: string } | null;
  children: ReactNode;
}) {
  const { fullscreen } = useWorkSurfaces();
  const meta = SURFACE_META[surface];
  const dot = status.tone === 'running' ? 'bg-[var(--success)]' : status.tone === 'waiting' ? 'bg-[var(--warning)]' : 'bg-[var(--subtle)]';
  return (
    <section
      data-testid={`career-surface-panel-${surface}`}
      data-fullscreen={fullscreen ? 'true' : 'false'}
      aria-label={meta.label}
      className={fullscreen
        ? 'fixed inset-0 z-40 flex flex-col bg-[var(--side)]'
        : 'flex h-full min-w-0 flex-1 flex-col border-l border-[var(--line)] bg-[var(--side)]'}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="font-human text-lg font-semibold text-[var(--ink)]">{meta.label}</div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
            <span className="truncate">{status.text}</span>
          </div>
        </div>
        {primary}
        <Button variant="ghost" onClick={() => setWorkSurfaceFullscreen(!fullscreen)} aria-label={fullscreen ? '退出全屏' : '全屏'}>
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" onClick={() => collapseWorkSurface(surface)} aria-label={`收起${meta.label}`}><X className="h-3.5 w-3.5" /></Button>
      </header>
      {handoff && (
        <div role="status" className="mx-5 mt-3 rounded-lg border border-[var(--hard)] bg-[var(--note)] px-3.5 py-2.5 text-sm text-[var(--ink)] shadow-hard">
          <div className="font-human font-semibold">{handoff.title}</div>
          <div className="text-xs text-[var(--ink-2)]">{handoff.detail}</div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

// ─── 改简历 ───

export function ResumeSurfacePanel() {
  const { refId, nonce } = useWorkSurfaces();
  const tab = useTabStateOptional();
  const pendingDiff = (tab?.careerCards ?? []).some(card => card.kind === 'resume_diff' && (card.state ?? 'pending') === 'pending' && (!refId || card.id.endsWith(`:${refId}`)));
  return (
    <SurfaceShell
      surface="resume"
      status={pendingDiff ? { tone: 'waiting', text: '有修改等你采纳' } : { tone: 'idle', text: '自动保存，小芽会读到最新内容' }}
      handoff={pendingDiff ? { title: '这几处修改等你采纳', detail: '在对话里的「简历改动」卡片上勾选要采纳的几处，再点应用；没勾的不会改。' } : null}
    >
      <Suspense fallback={<div className="px-5"><LoadingRow /></div>}>
        <div className="h-full">
          <CareerResume key={`${refId ?? 'default'}:${nonce}`} initialResumeId={refId} />
        </div>
      </Suspense>
    </SurfaceShell>
  );
}

// ─── 模拟面试 ───

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function reportLines(report: unknown): Array<{ label: string; text: string }> {
  if (!report || typeof report !== 'object') return typeof report === 'string' ? [{ label: '复盘', text: report }] : [];
  return Object.entries(report as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => ({ label, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }));
}

export function MockInterviewSurfacePanel() {
  const { refId, context } = useWorkSurfaces();
  const query = useCareerQuery(careerApi.mockInterviews, ['mock_interview']);
  const record: MockInterview | null = (query.data ?? []).find(item => item.id === refId) ?? (refId ? null : query.data?.[0] ?? null);
  const report = parseJson<unknown>(record?.report_json, null);
  const turns = parseJson<Array<{ transcript?: string }>>(record?.turns_json, []);
  const waiting = Boolean(context) && !report;
  return (
    <SurfaceShell
      surface="mock-interview"
      status={report ? { tone: 'idle', text: '已结束 · 复盘在下面' } : waiting ? { tone: 'waiting', text: '轮到你回答' } : { tone: 'idle', text: record ? `${record.round ?? '面试'} · ${record.company_type ?? ''}` : '模拟面试' }}
      handoff={waiting ? { title: '轮到你回答', detail: '直接在对话框里说你的回答，小芽会接着追问；想结束就说「结束并复盘」。' } : null}
    >
      <div className="space-y-4 px-5 py-4">
        {query.loading && !query.data && <LoadingRow />}
        {context && (
          <div>
            <div className="mb-1 text-xs text-[var(--muted)]">当前问题</div>
            <p className="rounded-lg bg-[var(--paper)] px-4 py-3 font-human text-base text-[var(--ink)] shadow-sm">{context}</p>
          </div>
        )}
        {turns.some(turn => turn.transcript) && (
          <div>
            <div className="mb-1 text-xs text-[var(--muted)]">到目前为止的问答</div>
            <pre className="whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 font-sans text-sm leading-6 text-[var(--ink-2)]">{turns.map(turn => turn.transcript).filter(Boolean).join('\n\n')}</pre>
          </div>
        )}
        {report !== null && (
          <div>
            <div className="mb-1 text-xs text-[var(--muted)]">面试官视角复盘</div>
            <dl className="space-y-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-sm">
              {reportLines(report).map(line => (
                <div key={line.label}>
                  <dt className="font-medium text-[var(--ink)]">{line.label}</dt>
                  <dd className="whitespace-pre-wrap text-[var(--ink-2)]">{line.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {!query.loading && !record && !context && <p className="text-sm text-[var(--subtle)]">还没有这场模拟面试的记录。</p>}
      </div>
    </SurfaceShell>
  );
}

// ─── 笔试练习 ───

interface ExamQuestion { q: string; kind?: string; options?: string[] }
interface ExamAnswer { index: number; answer: string }
interface ExamReview { index: number; verdict: '对' | '错' | '部分对'; comment?: string }

const VERDICT_TONE: Record<ExamReview['verdict'], string> = {
  对: 'text-[var(--success)]',
  错: 'text-[var(--danger)]',
  部分对: 'text-[var(--warning)]',
};

export function ExamSurfacePanel() {
  const { refId } = useWorkSurfaces();
  const query = useCareerQuery(careerApi.examPractices, ['exam_practice']);
  const exam = (query.data ?? []).find(item => item.id === refId) ?? (refId ? null : query.data?.[0] ?? null);
  return <ExamSurfaceView exam={exam} loading={query.loading && !query.data} />;
}

export function ExamSurfaceView({ exam, loading }: { exam: ExamPractice | null; loading: boolean }) {
  const questions = parseJson<ExamQuestion[]>(exam?.questions_json, []);
  const answers = new Map(parseJson<ExamAnswer[]>(exam?.answers_json, []).map(answer => [answer.index, answer.answer]));
  const reviews = new Map(parseJson<ExamReview[]>(exam?.review_json, []).map(review => [review.index, review]));
  const unanswered = questions.length - answers.size;
  const waiting = exam?.status === 'answering' && unanswered > 0;
  const correct = [...reviews.values()].filter(review => review.verdict === '对').length;
  return (
    <SurfaceShell
      surface="exam"
      status={exam?.status === 'reviewed'
        ? { tone: 'idle', text: `已批改 · 对 ${correct} / ${questions.length}` }
        : waiting ? { tone: 'waiting', text: `轮到你作答 · 已答 ${answers.size} / ${questions.length}` } : { tone: 'idle', text: exam ? exam.title : '还没有记录' }}
      handoff={waiting ? { title: '轮到你作答', detail: '在对话框里按题号回答，比如「1. B　2. 16」；答完说「交卷」，小芽会逐题批改。' } : null}
    >
      <div className="space-y-3 px-5 py-4">
        {loading && <LoadingRow />}
        {exam && <div className="font-human text-base font-semibold text-[var(--ink)]">{exam.title}</div>}
        <ol className="space-y-3">
          {questions.map((question, index) => {
            const review = reviews.get(index);
            const answer = answers.get(index);
            return (
              <li key={index} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
                <div className="flex gap-2 text-sm text-[var(--ink)]">
                  <span className="shrink-0 font-semibold tabular-nums">{index + 1}.</span>
                  <span className="whitespace-pre-wrap">{question.q}</span>
                </div>
                {question.options && question.options.length > 0 && (
                  <ul className="mt-1.5 grid gap-1 pl-5 text-sm text-[var(--ink-2)]">
                    {question.options.map(option => <li key={option}>{option}</li>)}
                  </ul>
                )}
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-5 text-xs">
                  <span className={answer ? 'text-[var(--ink-2)]' : 'text-[var(--subtle)]'}>你的作答：{answer ?? '还没答'}</span>
                  {review && (
                    <span className={`inline-flex items-center border-l-[3px] border-current pl-2 font-medium ${VERDICT_TONE[review.verdict]}`}>{review.verdict}</span>
                  )}
                </div>
                {review?.comment && <p className="mt-1 pl-5 text-xs text-[var(--muted)]">{review.comment}</p>}
              </li>
            );
          })}
        </ol>
        {exam?.summary && (
          <div className="rounded-lg bg-[var(--mint)] px-4 py-3 text-sm text-[var(--ink-2)]">
            <div className="font-human font-semibold text-[var(--ink)]">总结</div>
            {exam.summary}
          </div>
        )}
        {!loading && !exam && <p className="text-sm text-[var(--subtle)]">还没有这次笔试练习的记录。</p>}
      </div>
    </SurfaceShell>
  );
}

/** Picks the expanded non-browser panel; the browser panel is rendered by Chat directly. */
export function ExpandedWorkSurfacePanel({ surface }: { surface: Exclude<WorkSurface, 'browser'> }) {
  if (surface === 'resume') return <ResumeSurfacePanel />;
  if (surface === 'mock-interview') return <MockInterviewSurfacePanel />;
  return <ExamSurfacePanel />;
}

/** Hook-free helper so Message.tsx can split a block group into surface cards. */
export function surfaceToolsIn(tools: readonly (ToolUseSimple | undefined)[]): Array<{ surface: WorkSurface; tool: ToolUseSimple }> {
  const out: Array<{ surface: WorkSurface; tool: ToolUseSimple }> = [];
  for (const tool of tools) {
    const surface = tool ? surfaceForTool(tool.name) : null;
    if (tool && surface) out.push({ surface, tool });
  }
  return out;
}
