/**
 * 后台写投递邮件（draft_mail → send_mail，对应网申的 fill_form → submit）：
 *  1. 认领；备材料包（复用 preparePacketForAction：有真 JD 就定制，没成退回主简历并记原因）；
 *  2. derivatives 技能写标题（JD 指定格式时）和正文前两段；到岗那句、署名、默认标题、附件名由代码拼（compose.ts）；
 *  3. 排一封 send_mail（pending_review，等他过目），draft_mail 置 done（result 记 send_action_id）。
 * 永远不发信。模型超时 / 出错重试一次，仍不成 → draft_mail failed + 一句给人看的原因（等你里「N 封没写成」）。
 * 没连邮箱不是失败：照样写，发件邮箱留空，预览里 blockers 带 no_mailbox。
 * 日志只记动作与投递 id：`[career] mail-apply drafted action=… app=…`，不记标题、正文、收件人。
 */
import { extractMailFormat, type ActionQueueItem, type Job, type Vault } from '@career/core';
import { z } from 'zod';

import { preparePacketForAction, type PreparePacketDeps } from '../packet-prepare';
import { withTimeout } from '../tailor-for-job';
import { arrivalLine, assembleBody, chooseAttachmentName, defaultSubject, isInternJob, NAME_TOKEN, readMailProfile, signature, type MailProfile } from './compose';
import { DraftMailPayloadSchema, payloadObject, type DraftMailPayload, type SendMailPayload } from './payload';

export type AskSkill = <T>(skill: string, user: string, opts?: { refs?: string[]; temperature?: number }) => Promise<T>;

export interface DrafterDeps extends PreparePacketDeps {
  vault: Vault | null;
  askSkill: AskSkill;
  /** 一次起草最多等多久（测试注入）；缺省 MAIL_DRAFT_TIMEOUT_MS。 */
  draftTimeoutMs?: number;
}

/** 一次起草最多等多久：写两段正文 DeepSeek 通常 10–20 秒，给足余量；超了算一次失败。 */
export const MAIL_DRAFT_TIMEOUT_MS = 60_000;
/** 模型调用最多几次（第一次 + 重试一次）。 */
const MAIL_DRAFT_ATTEMPTS = 2;
/** 喂给模型的 JD 原文最多多少字：一份 JD 远小于此，超长的多半混了别的页面内容。 */
const JD_PROMPT_MAX_CHARS = 6000;

export type DraftOutcome = 'drafted' | 'failed' | 'skipped';

const DerivativesOut = z.object({
  email: z.object({ subject: z.string().catch(''), body: z.string().catch('') }).catch({ subject: '', body: '' }),
  attachment_name: z.string().catch(''),
}).passthrough();
type Written = { subject: string; body: string; attachment_name: string };

function failDraft(deps: DrafterDeps, action: Pick<ActionQueueItem, 'id' | 'application_id'>, reason: string, detail?: string): DraftOutcome {
  deps.repos.setActionStatus(action.id, 'failed', { error: reason });
  console.warn(`[career] mail-apply draft FAILED action=${action.id} app=${action.application_id ?? '-'} reason=${reason}${detail ? ` detail=${detail.slice(0, 200)}` : ''}`);
  return 'failed';
}

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

/** 调技能写一次；超时 / 出错 / 正文为空重试一次，仍不成抛最后一次的错。 */
async function writeWithRetry(deps: DrafterDeps, prompt: string): Promise<Written> {
  let last: unknown;
  for (let i = 0; i < MAIL_DRAFT_ATTEMPTS; i++) {
    try {
      const raw = await withTimeout(deps.askSkill<unknown>('derivatives', prompt, { temperature: 0.3 }), deps.draftTimeoutMs ?? MAIL_DRAFT_TIMEOUT_MS, () => new Error('写邮件超时'));
      const out = DerivativesOut.parse(raw);
      if (out.email.body.trim()) return { subject: out.email.subject.trim(), body: out.email.body, attachment_name: out.attachment_name };
      last = new Error('模型没给正文');
    } catch (error) {
      last = error;
    }
    console.warn(`[career] mail-apply write attempt=${i + 1} FAILED detail=${last instanceof Error ? last.message.slice(0, 200) : String(last)}`);
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** 拼出待发的那封（payload 里存占位符版本，预览与发送时解开）。 */
function sendPayloadOf(deps: DrafterDeps, action: ActionQueueItem, p: DraftMailPayload, job: Job, packetId: string, written: Written, format: MailFormat): SendMailPayload {
  const { profile, availability } = readMailProfile(deps.vault);
  const intern = isInternJob(job);
  const arrival = arrivalLine(intern, availability);
  const subjectAuto = !format.subject_format || !written.subject;
  const packet = deps.repos.getPacket(packetId);
  const filename = chooseAttachmentName(written.attachment_name, format.attachment_format, profile, job.title);
  return {
    account_id: deps.repos.listMailAccounts()[0]?.id ?? '',
    to: p.to, subject: subjectAuto ? defaultSubject(job.title, intern, profile, availability) : written.subject,
    body: assembleBody(written.body, arrival, signature(profile)),
    attachments: packet?.resume_pdf_path ? [{ path: packet.resume_pdf_path, filename, ...(packet.resume_pdf_sha256 ? { sha256: packet.resume_pdf_sha256 } : {}) }] : [],
    application_id: p.application_id, job_id: p.job_id, context: '邮件',
    purpose: 'apply', packet_id: packetId, subject_auto: subjectAuto, arrival_line: arrival, draft_action_id: action.id,
  };
}

/** 后台写一封投递邮件（见文件头）。返回 drafted / failed / skipped（没认领到：别处在写或已不在队列里）。 */
export async function draftMailForAction(deps: DrafterDeps, action: ActionQueueItem): Promise<DraftOutcome> {
  const claim = deps.repos.claimAction(action.id);
  if (!claim.ok) { console.log(`[career] mail-apply draft skipped action=${action.id} reason=${claim.reason}`); return 'skipped'; }
  const raw = payloadObject(action.id, action.payload_json);
  const parsed = DraftMailPayloadSchema.safeParse(raw);
  if (!parsed.success) return failDraft(deps, action, '这封邮件的材料不全', parsed.error.message);
  const job = deps.repos.getJob(parsed.data.job_id);
  if (!job) return failDraft(deps, action, '这个岗位已经不在了');
  const packet = await preparePacketForAction(deps, action, parsed.data, () => undefined);
  if (!packet || 'failed' in packet) return failDraft(deps, action, packet ? packet.failed : '这份简历没备好');
  const format = mailFormatOf(job);
  let written: Written;
  try {
    written = await writeWithRetry(deps, promptOf(deps, job, readMailProfile(deps.vault).profile, format, parsed.data.notes));
  } catch (error) {
    return failDraft(deps, action, '邮件没写成，再试一次', error instanceof Error ? error.message : String(error));
  }
  const send = deps.repos.enqueueAction('send_mail', sendPayloadOf(deps, action, parsed.data, job, packet.packetId, written, format), parsed.data.application_id);
  deps.repos.setActionStatus(action.id, 'done', { send_action_id: send.id });
  console.log(`[career] mail-apply drafted action=${action.id} app=${parsed.data.application_id} send=${send.id} subject_auto=${!format.subject_format}`);
  return 'drafted';
}
