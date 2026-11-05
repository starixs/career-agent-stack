/**
 * 他在预览里改一封待发邮件（POST /api/career/mail-apply/drafts/:actionId）：
 *  - 只改 pending_review 的 send_mail（发出去的、在发的不能改）；任何改动走 repos.updateActionPayload，批准随之作废；
 *  - 标题他改过 → subject_auto=false（到岗信息再变也不替他重排）；
 *  - 存回前把明文换回私密库占位符（Vault.redact：姓名、电话等敏感项），库里和模型能看到的仍是占位符（不变量 5）；
 *  - 换简历 → 重新导 PDF、冻结一份新材料包，换掉简历那一个附件（文件名不变；原来没有简历附件就加上）；
 *  - 附上 / 拿掉附件、作品集那一行与链接（第三轮 R1）见 attachments-edit.ts。
 */
import type { MailDraftPatch, MailDraftView } from '../../../shared/careerMailApply';
import { preparePacketPdf, tailoredChangeCount, type PacketDeps } from '../packets';
import { defaultAttachmentName, readMailProfile } from './compose';
import { addFile, MailAttachmentError, removeAttachment, setPortfolioUrl, togglePortfolio } from './attachments-edit';
import { attachmentsOf, parseSendMailPayload, RESUME_ATTACHMENT_ID, type SendMailPayload } from './payload';
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
  const current = attachmentsOf(payload);
  const packetNow = payload.packet_id ? deps.repos.getPacket(payload.packet_id) : undefined;
  if (packetNow?.resume_id === resumeId && current.some(a => a.kind === 'resume')) return payload;
  const found = deps.store.getResume(resumeId);
  if (!found) throw new MailDraftError('这份简历不在了');
  const applicationId = payload.application_id ?? null;
  const jobId = payload.job_id ?? null;
  if (!applicationId || !jobId) throw new MailDraftError('这封邮件没挂在投递上，换不了简历');
  const pdf = await preparePacketPdf(deps, resumeId);
  if ('failed' in pdf) throw new MailDraftError(pdf.failed);
  const changes = found.kind === 'tailored' ? tailoredChangeCount(deps.repos, resumeId) : null;
  const packet = pdf.commit({ applicationId, jobId, answers: { resume_plan: { kind: found.kind, changes, reason: 'explicit' } } });
  const old = current.find(a => a.kind === 'resume');
  // 原来有简历附件沿用它的文件名；原来没有（回信默认不带附件，他要附上简历）用代码的默认附件名
  const filename = old?.filename ?? defaultAttachmentName(readMailProfile(deps.vault).profile);
  console.log(`[career] mail-apply resume swapped app=${applicationId} packet=${packet.id} kind=${found.kind}`);
  const resume = packet.resume_pdf_path
    ? [{ id: RESUME_ATTACHMENT_ID, kind: 'resume' as const, path: packet.resume_pdf_path, filename, ...(packet.resume_pdf_sha256 ? { sha256: packet.resume_pdf_sha256 } : {}) }] : [];
  return { ...payload, packet_id: packet.id, attachments: [...resume, ...current.filter(a => a.kind !== 'resume')] };
}

/** 附件与作品集类改动（不合格的说清楚原因）。 */
function applyAttachmentEdits(deps: MailEditDeps, payload: SendMailPayload, patch: MailDraftPatch): SendMailPayload {
  try {
    let next = payload;
    if (patch.remove_attachment_id !== undefined) next = removeAttachment(next, patch.remove_attachment_id);
    if (patch.add_file_id !== undefined) next = addFile(deps, next, patch.add_file_id);
    if (patch.portfolio_url !== undefined) next = setPortfolioUrl(deps, next, patch.portfolio_url);
    else if (patch.include_portfolio !== undefined) next = togglePortfolio(deps, next, patch.include_portfolio);
    return next;
  } catch (error) {
    if (error instanceof MailAttachmentError) throw new MailDraftError(error.message);
    throw error;
  }
}

/** 改一封待发邮件，返回改后的预览（重新算 blockers）。 */
export async function patchMailDraft(deps: MailEditDeps, actionId: string, patch: MailDraftPatch): Promise<MailDraftView> {
  const action = deps.repos.getAction(actionId);
  if (!isPendingDraft(action)) throw new MailDraftError('这封邮件已经不在待发里了');
  const payload = parseSendMailPayload(action.id, action.payload_json);
  let next = applyTextEdits(deps, action.id, payload, patch);
  if (patch.resume_id !== undefined) next = await swapResume(deps, next, patch.resume_id);
  next = applyAttachmentEdits(deps, next, patch);
  if (JSON.stringify(next) !== JSON.stringify(payload)) {
    deps.repos.updateActionPayload(action.id, next);
    console.log(`[career] mail-apply draft edited action=${action.id} fields=${Object.keys(patch).join(',')}`);
  }
  return mailDraftView(deps, deps.repos.getAction(action.id)!);
}
