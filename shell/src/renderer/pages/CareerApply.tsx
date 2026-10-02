/**
 * 岗位与投递：看板三问题（今天必须做 / 哪里卡住 / 漏斗）、待审核动作、岗位池与阶段流转、浏览器状态条。
 */
import { Link2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ExternalLink } from '@/components/ExternalLink';
import { BrowserStatusBar } from '@/components/career/BrowserStatusBar';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { ACTION_KIND_LABELS, FUNNEL_ORDER, STAGE_LABELS, STAGE_TRANSITIONS } from '@/components/career/careerConstants';
import {
  Badge, Button, CareerPage, Card, EmptyState, ErrorRow, LoadingRow, SectionTitle, Select, TextInput,
  formatDate, textOrUnknown,
} from '@/components/career/CareerPrimitives';
import type { BadgeTone } from '@/components/career/CareerPrimitives';
import type { ActionQueueItem, Application, ApplicationStage, Board, Job } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

interface ApplyData { board: Board; actions: ActionQueueItem[]; jobs: Job[]; applications: Application[] }

async function loadAll(): Promise<ApplyData> {
  const [board, actions, jobs, applications] = await Promise.all([
    careerApi.board(), careerApi.pendingActions(), careerApi.jobs(), careerApi.applications(),
  ]);
  return { board, actions, jobs, applications };
}

const STAGE_TONE: Partial<Record<ApplicationStage, BadgeTone>> = {
  blocked: 'error', needs_user: 'warning', offer: 'success', hired: 'success', interview: 'info', rejected: 'neutral', discarded: 'neutral',
};

export default function CareerApply() {
  const query = useCareerQuery(loadAll, ['job', 'application', 'action_queue', 'application_history', 'handoff']);
  const data = query.data;

  return (
    <CareerPage title="岗位与投递" examples={['帮我导入这个岗位链接', '帮我评估岗位池', '帮我准备投递这个岗位']}>
      <BrowserStatusBar />
      <div className="space-y-5 px-4 py-3">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !data && <LoadingRow />}
        {data && (
          <>
            <BoardSection board={data.board} />
            <ActionsSection actions={data.actions} applications={data.applications} jobs={data.jobs} onChanged={query.reload} />
            <JobsSection jobs={data.jobs} applications={data.applications} onChanged={query.reload} />
          </>
        )}
      </div>
    </CareerPage>
  );
}

function BoardSection({ board }: { board: Board }) {
  const funnelMap = new Map(board.funnel.map(f => [f.stage, f.n]));
  const max = Math.max(1, ...board.funnel.map(f => f.n));
  return (
    <section>
      <SectionTitle>看板三问题</SectionTitle>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card title={`今天必须做（${board.due.length}）`}>
          {board.due.length === 0 && <div className="text-xs text-[var(--ink-subtle)]">今天没有到期事项</div>}
          <ul className="space-y-1.5">
            {board.due.map(a => (
              <li key={a.id} className="text-xs">
                <div className="font-medium text-[var(--ink)]">{a.company_name ?? '未知公司'} · {a.title}</div>
                <div className="text-[var(--ink-muted)]">
                  {a.next_action ?? '下一步未知'}
                  {a.next_action_due ? ` · 到期 ${formatDate(a.next_action_due)}` : a.deadline ? ` · 截止 ${formatDate(a.deadline)}` : ''}
                  {a.stage === 'needs_user' ? ' · 需要你' : ''}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={`哪里卡住（${board.blocked.length}）`}>
          {board.blocked.length === 0 && <div className="text-xs text-[var(--ink-subtle)]">没有卡住的投递</div>}
          <ul className="space-y-1.5">
            {board.blocked.map(a => (
              <li key={a.id} className="text-xs">
                <div className="font-medium text-[var(--ink)]">{a.company_name ?? '未知公司'} · {a.title}</div>
                <div className="text-[var(--error)]">原因：{a.blocker_reason ?? '未知'}</div>
                <div className="text-[var(--ink-muted)]">重试策略：{a.retry_strategy ?? '未知'}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="漏斗" extra={board.pendingReview > 0 ? <Badge tone="accent">待审核 {board.pendingReview}</Badge> : null}>
          <ul className="space-y-1">
            {FUNNEL_ORDER.map(stage => {
              const n = funnelMap.get(stage) ?? 0;
              return (
                <li key={stage} className="flex items-center gap-2 text-xs">
                  <span className="w-12 shrink-0 text-[var(--ink-muted)]">{STAGE_LABELS[stage]}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--paper-inset)]">
                    <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.round((n / max) * 100)}%` }} />
                  </span>
                  <span className="w-6 text-right tabular-nums text-[var(--ink)]">{n}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </section>
  );
}

function ActionsSection({ actions, applications, jobs, onChanged }: { actions: ActionQueueItem[]; applications: Application[]; jobs: Job[]; onChanged: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const review = useCareerAction();
  const appById = useMemo(() => new Map(applications.map(a => [a.id, a])), [applications]);
  const jobById = useMemo(() => new Map(jobs.map(j => [j.id, j])), [jobs]);

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const decide = (decision: 'approved' | 'rejected') => review.run(async () => {
    const ids = [...selected];
    if (ids.length === 0) throw new Error('先勾选要处理的动作');
    await careerApi.reviewActions(ids, decision);
    setSelected(new Set());
    onChanged();
  });

  return (
    <section>
      <SectionTitle extra={(
        <>
          <Button variant="primary" busy={review.busy} disabled={selected.size === 0} onClick={() => void decide('approved')}>批准（{selected.size}）</Button>
          <Button variant="danger" busy={review.busy} disabled={selected.size === 0} onClick={() => void decide('rejected')}>拒绝</Button>
        </>
      )}>
        待审核动作（{actions.length}）
      </SectionTitle>
      {review.error && <ErrorRow message={review.error} />}
      {actions.length === 0 && <div className="text-xs text-[var(--ink-subtle)]">没有待审核的动作。提交 / 发招呼 / 回答开放题永远会先到这里。</div>}
      <ul className="space-y-1.5">
        {actions.map(action => {
          const app = action.application_id ? appById.get(action.application_id) : undefined;
          const job = app ? jobById.get(app.job_id) : undefined;
          const payload = safeJson<Record<string, unknown>>(action.payload_json, {});
          const summary = typeof payload.summary === 'string' ? payload.summary
            : typeof payload.text === 'string' ? payload.text
              : typeof payload.message === 'string' ? payload.message
                : Object.keys(payload).length ? JSON.stringify(payload).slice(0, 160) : '（无摘要）';
          return (
            <li key={action.id} className="flex items-start gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
              <input type="checkbox" aria-label={`选择动作 ${action.id}`} checked={selected.has(action.id)} onChange={() => toggle(action.id)} className="mt-1" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="accent">{ACTION_KIND_LABELS[action.kind] ?? action.kind}</Badge>
                  <span className="text-xs text-[var(--ink-muted)]">
                    {job ? `${job.company_name ?? '未知公司'} · ${job.title}` : app?.title ? `${app.company_name ?? '未知公司'} · ${app.title}` : '未关联岗位'}
                  </span>
                  <span className="text-xs text-[var(--ink-subtle)]">{formatDate(action.created_at)}</span>
                </div>
                <div className="mt-0.5 break-words text-sm text-[var(--ink)]">{summary}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function JobsSection({ jobs, applications, onChanged }: { jobs: Job[]; applications: Application[]; onChanged: () => void }) {
  const [url, setUrl] = useState('');
  const importAction = useCareerAction();
  const appByJob = useMemo(() => {
    const m = new Map<string, Application>();
    for (const a of applications) if (!m.has(a.job_id)) m.set(a.job_id, a);
    return m;
  }, [applications]);

  const doImport = () => importAction.run(async () => {
    const trimmed = url.trim();
    if (!trimmed) throw new Error('请输入岗位链接或 JD 文本');
    await careerApi.importJob(/^https?:\/\//i.test(trimmed) ? { url: trimmed } : { jd_raw: trimmed, title: trimmed.slice(0, 40), source_platform: 'manual' });
    setUrl('');
    onChanged();
  });

  return (
    <section>
      <SectionTitle>岗位池（{jobs.length}）</SectionTitle>
      <div className="mb-3 flex items-center gap-2">
        <Link2 className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
        <TextInput
          aria-label="导入岗位链接"
          placeholder="粘贴岗位链接（或 JD 文本）后回车导入"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void doImport(); }}
        />
        <Button variant="primary" busy={importAction.busy} onClick={() => void doImport()}>导入岗位链接</Button>
      </div>
      {importAction.error && <ErrorRow message={importAction.error} />}
      {jobs.length === 0 && (
        <EmptyState title="岗位池是空的" hint="粘贴岗位链接导入，或让助理按方向去采集。" example="帮我找 10 个合适的岗位" />
      )}
      {jobs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
          <table className="w-full min-w-[900px] border-collapse text-xs">
            <thead className="bg-[var(--paper-inset)] text-left text-[var(--ink-muted)]">
              <tr>
                {['公司', '岗位', '地点', '薪资', '评分', '截止', '阶段', '下一步', '页面'].map(h => (
                  <th key={h} className="px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => <JobRow key={job.id} job={job} application={appByJob.get(job.id)} onChanged={onChanged} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function scoreOf(job: Job): string {
  const score = safeJson<Record<string, unknown>>(job.score_json, {});
  const total = score.total ?? score.overall ?? score.score;
  return typeof total === 'number' ? total.toFixed(1) : typeof total === 'string' ? total : '未知';
}

function JobRow({ job, application, onChanged }: { job: Job; application?: Application; onChanged: () => void }) {
  const stageAction = useCareerAction();
  const targets = application ? STAGE_TRANSITIONS[application.stage] ?? [] : [];
  const changeStage = (to: string) => stageAction.run(async () => {
    if (!application || !to) return;
    await careerApi.setStage(application.id, to);
    onChanged();
  });
  const pageUrl = application?.page_url ?? job.url;
  return (
    <tr className="border-t border-[var(--line-subtle)] align-top">
      <td className="px-2 py-1.5 text-[var(--ink)]">{textOrUnknown(job.company_name)}</td>
      <td className="px-2 py-1.5 font-medium text-[var(--ink)]">{job.title}</td>
      <td className="px-2 py-1.5 text-[var(--ink-muted)]">{textOrUnknown(job.location)}</td>
      <td className="px-2 py-1.5 text-[var(--ink-muted)]">{textOrUnknown(job.salary)}</td>
      <td className="px-2 py-1.5 tabular-nums text-[var(--ink)]">{scoreOf(job)}</td>
      <td className="px-2 py-1.5 text-[var(--ink-muted)]">
        {formatDate(job.deadline)}
        {job.deadline && !job.deadline_verified_at && <span className="ml-1 text-[var(--ink-subtle)]">（未核实）</span>}
      </td>
      <td className="px-2 py-1.5">
        {application ? (
          <div className="flex flex-col gap-1">
            <Badge tone={STAGE_TONE[application.stage] ?? 'neutral'}>{STAGE_LABELS[application.stage] ?? application.stage}</Badge>
            {targets.length > 0 && (
              <Select
                ariaLabel={`切换阶段 ${job.title}`}
                value=""
                placeholder="改为…"
                disabled={stageAction.busy}
                onChange={v => void changeStage(v)}
                options={targets.map(t => ({ value: t, label: STAGE_LABELS[t] ?? t }))}
              />
            )}
            {stageAction.error && <span role="alert" className="text-[var(--error)]">{stageAction.error}</span>}
          </div>
        ) : <span className="text-[var(--ink-subtle)]">未投递</span>}
      </td>
      <td className="px-2 py-1.5 text-[var(--ink-muted)]">
        {application?.next_action ?? '—'}
        {application?.next_action_due && <div className="text-[var(--ink-subtle)]">到期 {formatDate(application.next_action_due)}</div>}
      </td>
      <td className="px-2 py-1.5">
        {pageUrl ? <ExternalLink href={pageUrl} className="text-[var(--accent)] underline underline-offset-2">打开</ExternalLink> : <span className="text-[var(--ink-subtle)]">—</span>}
      </td>
    </tr>
  );
}
