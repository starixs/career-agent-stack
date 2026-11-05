/**
 * 后台写投递邮件（draft_mail → send_mail，对应网申的 fill_form → submit）：
 *  1. 认领；备材料包（复用 preparePacketForAction：有真 JD 就定制，没成退回主简历并记原因）；
 *  2. derivatives 技能写标题（JD 指定格式时）和正文前两段；到岗那句、署名、默认标题、附件名由代码拼（compose.ts）；
 *  3. 排一封 send_mail（pending_review，等他过目），draft_mail 置 done（result 记 send_action_id）。
 * 永远不发信。模型超时 / 出错重试一次，仍不成 → draft_mail failed + 一句给人看的原因（等你里「N 封没写成」）。
 * 没连邮箱不是失败：照样写，发件邮箱留空，预览里 blockers 带 no_mailbox。
 * 日志只记动作与投递 id：`[career] mail-apply drafted action=… app=…`，不记标题、正文、收件人。
 */
import { extractMailFormat, type ActionQueueItem, type Job } from '@career/core';
import { z } from 'zod';

import { preparePacketForAction } from '../packet-prepare';
import { addLine, arrivalLine, assembleBody, chooseAttachmentName, defaultSubject, isInternJob, NAME_TOKEN, readMailProfile, signature, type MailProfile } from './compose';
import { sizeOnDisk } from './attachments-edit';
import { maybeSendNow } from './auto-send';
import { mailDefaults } from './defaults';
import { listMailFiles } from './files';
import { DraftMailPayloadSchema, fileAttachmentId, FollowDraftPayloadSchema, payloadObject, RESUME_ATTACHMENT_ID, type DraftMailPayload, type SendMailPayload } from './payload';
import { askWithRetry, existingSendOf, failDraft, finishDraft, type DraftOutcome, type DrafterDeps } from './draft-common';
import { draftFollowMail } from './follow-drafter';

export { MAIL_DRAFT_TIMEOUT_MS, type AskSkill, type DraftOutcome, type DrafterDeps } from './draft-common';


/** 喂给模型的 JD 原文最多多少字：一份 JD 远小于此，超长的多半混了别的页面内容。 */
const JD_PROMPT_MAX_CHARS = 6000;

const DerivativesOut = z.object({
  email: z.object({ subject: z.string().catch(''), body: z.string().catch('') }).catch({ subject: '', body: '' }),
  attachment_name: z.string().catch(''),
  /** 用过的主张（跟进时换一条没用过的）；坏了当没有。 */
  matches_used: z.array(z.object({ claim_id: z.string().catch('') }).passthrough()).catch([]),
}).passthrough();
type Written = { subject: string; body: string; attachment_name: string; claims_used: string[] };


/** jd_parsed_json 里与邮件有关的两项（jd-parse 技能输出；坏了当没有）。 */
const JdMailFormat = z.object({ mail_subject_format: z.string().optional().catch(undefined), mail_attachment_format: z.string().optional().catch(undefined) }).passthrough();
type MailFormat = { subject_format?: string; attachment_format?: string };

/** JD 指定的邮件格式：解析结果里有就用，没有就从原文里按规则抽。 */
function mailFormatOf(job: Job): MailFormat {
  let parsed: z.infer<typeof JdMailFormat> = {};
  try { if (job.jd_parsed_json) parsed = JdMailFormat.parse(JSON.parse(job.jd_parsed_json)); } catch (error) {
    console.warn(`[career] mail-apply job=${job.id} jd_parsed_json unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fromRaw = extractMailFormat(job.jd_raw ?? '');
  return { subject_format: parsed.mail_subject_format || fromRaw.subject_format, attachment_format: parsed.mail_attachment_format || fromRaw.attachment_format };
}

function promptOf(deps: DrafterDeps, job: Job, profile: MailProfile, format: MailFormat, notes: string | undefined): string {
  const claims = deps.repos.listClaims().filter(c => c.status !== 'pending').map(c => `- [${c.id}] ${c.text}${c.result_metric ? `（${c.result_metric}）` : ''}`).join('\n') || '（无）';
  const jd = job.jd_parsed_json ? `JdParsed：${job.jd_parsed_json}` : `JD 原文：${(job.jd_raw ?? '（无）').slice(0, JD_PROMPT_MAX_CHARS)}`;
  return [
    '模式：邮件投递（后台写）。只写 email.subject 与 email.body 的前两段；到岗那句、附件说明、署名由系统补，不要写。',
    `公司：${job.company_name ?? '未知'}\n岗位：${job.title}\n${jd}`,
    `JD 指定的邮件标题格式：${format.subject_format ?? '无'}\nJD 指定的附件命名格式：${format.attachment_format ?? '无'}`,
    `用户基本信息：${JSON.stringify({ name: NAME_TOKEN, school: profile.school ?? null, major: profile.major ?? null, graduation: profile.graduation ?? null })}`,
    `已确认主张：\n${claims}`,
    `用户要求：${notes?.trim() || '无'}`,
  ].join('\n\n');
}


function parseWritten(raw: unknown): Written | null {
  const out = DerivativesOut.parse(raw);
  const claims = [...new Set(out.matches_used.map(m => m.claim_id.trim()).filter(Boolean))];
  return out.email.body.trim() ? { subject: out.email.subject.trim(), body: out.email.body, attachment_name: out.attachment_name, claims_used: claims } : null;
}



/** 拼出待发的那封（payload 里存占位符版本，预览与发送时解开）。 */
function sendPayloadOf(deps: DrafterDeps, action: ActionQueueItem, p: DraftMailPayload, job: Job, packetId: string, written: Written, format: MailFormat): SendMailPayload {
  const { profile, availability } = readMailProfile(deps.vault);
  const intern = isInternJob(job);
  const arrival = arrivalLine(intern, availability);
  const subjectAuto = !format.subject_format || !written.subject;
  const packet = deps.repos.getPacket(packetId);
  const filename = chooseAttachmentName(written.attachment_name, format.attachment_format, profile, job.title);
  const resume = packet?.resume_pdf_path ? [{ id: RESUME_ATTACHMENT_ID, kind: 'resume' as const, path: packet.resume_pdf_path, filename, ...(packet.resume_pdf_sha256 ? { sha256: packet.resume_pdf_sha256 } : {}) }] : [];
  // 岗位描述要作品集 / 成绩单：资料里有链接就带那一行，存过的对应文件默认附上（compose / defaults 纯规则）
  const extra = mailDefaults({ jd: job.jd_raw, portfolioUrl: profile.portfolio, files: listMailFiles(deps.repos), usedBytes: resume.reduce((n, a) => n + sizeOnDisk(a.path), 0) });
  const files = extra.files.map(f => ({ id: fileAttachmentId(f.id), kind: 'file' as const, file_id: f.id, path: f.path, filename: f.filename, sha256: f.sha256 }));
  const body = assembleBody(written.body, arrival, signature(profile));
  return {
    account_id: deps.repos.listMailAccounts()[0]?.id ?? '',
    to: p.to, subject: subjectAuto ? defaultSubject(job.title, intern, profile, availability) : written.subject,
    body: extra.portfolioLine ? addLine(body, extra.portfolioLine, arrival) : body,
    attachments: [...resume, ...files],
    application_id: p.application_id, job_id: p.job_id, context: '邮件',
    purpose: 'apply', packet_id: packetId, subject_auto: subjectAuto, arrival_line: arrival, draft_action_id: action.id,
    ...(extra.portfolioLine ? { portfolio_line: extra.portfolioLine } : {}), claims_used: written.claims_used, ...(p.notes?.trim() ? { has_notes: true } : {}),
  };
}

/** 后台写一封投递邮件（见文件头）。返回 drafted / failed / skipped（没认领到：别处在写或已不在队列里）。 */
export async function draftMailForAction(deps: DrafterDeps, action: ActionQueueItem): Promise<DraftOutcome> {
  const claim = deps.repos.claimAction(action.id);
  if (!claim.ok) { console.log(`[career] mail-apply draft skipped action=${action.id} reason=${claim.reason}`); return 'skipped'; }
  const already = existingSendOf(deps.repos, action.id);
  if (already) {
    deps.repos.setActionStatus(action.id, 'done', { send_action_id: already.id });
    console.log(`[career] mail-apply draft resumed action=${action.id} send=${already.id}`);
    return 'drafted';
  }
  const raw = payloadObject(action.id, action.payload_json);
  const follow = FollowDraftPayloadSchema.safeParse(raw);
  if (follow.success) return draftFollowMail(deps, action, follow.data);
  const parsed = DraftMailPayloadSchema.safeParse(raw);
  if (!parsed.success) return failDraft(deps, action, '这封邮件的材料不全', parsed.error.message);
  const job = deps.repos.getJob(parsed.data.job_id);
  if (!job) return failDraft(deps, action, '这个岗位已经不在了');
  const packet = await preparePacketForAction(deps, action, parsed.data, () => undefined);
  if (!packet || 'failed' in packet) return failDraft(deps, action, packet ? packet.failed : '这份简历没备好');
  const format = mailFormatOf(job);
  let written: Written;
  try {
    written = await askWithRetry(deps, 'derivatives', promptOf(deps, job, readMailProfile(deps.vault).profile, format, parsed.data.notes), parseWritten);
  } catch (error) {
    return failDraft(deps, action, '邮件没写成，再试一次', error instanceof Error ? error.message : String(error));
  }
  const send = finishDraft(deps.repos, action, sendPayloadOf(deps, action, parsed.data, job, packet.packetId, written, format), parsed.data.application_id);
  // 放权了且不差东西：直接发出（send-policy.ts）；否则留在待审给他看
  await maybeSendNow(deps, send);
  console.log(`[career] mail-apply drafted action=${action.id} app=${parsed.data.application_id} send=${send.id} subject_auto=${!format.subject_format}`);
  return 'drafted';
}
