import type { Application, ApplicationStage, BatchState } from '@/components/career/types';

export interface ApplicationStats {
  total: number;
  active: number;
  waiting: number;
  submitted: number;
  closed: number;
}

/** 投出去过的阶段，与服务端 batch-apply 的 SENT 同口径；pending（还在填）算进行中。 */
const SUBMITTED = new Set<ApplicationStage>(['applied', 'responded', 'interview', 'offer', 'rejected', 'hired']);
const CLOSED = new Set<ApplicationStage>(['discarded', 'skip']);
const WAITING = new Set<ApplicationStage>(['needs_user', 'blocked']);

/** 网申控制页只认申请真实阶段；待处理数与 openHandoffs 取大值，避免同一申请重复计数。 */
export function applicationStats(applications: readonly Pick<Application, 'stage'>[], openHandoffs = 0): ApplicationStats {
  const waitingApps = applications.filter(app => WAITING.has(app.stage)).length;
  return {
    total: applications.length,
    active: applications.filter(app => !SUBMITTED.has(app.stage) && !CLOSED.has(app.stage) && !WAITING.has(app.stage)).length,
    waiting: Math.max(waitingApps, openHandoffs),
    submitted: applications.filter(app => SUBMITTED.has(app.stage)).length,
    closed: applications.filter(app => CLOSED.has(app.stage)).length,
  };
}

/** 批量里还有没有要投的：在跑、暂停着，或者还排着 / 正在填的。都没有就给空状态，不给一点就说「全部处理完」的开始按钮。 */
export function hasBatchWork(batch: BatchState | null): boolean {
  if (!batch) return false;
  if (batch.status === 'running' || batch.status === 'paused') return true;
  return batch.queued > 0 || (batch.running?.length ?? 0) > 0;
}

/** 上一批出过错时给他看的一句话；原始错误只进日志。 */
export const BATCH_ERROR_TEXT = '上一批有一家没填成，我会再试';
