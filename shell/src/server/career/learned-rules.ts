/**
 * AI 学到的规则：把散在各处的「以后不用问我」摊开给人看，并能撤回。
 *
 *  - 免审的表（kv `apply:page_trust:*`，见 submit-policy）：哪个网站、连续几次人工直接通过、依据是哪几家；
 *  - auto 模式开关（kv `apply:auto_mode`）；
 *  - 提交前在页面上改过、写回答案库的值（answer_bank source=page_edit）：改成了什么、在哪家改的。
 *
 * 撤回免审只清零计数（之后要重新人工通过 LEARN_THRESHOLD 次）；靠这条免审批准、还没执行的提交退回待审，
 * 已经投出去的撤不回，只如实列出来。私密类问题（personal / self_id）只露问题不露值。
 */
import type { ActionQueueItem, AnswerRow, Repos } from '@career/core';

import { LEARN_THRESHOLD, getAutoMode, resetPageTrust, type PageTrust, type SubmitDecision } from './submit-policy';

const TRUST_PREFIX = 'apply:page_trust:';

export interface PageTrustView { signature: string; host: string | null; streak: number; exempt: boolean; companies: string[]; updatedAt: string }
export interface PageEditView { question: string; answer: string | null; company: string | null; site: string | null; updatedAt: string }
export interface LearnedRules { page_trusts: PageTrustView[]; auto_mode: { enabled: boolean; updatedAt: string | null }; page_edits: PageEditView[]; learn_threshold: number }
export interface RevokeResult { revoked: number; returned_to_review: string[]; already_submitted: string[] }

const companyOf = (repos: Repos, applicationId: string | null | undefined): string | null => {
  const app = applicationId ? repos.getApplication(applicationId) : undefined;
  return app ? repos.getJob(app.job_id)?.company_name ?? null : null;
};
const parse = (raw: string | null | undefined): Record<string, unknown> => { try { const v = JSON.parse(raw ?? '{}'); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; } };

function listTrusts(repos: Repos): Array<{ signature: string; trust: PageTrust }> {
  return repos.db.all<{ key: string; value_json: string }>(`SELECT key, value_json FROM kv WHERE key LIKE ? ORDER BY updated_at DESC`, [`${TRUST_PREFIX}%`])
    .map(r => ({ signature: r.key.slice(TRUST_PREFIX.length), trust: JSON.parse(r.value_json) as PageTrust }));
}

function trustView(repos: Repos, signature: string, trust: PageTrust): PageTrustView {
  const companies = (trust.applicationIds ?? []).map(id => companyOf(repos, id)).filter((c): c is string => !!c);
  return { signature, host: trust.host ?? null, streak: trust.streak, exempt: trust.streak >= LEARN_THRESHOLD, companies, updatedAt: trust.updatedAt };
}

function pageEditView(repos: Repos, a: AnswerRow): PageEditView {
  const ev = repos.db.get<{ application_id: string | null; site_host: string | null }>(
    `SELECT application_id, site_host FROM answer_event WHERE question_key=? AND source='page_edit' ORDER BY created_at DESC LIMIT 1`, [a.question_key]);
  return { question: a.question_text, answer: a.sensitivity === 'normal' ? a.answer : null, company: companyOf(repos, ev?.application_id), site: ev?.site_host ?? null, updatedAt: a.updated_at };
}

export function listLearnedRules(repos: Repos): LearnedRules {
  const auto = getAutoMode(repos);
  return {
    page_trusts: listTrusts(repos).filter(t => t.trust.streak > 0).map(t => trustView(repos, t.signature, t.trust)),
    auto_mode: { enabled: auto.enabled, updatedAt: auto.updatedAt ?? null },
    page_edits: repos.listAnswers().filter(a => a.source === 'page_edit').map(a => pageEditView(repos, a)),
    learn_threshold: LEARN_THRESHOLD,
  };
}

/** 免审批准时写进卷宗的一句话：凭哪条规则、依据是哪几家。用户事后问「为什么没让我审」就看这里。 */
export function explainApproval(repos: Repos, decision: Extract<SubmitDecision, { approve: true }>, signature: string | null | undefined): string {
  if (decision.by === 'auto') return `没等你审就提交：你开着 auto 模式，填后检查全部通过（${decision.reason}）`;
  const trust = signature ? repos.kvGet<PageTrust>(`${TRUST_PREFIX}${signature}`) : undefined;
  const view = trust && signature ? trustView(repos, signature, trust) : undefined;
  const basis = view?.companies.length ? `；依据是你之前在 ${view.host ?? '这个网站'} 上直接批准过的 ${view.companies.join('、')}` : '';
  return `没等你审就提交（自学习免审）：${decision.reason}${basis}。不想这样可以说「撤回 ${view?.host ?? '这个网站'} 的免审」`;
}

const submitsOn = (repos: Repos, signatures: Set<string>, status: ActionQueueItem['status']) =>
  repos.listActions(status).filter(a => a.kind === 'submit' && a.approved_by === 'learned' && signatures.has(String(parse(a.payload_json).formSignature ?? '')));

/** 撤回某个网站（或某一张表）的免审。 */
export function revokePageTrust(repos: Repos, target: { host?: string; signature?: string }): RevokeResult {
  const hit = listTrusts(repos).filter(t => t.trust.streak > 0 && (t.signature === target.signature || (!!target.host && t.trust.host === target.host)));
  const signatures = new Set(hit.map(t => t.signature));
  for (const sig of signatures) resetPageTrust(repos, sig);
  const queued = submitsOn(repos, signatures, 'approved');
  for (const a of queued) repos.reopenAction(a.id, { status: 'trust_revoked', message: '你撤回了这个网站的免审，提交前要你看一遍' });
  return {
    revoked: signatures.size,
    returned_to_review: queued.map(a => companyOf(repos, a.application_id) ?? a.id),
    already_submitted: submitsOn(repos, signatures, 'done').map(a => companyOf(repos, a.application_id) ?? a.id),
  };
}
