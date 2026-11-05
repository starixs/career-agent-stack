/**
 * 邮件投递两种动作的 payload 形状（跨进程落库的数据：读出来先过 schema，不用断言）。
 *  - draft_mail：后台写邮件要的材料（岗位、投递、简历计划、收件人、他的要求）。
 *  - send_mail：一封待发的邮件。老的 mail_compose 只写了前几项；邮件投递另加用途、材料包、标题是否代码拼的、到岗那句。
 */
import { z } from 'zod';

import type { MailPurpose } from '../../../shared/careerMailApply';
import { PacketResumePlanSchema } from '../packets';

/** 与合同 MailPurpose 同一组值（satisfies 让两边漂移时编译报错）。 */
const MailPurposeSchema = z.enum(['apply', 'followup', 'reply']) satisfies z.ZodType<MailPurpose>;

export const SendMailAttachmentSchema = z.object({
  path: z.string(),
  filename: z.string().optional(),
  /** 批准时冻结的文件哈希（材料包）。 */
  sha256: z.string().optional(),
});

export const SendMailPayloadSchema = z.object({
  /** 从哪个邮箱发；还没连邮箱时为空串（预览里 blockers 带 no_mailbox）。 */
  account_id: z.string().catch(''),
  to: z.string(),
  cc: z.string().optional(),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(SendMailAttachmentSchema).optional(),
  application_id: z.string().nullish(),
  job_id: z.string().nullish(),
  material_ids: z.array(z.string()).optional(),
  /** 用于素材一致性记录的场合名，缺省"邮件"。 */
  context: z.string().optional(),
  /** 投递 / 跟进 / 回信；老动作没写（都是投递邮件）。 */
  purpose: MailPurposeSchema.optional(),
  packet_id: z.string().optional(),
  /** 标题是代码按默认格式拼的：到岗信息变了可以重排；JD 指定格式或他改过的为 false。 */
  subject_auto: z.boolean().optional(),
  /** 正文里由代码拼的到岗那句（原样存一份，到岗信息变了按它找到再换）。 */
  arrival_line: z.string().optional(),
  /** 是哪个 draft_mail 写出来的。 */
  draft_action_id: z.string().optional(),
  /** 线程头（跟进 / 回信接在哪封信下面）：发信时写进 In-Reply-To / References。 */
  in_reply_to: z.string().nullish(),
  references: z.array(z.string()).optional(),
  /** 跟进 / 回信：接的那封信（mail_message id；回信是对方来的那封，跟进是原投递邮件）。 */
  reply_to_mail_id: z.string().optional(),
  /** 退信后照抄的一封：被退回的收件地址（收件人还是它 → bad_recipient）与被退回的那封（mail_message id，去重用）。 */
  bounced_from: z.string().optional(),
  bounced_mail_id: z.string().optional(),
}).passthrough();
export type SendMailPayload = z.infer<typeof SendMailPayloadSchema>;

export const DraftMailPayloadSchema = z.object({
  job_id: z.string(),
  application_id: z.string(),
  resume_id: z.string(),
  resume_plan: PacketResumePlanSchema,
  to: z.string(),
  /** 他对这封的要求（对话里说的）。 */
  notes: z.string().optional(),
}).passthrough();
export type DraftMailPayload = z.infer<typeof DraftMailPayloadSchema>;

/** 发出之后的两种 draft_mail：跟进（接在原投递邮件下）、回信（回对方那封）。没写 purpose 的都是投递。 */
export const FollowDraftPayloadSchema = z.object({
  purpose: z.enum(['followup', 'reply']),
  job_id: z.string(),
  application_id: z.string(),
  /** 接的那封信（mail_message id）。 */
  reply_to_mail_id: z.string(),
  notes: z.string().optional(),
}).passthrough();
export type FollowDraftPayload = z.infer<typeof FollowDraftPayloadSchema>;

/** action.payload_json → 对象；坏 JSON 抛错（带动作 id），不当成空邮件。 */
export function payloadObject(actionId: string, raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch (error) {
    throw new Error(`动作 ${actionId} 的内容读不出来：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 读一封待发邮件的 payload；形状不对抛错（带动作 id 和哪一项不对）。 */
export function parseSendMailPayload(actionId: string, raw: string): SendMailPayload {
  const parsed = SendMailPayloadSchema.safeParse(payloadObject(actionId, raw));
  if (!parsed.success) throw new Error(`邮件 ${actionId} 的内容格式不对：${parsed.error.issues.map(i => i.path.join('.')).join('、')}`);
  return parsed.data;
}
