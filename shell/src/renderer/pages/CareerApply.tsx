/**
 * 岗位与投递：看板三问题（今天必须做 / 哪里卡住 / 漏斗）、待投清单（审阅后批准提交）、岗位汇总表、浏览器状态条。
 */
import { useMemo, useState } from 'react';

import { BrowserStatusBar } from '@/components/career/BrowserStatusBar';
import { careerApi, safeJson } from '@/components/career/careerApi';
import { ACTION_KIND_LABELS, FUNNEL_ORDER, STAGE_LABELS } from '@/components/career/careerConstants';
import { JobBoard } from '@/components/career/JobBoard';
import {
  Badge, Button, CareerPage, Card, ErrorRow, LoadingRow, SectionTitle, formatDate,
} from '@/components/career/CareerPrimitives';
import { SubmitReviewList, approvalLabel } from '@/components/career/SubmitReviewList';
import type { ActionQueueItem, Application, ApplySettings, Board, Job, SubmitReviewSummary } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';

interface ApplyData { board: Board; actions: ActionQueueItem[]; confirming: ActionQueueItem[]; jobs: Job[]; applications: Application[]; settings: ApplySettings }

async function loadAll(): Promise<ApplyData> {
  const [board, actions, confirming, jobs, applications, settings] = await Promise.all([
    careerApi.board(), careerApi.pendingActions(), careerApi.submitsNeedingUser().catch(() => []), careerApi.jobs(), careerApi.applications(),
    careerApi.applySettings().catch((): ApplySettings => ({ auto_mode: false, learn_threshold: 3 })),
  ]);
  return { board, actions, confirming, jobs, applications, settings };
}

export default function CareerApply({ embedded = false }: { embedded?: boolean } = {}) {
  const query = useCareerQuery(loadAll, ['job', 'application', 'action_queue', 'application_history', 'handoff']);
  const data = query.data;

  return (
    <CareerPage embedded={embedded} title="岗位与投递" examples={['帮我导入这个岗位链接', '帮我评估岗位池', '帮我准备投递这个岗位']}>
      <BrowserStatusBar />
      <div className="space-y-5 px-4 py-3">
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !data && <LoadingRow />}
        {data && (
          <>
            <BoardSection board={data.board} />
            <ActionsSection actions={data.actions} confirming={data.confirming} settings={data.settings} applications={data.applications} jobs={data.jobs} onChanged={query.reload} />
            <JobBoard onChanged={query.reload} />
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
          {board.due.length === 0 && <div className="text-xs text-[var(--subtle)]">今天没有到期事项</div>}
          <ul className="space-y-1.5">
            {board.due.map(a => (
              <li key={a.id} className="text-xs">
                <div className="font-medium text-[var(--ink)]">{a.company_name ?? '未知公司'} · {a.title}</div>
                <div className="text-[var(--muted)]">
                  {a.next_action ?? '下一步未知'}
                  {a.next_action_due ? ` · 到期 ${formatDate(a.next_action_due)}` : a.deadline ? ` · 截止 ${formatDate(a.deadline)}` : ''}
                  {a.stage === 'needs_user' ? ' · 需要你' : ''}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={`哪里卡住（${board.blocked.length}）`}>
          {board.blocked.length === 0 && <div className="text-xs text-[var(--subtle)]">没有卡住的投递</div>}
          <ul className="space-y-1.5">
            {board.blocked.map(a => (
              <li key={a.id} className="text-xs">
                <div className="font-medium text-[var(--ink)]">{a.company_name ?? '未知公司'} · {a.title}</div>
                <div className="text-[var(--danger)]">原因：{a.blocker_reason ?? '未知'}</div>
                <div className="text-[var(--muted)]">重试策略：{a.retry_strategy ?? '未知'}</div>
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
                  <span className="w-12 shrink-0 text-[var(--muted)]">{STAGE_LABELS[stage]}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--inset)]">
                    <span className="block h-full rounded-full bg-[var(--primary)]" style={{ width: `${Math.round((n / max) * 100)}%` }} />
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

function ActionsSection({ actions, confirming, settings, applications, jobs, onChanged }: { actions: ActionQueueItem[]; confirming: ActionQueueItem[]; settings: ApplySettings; applications: Application[]; jobs: Job[]; onChanged: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const review = useCareerAction();
  const modeAction = useCareerAction();
  const appById = useMemo(() => new Map(applications.map(a => [a.id, a])), [applications]);
  const jobById = useMemo(() => new Map(jobs.map(j => [j.id, j])), [jobs]);
  // 只保留仍在列表里的勾选（列表刷新后旧 id 自动失效）
  const live = useMemo(() => new Set([...selected].filter(id => actions.some(a => a.id === id))), [selected, actions]);
  const allChecked = actions.length > 0 && live.size === actions.length;

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(actions.map(a => a.id)));
  const decide = (decision: 'approved' | 'rejected') => review.run(async () => {
    const ids = [...live];
    if (ids.length === 0) throw new Error('先勾选要处理的动作');
    await careerApi.reviewActions(ids, decision);
    setSelected(new Set());
    onChanged();
  });
  const setAuto = (enabled: boolean) => modeAction.run(async () => { await careerApi.setAutoMode(enabled); onChanged(); });
  const labelOf = (action: ActionQueueItem) => {
    const app = action.application_id ? appById.get(action.application_id) : undefined;
    const job = app ? jobById.get(app.job_id) : undefined;
    return job ? `${job.company_name ?? '未知公司'} · ${job.title}` : app?.title ? `${app.company_name ?? '未知公司'} · ${app.title}` : '未关联岗位';
  };

  return (
    <section>
      <SectionTitle extra={(
        <>
          <label className="mr-2 flex items-center gap-1.5 text-xs text-[var(--muted)]" title={`开启后：填完检查全部通过的网申直接提交，有需要你看的项仍会停下。另外，同一张表你连续 ${settings.learn_threshold} 次没改直接批准、简历和开放题答案没变时，会自动免确认。`}>
            <input type="checkbox" aria-label="auto 模式" checked={settings.auto_mode} disabled={modeAction.busy} onChange={e => void setAuto(e.target.checked)} />
            auto 模式（检查通过直接提交）
          </label>
          <Button variant="primary" busy={review.busy} disabled={live.size === 0} onClick={() => void decide('approved')}>批准（{live.size}）</Button>
          <Button variant="danger" busy={review.busy} disabled={live.size === 0} onClick={() => void decide('rejected')}>拒绝</Button>
        </>
      )}>
        待投清单 / 待审核动作（{actions.length}）
      </SectionTitle>
      {review.error && <ErrorRow message={review.error} />}
      {modeAction.error && <ErrorRow message={modeAction.error} />}
      {confirming.length > 0 && <ConfirmSubmits actions={confirming} labelOf={labelOf} onChanged={onChanged} />}
      {actions.length === 0 && <div className="text-xs text-[var(--subtle)]">没有待审核的动作。网申填好后会停在提交前到这里，你看过审阅清单批准后，产品替你点提交。</div>}
      {actions.length > 0 && (
        <label className="mb-1.5 flex items-center gap-2 px-3 text-xs text-[var(--muted)]">
          <input type="checkbox" aria-label="全选" checked={allChecked} ref={el => { if (el) el.indeterminate = live.size > 0 && !allChecked; }} onChange={toggleAll} />
          全选（{live.size} / {actions.length}）
        </label>
      )}
      <ul className="space-y-1.5">
        {actions.map(action => {
          const payload = safeJson<Record<string, unknown>>(action.payload_json, {});
          const isSubmit = action.kind === 'submit';
          const summary = isSubmit ? `停在「${typeof payload.submitButton === 'string' ? payload.submitButton : '提交'}」前，批准后产品替你点提交`
            : typeof payload.summary === 'string' ? payload.summary
              : typeof payload.subject === 'string' ? `${payload.subject}${typeof payload.to === 'string' ? ` → ${payload.to}` : ''}`
                : typeof payload.text === 'string' ? payload.text
                  : typeof payload.message === 'string' ? payload.message
                    : Object.keys(payload).length ? JSON.stringify(payload).slice(0, 160) : '（无摘要）';
          return (
            <li key={action.id} className="flex items-start gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
              <input type="checkbox" aria-label={`选择动作 ${action.id}`} checked={live.has(action.id)} onChange={() => toggle(action.id)} className="mt-1" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="accent">{ACTION_KIND_LABELS[action.kind] ?? action.kind}</Badge>
                  <span className="text-xs text-[var(--muted)]">{labelOf(action)}</span>
                  <span className="text-xs text-[var(--subtle)]">{formatDate(action.created_at)}</span>
                </div>
                <div className="mt-0.5 break-words text-sm text-[var(--ink)]">{summary}</div>
                {isSubmit && <SubmitReviewList review={payload.review as SubmitReviewSummary | null} />}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 点了提交但没等到成功提示 / 提交时遇到验证码：等用户到页面上确认结果。 */
function ConfirmSubmits({ actions, labelOf, onChanged }: { actions: ActionQueueItem[]; labelOf: (a: ActionQueueItem) => string; onChanged: () => void }) {
  const act = useCareerAction();
  const confirm = (id: string, submitted: boolean) => act.run(async () => { await careerApi.confirmSubmit(id, submitted); onChanged(); });
  return (
    <div className="mb-3 space-y-1.5">
      {actions.map(a => {
        const result = safeJson<Record<string, unknown>>(a.result_json, {});
        return (
          <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--warning)] bg-[var(--paper)] px-3 py-2 text-xs">
            <Badge tone="warning">等你确认</Badge>
            <span className="font-medium text-[var(--ink)]">{labelOf(a)}</span>
            <span className="text-[var(--muted)]">{typeof result.message === 'string' ? result.message : '提交结果不确定，请到页面上看一下'}</span>
            {approvalLabel(a.approved_by) && <span className="text-[var(--subtle)]">（{approvalLabel(a.approved_by)}）</span>}
            <span className="flex-1" />
            <Button size="sm" variant="primary" busy={act.busy} onClick={() => void confirm(a.id, true)}>已投递成功</Button>
            <Button size="sm" busy={act.busy} onClick={() => void confirm(a.id, false)}>没投出去，重新审核</Button>
          </div>
        );
      })}
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}
