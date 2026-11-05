/**
 * 后台写跟进与回信（face-mail-apply 阶段二 P2.5 / P2.6）：draft_mail（purpose followup / reply）→ send_mail 待审。永远不发信。
 *  - 回信：收件人 = 对方发件地址；标题「Re: 原主题」；接在对方那封下面（In-Reply-To / References）；不带附件；
 *    正文 ≤120 字，直接回答对方问的。
 *  - 跟进：接在原投递邮件下面；正文 ≤80 字（哪天投了什么岗、一句最强匹配点、问进展）；附同一份冻结的简历。
 * 不编造（不变量 8）：模型只拿到已确认的资料、到岗信息、已确认主张；资料里没有的写成「【待补：缺什么】」（预览标出、
 * blockers 带 unresolved，他补上才能发）。代码再把一道关：正文里的数字必须出现在给它的事实或对方原信里，否则那一处换成待补。
 * 私密资料：给模型的对方原信先经私密库 redact（对方引用的原信里可能有他的手机号）；存进 payload 的标题 / 正文同样存占位符版。
 * 日志只记动作与投递 id。
 */
import type { ActionQueueItem, Job, MailMessage, Repos, Vault } from '@career/core';
import { z } from 'zod';

import { bareAddress, reSubject } from '../mail/reply-link';
import { assembleBody, gapOf, readMailProfile, signature, NAME_TOKEN } from './compose';
import { askWithRetry, failDraft, finishDraft, type DraftOutcome, type DrafterDeps } from './draft-common';
import { heardBackSince } from './followup';
import { parseSendMailPayload, type FollowDraftPayload, type SendMailPayload } from './payload';

/** 给模型的对方原信最多多少字：问话都在最前面，后面多半是引用的原信。 */
const INCOMING_PROMPT_MAX_CHARS = 3000;
/** 正文字数上限（技能里也写了；这里只用来告诉模型）：回信直接答问题，跟进一句话问进展。 */
const BODY_LIMIT: Record<FollowDraftPayload['purpose'], number> = { reply: 120, followup: 80 };

const MailReplyOut = z.object({ body: z.string().catch('') }).passthrough();
const parseBody = (raw: unknown): string | null => {
  const body = MailReplyOut.parse(raw).body.trim();
  return body ? body : null;
};

const redact = (vault: Vault | null, text: string): string => (vault ? vault.redact(text) : text);
const DIGITS_RX = /\d+(?:[.:：]\d+)*/g;

/** 正文里出现、事实里没有的数字换成待补（模型偶尔会顺手编一个日期或天数）。 */
export function guardNumbers(body: string, grounded: string): string {
  return body.replace(DIGITS_RX, n => (grounded.includes(n) ? n : gapOf(`核对「${n}」`)));
}

interface FollowCtx { job: Job; source: MailMessage; p: FollowDraftPayload }

function factsOf(deps: DrafterDeps): string {
  const { profile, availability: a } = readMailProfile(deps.vault);
  const claims = deps.repos.listClaims().filter(c => c.status !== 'pending').map(c => `- ${c.text}${c.result_metric ? `（${c.result_metric}）` : ''}`).join('\n') || '（无）';
  return [
    `姓名：${NAME_TOKEN}（署名由系统补，正文里不用写）`,
    `学校：${profile.school ?? '未填'}；专业：${profile.major ?? '未填'}；毕业时间：${profile.graduation ?? '未填'}`,
    `每周可实习：${a.days_per_week ? `${a.days_per_week} 天` : '未填'}；可连续实习：${a.months ? `${a.months} 个月` : '未填'}；最早到岗：${a.start ?? '未填'}`,
    `已确认主张：\n${claims}`,
  ].join('\n');
}

function promptOf(deps: DrafterDeps, c: FollowCtx): string {
  const head = c.p.purpose === 'reply'
    ? [`模式：回信（正文不超过 ${BODY_LIMIT.reply} 字）。直接回答对方问的。`, `对方来信（主题：${c.source.subject ?? ''}）：\n${redact(deps.vault, (c.source.body_text ?? c.source.snippet ?? '').slice(0, INCOMING_PROMPT_MAX_CHARS))}`]
    : [`模式：跟进（正文不超过 ${BODY_LIMIT.followup} 字）。说明哪天投了什么岗、重申一句最强的匹配点、问一下进展；语气平实，不催促不讨好。`, `投递日期：${(c.source.received_at ?? c.source.created_at).slice(0, 10)}`];
  return [
    ...head,
    `公司：${c.job.company_name ?? '未知'}\n岗位：${c.job.title}`,
    `已确认的资料（只能用这些；需要但这里没有的，写成「【待补：缺什么】」，不许编）：\n${factsOf(deps)}`,
    `用户要求：${c.p.notes?.trim() || '无'}`,
  ].join('\n\n');
}

/** 跟进附同一份冻结的简历：原投递那封的附件与材料包。 */
function originalAttachments(repos: Repos, source: MailMessage): Pick<SendMailPayload, 'attachments' | 'packet_id'> {
  const action = source.action_id ? repos.getAction(source.action_id) : undefined;
  if (!action) return { attachments: [] };
  const p = parseSendMailPayload(action.id, action.payload_json);
  return { attachments: p.attachments ?? [], ...(p.packet_id ? { packet_id: p.packet_id } : {}) };
}

function sendPayloadOf(deps: DrafterDeps, c: FollowCtx, body: string): SendMailPayload {
  const reply = c.p.purpose === 'reply';
  const to = (reply ? bareAddress(c.source.from_addr) : c.source.to_addr?.trim()) ?? '';
  const refs = [...new Set([reply ? c.source.in_reply_to : null, c.source.message_id].filter((x): x is string => !!x))];
  return {
    account_id: c.source.account_id, to,
    subject: redact(deps.vault, reSubject(c.source.subject)),
    body: assembleBody(body, '', signature(readMailProfile(deps.vault).profile)),
    ...(reply ? { attachments: [] } : originalAttachments(deps.repos, c.source)),
    application_id: c.p.application_id, job_id: c.p.job_id, context: reply ? '回信' : '跟进',
    purpose: c.p.purpose, subject_auto: false, in_reply_to: c.source.message_id, references: refs, reply_to_mail_id: c.source.id,
  };
}

/** 事实底稿（本机比对用，含明文）：资料、到岗信息、对方原信、投递日期、他的要求。 */
function groundedText(deps: DrafterDeps, c: FollowCtx): string {
  return [factsOf(deps), c.source.body_text ?? '', c.source.subject ?? '', c.source.received_at ?? '', c.p.notes ?? '', c.job.title, c.job.company_name ?? ''].join('\n');
}

/** 写一封跟进或回信（见文件头）。调用方已认领动作。 */
export async function draftFollowMail(deps: DrafterDeps, action: ActionQueueItem, p: FollowDraftPayload): Promise<DraftOutcome> {
  const job = deps.repos.getJob(p.job_id);
  const source = deps.repos.getMailMessage(p.reply_to_mail_id);
  if (!job) return failDraft(deps, action, '这个岗位已经不在了');
  if (!source) return failDraft(deps, action, '要接的那封信不在了');
  // 跟进还没写完对方就回了：不用跟了（作废，不进失败）
  if (p.purpose === 'followup' && heardBackSince(deps.repos, p.application_id, Date.parse(source.received_at ?? source.created_at))) {
    deps.repos.setActionStatus(action.id, 'rejected', { reason: '对方已经回信了', by: 'system' });
    return 'skipped';
  }
  const c: FollowCtx = { job, source, p };
  let body: string;
  try {
    body = await askWithRetry(deps, 'mail-reply', promptOf(deps, c), parseBody);
  } catch (error) {
    return failDraft(deps, action, p.purpose === 'reply' ? '回信没写成，再试一次' : '跟进邮件没写成，再试一次', error instanceof Error ? error.message : String(error));
  }
  const send = finishDraft(deps.repos, action, sendPayloadOf(deps, c, guardNumbers(body, groundedText(deps, c))), p.application_id);
  console.log(`[career] mail-apply drafted purpose=${p.purpose} action=${action.id} app=${p.application_id} send=${send.id}`);
  return 'drafted';
}
