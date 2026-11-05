/**
 * 实习到岗信息（POST /api/career/mail-apply/availability）：存进基本资料（问一次），
 * 再把所有待发的实习投递邮件的到岗那句和（代码拼的）标题重排——不调模型。
 * 他亲手改过的不动：到岗那句被他改掉了（正文里找不到原句）就不换；标题他改过（subject_auto=false）就不重排。
 */
import type { InternAvailability, MailDraftView } from '../../../shared/careerMailApply';
import { arrivalLine, AVAILABILITY_FIELDS, defaultSubject, isInternJob, readMailProfile } from './compose';
import { parseSendMailPayload, type SendMailPayload } from './payload';
import { allPendingDraftViews, isPendingDraft, type MailViewDeps } from './view';

/** 写进私密库（非敏感字段）；空值不写（不把已有的清掉）。 */
function saveFields(deps: MailViewDeps, a: InternAvailability): void {
  if (!deps.vault) throw new Error('私密库没打开，到岗信息存不了');
  const pairs: Array<[keyof InternAvailability, string]> = [['days_per_week', AVAILABILITY_FIELDS.days_per_week], ['months', AVAILABILITY_FIELDS.months], ['start', AVAILABILITY_FIELDS.start]];
  for (const [key, field] of pairs) {
    const value = a[key]?.trim();
    if (value) deps.vault.set({ scope: 'profile', field, value, sensitive: false });
  }
}

/** 一封按新的到岗信息重排后的 payload；不用改返回 null。 */
function rearranged(deps: MailViewDeps, payload: SendMailPayload): SendMailPayload | null {
  const job = payload.job_id ? deps.repos.getJob(payload.job_id) : undefined;
  if (payload.purpose !== 'apply' || !job || !isInternJob(job)) return null;
  const { profile, availability } = readMailProfile(deps.vault);
  const arrival = arrivalLine(true, availability);
  const next: SendMailPayload = { ...payload };
  if (payload.arrival_line && payload.arrival_line !== arrival && payload.body.includes(payload.arrival_line)) {
    next.body = payload.body.replace(payload.arrival_line, arrival);
    next.arrival_line = arrival;
  }
  if (payload.subject_auto) next.subject = defaultSubject(job.title, true, profile, availability);
  return next.body === payload.body && next.subject === payload.subject ? null : next;
}

/** 存到岗信息并重排所有待发的实习投递邮件；返回所有待发邮件的新预览。 */
export function saveAvailability(deps: MailViewDeps, a: InternAvailability): MailDraftView[] {
  saveFields(deps, a);
  let n = 0;
  for (const action of deps.repos.listActions('pending_review').filter(isPendingDraft)) {
    const next = rearranged(deps, parseSendMailPayload(action.id, action.payload_json));
    if (!next) continue;
    deps.repos.updateActionPayload(action.id, next);
    n++;
  }
  console.log(`[career] mail-apply availability saved rearranged=${n}`);
  return allPendingDraftViews(deps);
}
