/**
 * 框选一批、确认投出（世界模型 §6 立场 9；用户 2026-10-30「你这个框选一堆，然后你就直接确认」）。
 *
 * 在岗位表上勾好一批 →「投这 N 家」→ 这一条把要说的一次说完：几家开始、标星的几家填好先给你看、
 * 哪几家跳过（为什么）、好几份主简历时用哪份（预选最近改过的）→「开始投」。
 * 开始后不用再去通知中心或对话里点「开始」：后台批量运行器接着填，要你的事出现在下面的等你条里。
 */
import { useEffect, useState } from 'react';

import { careerApi } from './careerApi';
import { requestNavigation } from '@/features/career-shell/navModel';

import { Button, ErrorRow, LoadingRow, Select, suggestToChat } from './CareerPrimitives';
import type { JobPlan } from './types';
import { useCareerAction } from './useCareerData';

/** 和服务端 batch-apply.ts skipReason 的文案一致。 */
const NO_RESUME_REASON = '还没有简历';
const BUSY_REASON = '已在投';
const NO_RESUME_ASK = '我想投这几家，但还没有简历，先帮我做一份';

/** 「已经投过 2 · 没有网申链接 1」：同一原因合在一起数。 */
export function skippedText(skipped: JobPlan['skipped']): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${reason} ${n}`).join(' · ');
}

/** 开始后的一行：投了几家、跳过的原因、下一步在哪。 */
export function startedText(started: number, skipped: JobPlan['skipped']): string {
  const head = started > 0 ? `已开始投 ${started} 家。` : '这一批没有能开始的。';
  return skipped.length ? `${head}跳过：${skippedText(skipped)}。` : head;
}

/** 能投的家数按钮上已经写了：这一行只在一家都投不了时说。 */
function planLine(plan: JobPlan): string | null {
  return plan.ready.length ? null : '这一批都不能投';
}

export function ApplyConfirm({ jobIds, onStarted, onCancel }: { jobIds: string[]; onStarted: (msg: string) => void; onCancel: () => void }) {
  const [plan, setPlan] = useState<JobPlan | null>(null);
  const [resumeId, setResumeId] = useState('');
  const load = useCareerAction();
  const start = useCareerAction();
  const { run: runLoad } = load;
  const key = jobIds.join(',');
  // 只在这批岗位变了时重算
  useEffect(() => {
    void runLoad(async () => {
      const p = await careerApi.planJobs(key.split(','));
      setPlan(p);
      setResumeId(p.resumes[0]?.id ?? '');
    });
  }, [key, runLoad]);
  const go = () => start.run(async () => {
    const res = await careerApi.applyJobs(plan?.ready ?? [], resumeId || undefined);
    onStarted(startedText(res.started.length, [...(plan?.skipped ?? []), ...res.skipped]));
  });
  // 没有简历时这一批全被跳过：不留死路，一键回对话先把简历做出来（主线体验 §2 信任杀手）
  const noResume = !!plan && plan.skipped.some(x => x.reason === NO_RESUME_REASON);
  const busy = !!plan && plan.skipped.some(x => x.reason === BUSY_REASON);
  const askResume = !!plan && plan.needs_resume.length > 0 && plan.resumes.length > 1;
  return (
    <div data-testid="apply-confirm" className="mx-6 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 border-[var(--primary)] py-1 pl-3 text-sm">
      {!plan && load.busy && <LoadingRow />}
      {plan && planLine(plan) && <span className="text-[var(--ink)]">{planLine(plan)}</span>}
      {plan && plan.skipped.length > 0 && <span className="text-xs text-[var(--muted)]">跳过 {skippedText(plan.skipped)}</span>}
      {busy && (
        <Button size="sm" variant="ghost" onClick={() => requestNavigation({ kind: 'career-live' })}>看进展</Button>
      )}
      {noResume && (
        <Button size="sm" variant="secondary" onClick={() => suggestToChat(NO_RESUME_ASK)}>先做一份简历</Button>
      )}
      {askResume && (
        <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          {plan.needs_resume.length} 家没有定制版，用
          <span className="w-44"><Select ariaLabel="这批用哪份简历" value={resumeId} onChange={setResumeId} options={plan.resumes.map(r => ({ value: r.id, label: r.name }))} /></span>
        </span>
      )}
      <span className="flex items-center gap-1">
        <Button size="sm" variant="primary" busy={start.busy} disabled={!plan?.ready.length} onClick={() => void go()}>开始投 {plan?.ready.length ?? ''} 家</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      </span>
      {(load.error || start.error) && <ErrorRow message={(load.error ?? start.error)!} />}
    </div>
  );
}
