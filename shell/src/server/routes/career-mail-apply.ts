/**
 * 邮件投递的预览与改动接口（合同 shared/careerMailApply.ts 文件头；挂在 `/api/career/*` 下，由 career.ts 的路由表展开）：
 *  - GET  /api/career/mail-apply/drafts?ids=a,b   → { drafts }：只给 pending_review 的 send_mail，id 不存在或状态不对的略过；
 *  - POST /api/career/mail-apply/drafts/:actionId ← MailDraftPatch → { draft }；
 *  - POST /api/career/mail-apply/availability     ← InternAvailability → { drafts }（存资料并重排所有待发邮件）。
 *  - GET  /api/career/mail-apply/thread?application_id= → { thread }：一份申请的邮件往来（阶段二）；申请不存在 404。
 * 发出 / 不投沿用 POST /api/career/actions/review。整封明文只经这里给渲染层，不进日志。
 */
import type { Repos, Vault } from '@career/core';
import { z } from 'zod';

import type { InternAvailability, MailDraftPatch } from '../../shared/careerMailApply';
import { saveAvailability } from '../career/mail-apply/availability';
import { MailDraftError, patchMailDraft } from '../career/mail-apply/edit';
import { mailThreadView } from '../career/mail-apply/thread';
import { mailDraftViews } from '../career/mail-apply/view';
import type { PacketDeps } from '../career/packets';
import type { CareerStore } from '../career/store';

import { fail, ok, type Json } from './career-http';

export interface MailApplyRouteCtx {
  repos: Repos; store: CareerStore; vault: Vault; url: URL; params: Record<string, string>; body: Json;
  /** 换简历时重新导 PDF、冻结材料包用。 */
  packetDeps: () => PacketDeps;
  dataChanged: (tables: string[]) => void;
}
type Handler = (ctx: MailApplyRouteCtx) => Response | Promise<Response>;

/** 一次最多取几封：一批投递最多 50 家（jobs_apply 上限）。 */
const MAX_DRAFT_IDS = 50;

const PatchSchema = z.object({
  to: z.string().optional(), subject: z.string().optional(), body: z.string().optional(),
  resume_id: z.string().optional(), account_id: z.string().optional(),
}).strict() satisfies z.ZodType<MailDraftPatch>;

const nullableText = z.string().nullable().transform(v => (v && v.trim() ? v.trim() : null));
const AvailabilitySchema = z.object({ days_per_week: nullableText, months: nullableText, start: nullableText }) satisfies z.ZodType<InternAvailability, unknown>;

const issues = (e: z.ZodError) => e.issues.map(i => i.path.join('.') || i.message).join('、');

export function mailApplyRoutes(): Array<[string, string, Handler]> {
  return [
    ['GET', '/api/career/mail-apply/drafts', ({ repos, store, vault, url }) => {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_DRAFT_IDS);
      if (!ids.length) return fail('需要 ids');
      return ok({ drafts: mailDraftViews({ repos, store, vault }, ids) });
    }],
    ['POST', '/api/career/mail-apply/drafts/:actionId', async ({ repos, store, vault, params, body, packetDeps, dataChanged }) => {
      const patch = PatchSchema.safeParse(body);
      if (!patch.success) return fail(`改动的格式不对：${issues(patch.error)}`);
      try {
        const draft = await patchMailDraft({ ...packetDeps(), repos, store, vault }, params.actionId, patch.data);
        dataChanged(['action_queue']);
        return ok({ draft });
      } catch (error) {
        if (error instanceof MailDraftError) return fail(error.message, 409);
        throw error;
      }
    }],
    ['GET', '/api/career/mail-apply/thread', ({ repos, store, vault, url }) => {
      const applicationId = url.searchParams.get('application_id')?.trim();
      if (!applicationId) return fail('需要 application_id');
      const thread = mailThreadView({ repos, store, vault }, applicationId);
      return thread ? ok({ thread }) : fail(`投递不存在：${applicationId}`, 404);
    }],
    ['POST', '/api/career/mail-apply/availability', ({ repos, store, vault, body, dataChanged }) => {
      const parsed = AvailabilitySchema.safeParse(body);
      if (!parsed.success) return fail(`到岗信息的格式不对：${issues(parsed.error)}`);
      const drafts = saveAvailability({ repos, store, vault }, parsed.data);
      dataChanged(['vault', 'action_queue']);
      return ok({ drafts });
    }],
  ];
}
