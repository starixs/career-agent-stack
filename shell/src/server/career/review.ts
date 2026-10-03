/**
 * 每周复盘：漏斗（Repos.funnel）→ weekly-review 技能 → 落 weekly_review。路由与工具共用。
 */
import type { WeeklyReview } from '@career/core';

import { dataChanged, focus, type IntakeDeps } from './intake';
import { loadSkillPrompt } from './skills';

export interface WeeklyReviewOutput {
  facts?: Record<string, number>;
  insights?: Array<{ finding: string; evidence?: string; strength?: string }>;
  suggestions?: Array<{ action: string; why?: string; category?: string; priority?: number }>;
  baseline_note?: string;
  small_action?: string;
  tone_flag?: 'normal' | 'low_mood';
}

export async function generateWeeklyReview(deps: IntakeDeps, opts: { week_start?: string; user_note?: string } = {}): Promise<{ review: WeeklyReview; output: WeeklyReviewOutput; funnel: ReturnType<IntakeDeps['repos']['funnel']> }> {
  const r = deps.repos;
  const nowIso = deps.now?.() ?? new Date().toISOString();
  const weekStart = opts.week_start ?? deps.core.weekStartOf(nowIso);
  const funnel = r.funnel(nowIso);
  const apps = r.applicationsWithJob();
  const weekMs = Date.parse(weekStart + 'T00:00:00Z');
  const thisWeek = apps.filter(a => Date.parse(a.created_at) >= weekMs);
  const interviews = r.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM interview WHERE created_at >= ?', [weekStart])[0]?.n ?? 0;
  const previous = r.listWeeklyReviews(1)[0];
  let output: WeeklyReviewOutput = {};
  if (deps.llm) {
    const system = await loadSkillPrompt('weekly-review');
    const user = [
      `周起点：${weekStart}，今天：${nowIso.slice(0, 10)}`,
      `本周新增投递：${thisWeek.length}；本周新增面试记录：${interviews}`,
      `累计漏斗（整体）：${JSON.stringify(funnel.overall)}`,
      `按岗位类别：${JSON.stringify(funnel.by_category)}`,
      `按平台：${JSON.stringify(funnel.by_platform)}`,
      previous ? `上次复盘建议：${previous.suggestions_json}` : '上次复盘：无',
      opts.user_note ? `用户补充：${opts.user_note}` : '',
      `用户偏好：${JSON.stringify(r.kvGet('preferences') ?? {})}`,
    ].filter(Boolean).join('\n');
    const res = await deps.llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0.3 });
    output = deps.core.extractJson<WeeklyReviewOutput>(res.text);
  }
  const review = r.saveWeeklyReview({ week_start: weekStart, funnel: { ...funnel, this_week: { applied: thisWeek.length, interviews } }, insights: output.insights ?? [], suggestions: output.suggestions ?? [], small_action: output.small_action ?? null });
  dataChanged(deps, ['weekly_review']);
  focus(deps, { surface: 'review', id: review.id });
  return { review, output, funnel };
}
