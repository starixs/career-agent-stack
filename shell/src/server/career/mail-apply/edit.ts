/**
 * 他在预览里改一封待发邮件（POST /api/career/mail-apply/drafts/:actionId）：
 *  - 只改 pending_review 的 send_mail（发出去的、在发的不能改）；任何改动走 repos.updateActionPayload，批准随之作废；
 *  - 标题他改过 → subject_auto=false（到岗信息再变也不替他重排）；
 *  - 存回前把明文换回私密库占位符（Vault.redact：姓名、电话等敏感项），库里和模型能看到的仍是占位符（不变量 5）；
 *  - 换简历 → 重新导 PDF、冻结一份新材料包，附件换成它（文件名不变）。
 */
import type { MailDraftPatch, MailDraftView } from '../../../shared/careerMailApply';
import { preparePacketPdf, tailoredChangeCount, type PacketDeps } from '../packets';
import { defaultAttachmentName, readMailProfile } from './compose';
import { parseSendMailPayload, type SendMailPayload } from './payload';
import { resolveMail } from './resolve';
import { isPendingDraft, mailDraftView, type MailViewDeps } from './view';

export type MailEditDeps = MailViewDeps & PacketDeps;

/** 这封已经不能改（不在了 / 发出去了 / 不是邮件）、或改的东西不对：路由回 409 带这句。 */
export class MailDraftError extends Error {}

const redact = (deps: MailEditDeps, text: string): string => (deps.vault ? deps.vault.redact(text) : text);

/** 文字类改动：和他看到的（解开后的）一样就不算改。 */
function applyTextEdits(deps: MailEditDeps, actionId: string, payload: SendMailPayload, patch: MailDraftPatch): SendMailPayload {
  const seen = resolveMail(deps, { id: actionId, payload_json: JSON.stringify(payload) });
  const next: SendMailPayload = { ...payload };
  if (patch.to !== undefined && patch.to.trim() !== seen.to) next.to = patch.to.trim();
  if (patch.subject !== undefined && patch.subject !== seen.subject) { next.subject = redact(deps, patch.subject); next.subject_auto = false; }
  if (patch.body !== undefined && patch.body !== seen.body) next.body = redact(deps, patch.body);
  if (patch.account_id !== undefined && patch.account_id !== payload.account_id) {
    if (!deps.repos.getMailAccount(patch.account_id)) throw new MailDraftError('这个邮箱已经不在了，换一个');
    next.account_id = patch.account_id;
  }
  return next;
}

/** 换一份简历当附件：重新导 PDF、冻结新材料包。 */
async function swapResume(deps: MailEditDeps, payload: SendMailPayload, resumeId: string): Promise<SendMailPayload> {
  const current = payload.packet_id ? deps.repos.getPacket(payload.packet_id) : undefined;
  if (current?.resume_id === resumeId) return payload;
  const found = deps.store.getResume(resumeId);
  if (!found) throw new MailDraftError('这份简历不在了');
  const applicationId = payload.application_id ?? null;
  const jobId = payload.job_id ?? null;
  if (!applicationId || !jobId) throw new MailDraftError('这封邮件没挂在投递上，换不了简历');
  const pdf = await preparePacketPdf(deps, resumeId);
  if ('failed' in pdf) throw new MailDraftError(pdf.failed);
  const changes = found.kind === 'tailored' ? tailoredChangeCount(deps.repos, resumeId) : null;
  const packet = pdf.commit({ applicationId, jobId, answers: { resume_plan: { kind: found.kind, changes, reason: 'explicit' } } });
  // 原来有附件沿用它的文件名；原来没有（回信默认不带附件，他要附上简历）用代码的默认附件名
  const filename = payload.attachments?.[0]?.filename ?? defaultAttachmentName(readMailProfile(deps.vault).profile);
  console.log(`[career] mail-apply resume swapped app=${applicationId} packet=${packet.id} kind=${found.kind}`);
  return {
    ...payload, packet_id: packet.id,
    attachments: packet.resume_pdf_path ? [{ path: packet.resume_pdf_path, filename, ...(packet.resume_pdf_sha256 ? { sha256: packet.resume_pdf_sha256 } : {}) }] : [],
  };
}

/** 改一封待发邮件，返回改后的预览（重新算 blockers）。 */
export async function patchMailDraft(deps: MailEditDeps, actionId: string, patch: MailDraftPatch): Promise<MailDraftView> {
  const action = deps.repos.getAction(actionId);
  if (!isPendingDraft(action)) throw new MailDraftError('这封邮件已经不在待发里了');
  const payload = parseSendMailPayload(action.id, action.payload_json);
  let next = applyTextEdits(deps, action.id, payload, patch);
  if (patch.resume_id !== undefined) next = await swapResume(deps, next, patch.resume_id);
  if (JSON.stringify(next) !== JSON.stringify(payload)) {
    deps.repos.updateActionPayload(action.id, next);
    console.log(`[career] mail-apply draft edited action=${action.id} fields=${Object.keys(patch).join(',')}`);
  }
  return mailDraftView(deps, deps.repos.getAction(action.id)!);
}
