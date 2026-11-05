/**
 * 邮箱与邮件投递工具（从 career-tools.ts 挪出：那个文件已超长）。
 *  - mail_accounts / mail_sync / mail_list：连了哪些邮箱、立刻同步、列求职相关邮件。
 *  - mail_compose：投递邮件走和网申同一条路（face-mail-apply 2026-11-05）——岗位记下投递邮箱 → applyJobs →
 *    后台写邮件（draft_mail）→ 写好进「等你」过目再发。不在这一轮里起草，立刻返回。
 * 明文边界（不变量 4）：返回给模型的只有公司、岗位、动作 id、收件域名；不给收件人全址、标题、正文。
 */
import type { tool as SdkTool } from '@anthropic-ai/claude-agent-sdk';
import { emailDomain, isEmailAddress, type Job, type MailAccount, type MailMessage, type Repos } from '@career/core';
import type { z as Zod } from 'zod/v4';

import type { IntakeDeps } from '../career/intake';
import { MAIL_PRESETS } from '../career/mail/providers';
import { syncAllMailAccounts, syncMailAccount } from '../career/mail/sync';
import type { PacketDeps } from '../career/packets';
import type { CareerStore } from '../career/store';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface MailToolDeps {
  tool: typeof SdkTool;
  z: typeof Zod;
  repos: () => Repos;
  store: () => CareerStore;
  wrap: (fn: () => Promise<ToolResult> | ToolResult) => () => Promise<ToolResult>;
  text: (data: unknown) => ToolResult;
  err: (message: unknown) => ToolResult;
  changed: (...tables: string[]) => void;
  card: (id: string, kind: string, title: string, data: Record<string, unknown>) => void;
  progress: (phase: string, message: string) => void;
  intakeDeps: () => IntakeDeps;
  packetDeps: () => PacketDeps;
}

/** mail_list 一次最多列多少封（默认 30）。 */
const MAIL_LIST_DEFAULT = 30;
const MAIL_LIST_MAX = 100;

const accountRow = (a: MailAccount) => ({ id: a.id, provider: a.provider, address: a.address, status: a.status, last_sync_at: a.last_sync_at, last_error: a.last_error });

/** 发出去的信只给收件域名：标题、正文、全址不进模型上下文（不变量 4）。收到的信照旧给摘要，归档和回答他要用。 */
function messageRow(m: MailMessage) {
  const base = { id: m.id, direction: m.direction, received_at: m.received_at, kind: m.kind, application_id: m.application_id };
  if (m.direction === 'out') return { ...base, to_domain: emailDomain(m.to_addr ?? '') || null };
  return { ...base, from: m.from_addr, to: m.to_addr, subject: m.subject, snippet: m.snippet };
}

/** mail_compose 认岗位：给了 job_id / application_id 用已有的；只给了公司 + 岗位名就建一条手动岗位。 */
function jobForCompose(d: MailToolDeps, args: { to?: string; job_id?: string; application_id?: string; company?: string; title?: string; jd?: string }): Job | string {
  const r = d.repos();
  if (args.job_id) return r.getJob(args.job_id) ?? `岗位不存在：${args.job_id}`;
  if (args.application_id) {
    const app = r.getApplication(args.application_id);
    return (app && r.getJob(app.job_id)) || `投递不存在：${args.application_id}`;
  }
  if (args.company?.trim() && args.title?.trim()) {
    return r.upsertJob({ source_platform: 'manual', company_name: args.company.trim(), title: args.title.trim(), ...(args.to ? { apply_email: args.to } : {}), ...(args.jd?.trim() ? { jd_raw: args.jd.trim() } : {}) });
  }
  return '需要 job_id，或者公司 + 岗位名（company + title）';
}

export function createMailTools(d: MailToolDeps) {
  const { tool, z } = d;
  return [
    tool('mail_accounts', '已绑定的邮箱与各家邮箱的绑定说明。还没绑定时对话里会出现「绑定邮箱」卡片，用户在卡片里填地址和授权码（不经过你），不要让用户把授权码发到对话里。', {}, d.wrap(() => {
      const accounts = d.repos().listMailAccounts();
      const presets = Object.values(MAIL_PRESETS).map(p => ({ provider: p.provider, label: p.label, help: p.help }));
      if (!accounts.length) d.card('mail_bind', 'mail_bind', '绑定求职邮箱', { presets });
      return d.text({ accounts: accounts.map(accountRow), presets });
    })),

    tool('mail_sync', '立刻同步邮箱：新邮件里的面试邀请 / 测评 / 拒信 / Offer 会自动归档到收件箱与卷宗。', { account_id: z.string().optional() }, async (args) => d.wrap(async () => {
      d.progress('mail_sync', '正在同步邮箱');
      const deps = d.intakeDeps();
      if (args.account_id) {
        const account = d.repos().getMailAccount(args.account_id);
        if (!account) return d.err(`邮箱账号不存在：${args.account_id}`);
        return d.text({ results: [await syncMailAccount(deps, account)] });
      }
      if (d.repos().listMailAccounts().length === 0) return d.err('还没有绑定邮箱，请让用户在「收件箱」面板绑定（QQ / 163 / Gmail 等填授权码即可）。');
      return d.text({ results: await syncAllMailAccounts(deps) });
    })()),

    tool('mail_list', '列出与求职相关的邮件（可按投递过滤）；发出去的投递邮件也在这里（只给收件域名，内容在卷宗和邮件预览里看）。', { application_id: z.string().optional(), direction: z.enum(['in', 'out']).optional(), limit: z.number().int().min(1).max(MAIL_LIST_MAX).optional() }, async (args) => d.wrap(() =>
      d.text({ messages: d.repos().listMailMessages({ application_id: args.application_id, direction: args.direction, relevance: args.application_id ? undefined : 'job', limit: args.limit ?? MAIL_LIST_DEFAULT }).map(messageRow) }))()),

    tool('mail_compose', '投递邮件（JD 写「简历发到 xx@xx.com」、或他说「把简历发到 hr@x.com 应聘 XX 公司产品实习」时用）：和网申同一条路——记下投递邮箱、建投递，邮件在后台写（按岗位定制简历作附件，标题、正文、附件名按规范），写好出现在右边「等你」里给他过目，他点发出才发。不在这一轮里起草，立刻返回；回复一句短话（如「在后台写了，写好会出现在等你里」），不要复述邮件内容。已在 job 库里的给 job_id；没有就给 company + title（有 JD 原文一并给 jd）。notes 是他对这封的要求。没连邮箱也照样写，过目时会请他连。', {
      to: z.string().optional().describe('收件邮箱；岗位已记下投递邮箱时可不给'),
      job_id: z.string().optional(), application_id: z.string().optional(),
      company: z.string().optional(), title: z.string().optional(), jd: z.string().optional().describe('JD 原文（建新岗位时）'),
      notes: z.string().optional().describe('他对这封邮件的要求'),
    }, async (args) => d.wrap(async () => {
      const to = args.to?.trim();
      if (to && !isEmailAddress(to)) return d.err('收件邮箱看起来不对，问他要一个完整的邮箱地址');
      const job = jobForCompose(d, { ...args, to });
      if (typeof job === 'string') return d.err(job);
      if (to && job.apply_email !== to) d.repos().db.update('job', job.id, { apply_email: to, updated_at: new Date().toISOString() });
      const email = to ?? job.apply_email;
      if (!email) return d.err('这个岗位没写投递邮箱：问他发到哪个邮箱');
      const { applyJobs } = await import('../career/batch-apply');
      const res = await applyJobs({ ...d.packetDeps(), store: d.store() }, [job.id], null, { notes: args.notes ?? null });
      d.changed('job', 'application', 'action_queue');
      const actionId = res.started.find(id => d.repos().getAction(id)?.kind === 'draft_mail');
      const base = { company: job.company_name, title: job.title, to_domain: emailDomain(email) };
      if (!actionId) return d.text({ ...base, started: false, reason: res.skipped[0]?.reason ?? '没能开始', note: '把原因用一句话告诉他；不要复述邮件。' });
      return d.text({ ...base, started: true, action_id: actionId, note: '邮件在后台写，写好会出现在右边「等你」里给他过目；回复一句短话，不要复述邮件。' });
    })()),
  ];
}
