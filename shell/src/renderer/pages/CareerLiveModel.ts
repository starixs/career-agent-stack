import type { Application, ApplicationStage } from '@/components/career/types';

export interface ApplicationStats {
  total: number;
  active: number;
  waiting: number;
  submitted: number;
  closed: number;
}

const SUBMITTED = new Set<ApplicationStage>(['applied', 'responded', 'interview', 'pending', 'offer', 'hired', 'rejected']);
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
