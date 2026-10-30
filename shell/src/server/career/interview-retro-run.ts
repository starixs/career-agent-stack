/**
 * 真实面试复盘的执行（interview_retro 工具与面试页「开始复盘」共用一份）：
 * 调 interview-retro 技能 → 写回邀请建的那场面试 → 被问到的原题进题库 → 关掉这场的时间点 →
 * 新事实进经历库待确认、答不上来的列成「还要补」（出确认卡，不改简历）。
 * 面试页直接调它：复盘在页面上做完、结果留在页面上，不用绕到对话里来回说（流程诊断 2026-10-30 第 7 条）。
 */
import type { Repos } from '@career/core';

import { closeInterviewDeadline, retroTarget } from './interview-link';
import { applyRetroFollowups, type RetroFollowup } from './retro-followups';
import type { CareerStore } from './store';

/** 技能调用：(技能名, 用户消息, 选项) → 解析好的 JSON。工具层和路由层各自提供。 */
export type AskSkill = <T>(skill: string, user: string, opts: { refs?: string[]; temperature?: number }) => Promise<T>;
export type PostCard = (id: string, kind: string, title: string, data: Record<string, unknown>) => void;

export interface RetroInput {
  transcript: string; interview_id?: string; company_name?: string; title?: string;
  round?: 'hr' | 'first' | 'second' | 'final' | 'group' | 'other'; company_type?: string; date?: string;
  result?: 'none' | 'rejected' | 'advanced' | 'no_feedback_inferred'; result_source?: 'none' | 'official' | 'inferred';
}
export interface RetroOutput { interview_id: string; retro: Record<string, unknown>; questions_saved: number; followups: RetroFollowup[]; tables: string[] }

function retroPrompt(store: CareerStore, repos: Repos, args: RetroInput): string {
  const library = repos.experienceTree().map(e => `## [${e.id}] ${e.title}${e.org ? ` @ ${e.org}` : ''}\n${e.claims.map(c => `- [${c.id}][${c.status}] ${c.text}`).join('\n') || '- （无主张）'}`).join('\n\n') || '（经历库为空）';
  const history = JSON.stringify(store.listInterviews().slice(0, 5).map(i => ({ company: i.company_name, round: i.round, tags: i.tags_json, result: i.result })));
  return `本场信息：公司 ${args.company_name ?? '未知'}，岗位 ${args.title ?? '未知'}，轮次 ${args.round ?? '未知'}，企业性质 ${args.company_type ?? '未知'}，结果 ${args.result ?? 'none'}（来源 ${args.result_source ?? 'none'}）\n\n面试记录：\n${args.transcript}\n\n用户经历库：\n${library}\n\n历史面试（最近 5 场）：\n${history}`;
}

export async function runInterviewRetro(store: CareerStore, repos: Repos, ask: AskSkill, postCard: PostCard, args: RetroInput): Promise<RetroOutput> {
  const out = await ask<Record<string, unknown>>('interview-retro', retroPrompt(store, repos, args), { refs: ['题型诊断', '标签词表'], temperature: 0.2 });
  const patch = { transcript: args.transcript, retro_json: out, tags_json: out.tags ?? [], result: args.result, result_source: args.result_source, company_name: args.company_name, title: args.title, round: args.round, date: args.date };
  // 没给 interview_id 时落回邀请建的那一场，挂在对应申请上，不另起一条孤儿记录
  const target = retroTarget(store, repos, args);
  const interview = target.interview_id ? store.updateInterview(target.interview_id, patch as never) : store.createInterview({ ...patch, application_id: target.application_id ?? null } as never);
  // 真实面试里被问到的题进题库（"我见过的"），同一题跨场次累计
  const asked = Array.isArray((out as { questions?: unknown }).questions) ? (out as { questions: Array<{ quote?: string; type?: string; content_tags?: string[] }> }).questions : [];
  const seen = asked.filter(q => q?.quote && q.quote.trim().length >= 4).map(q => repos.upsertQuestion({ content: q.quote!, kind: 'interview', category: q.type ?? null, company_name: args.company_name ?? interview.company_name ?? null, title: args.title ?? interview.title ?? null, source: 'seen', source_ref: `interview:${interview.id}`, tags: q.content_tags ?? [] }).id);
  const closed = closeInterviewDeadline(repos, interview.id);
  const followups = applyRetroFollowups(repos, out);
  for (const f of followups) {
    postCard(`retro-claims:${interview.id}:${f.experience_id}`, 'claims_confirm', f.claims.length ? `面试里说到「${f.experience_title}」的 ${f.claims.length} 条新说法` : `「${f.experience_title}」还有 ${f.gaps.length} 处要补`, {
      experience_id: f.experience_id, experience_title: f.experience_title, source: 'interview_retro', interview_id: interview.id, gaps: f.gaps,
      claims: f.claims.map(c => ({ id: c.id, text: c.text, result_metric: c.result_metric ?? null, attribution: c.attribution ?? null })),
    });
  }
  const tables = ['interview', ...(args.date || closed ? ['deadline'] : []), ...(seen.length ? ['question'] : []), ...(followups.some(f => f.claims.length) ? ['claim'] : [])];
  return { interview_id: interview.id, retro: out, questions_saved: seen.length, followups, tables };
}
