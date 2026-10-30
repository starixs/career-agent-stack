/**
 * 每周复盘：漏斗（Repos.funnel）→ weekly-review 技能 → 落 weekly_review。路由与工具共用。
 */
import type { FunnelRow, MonthBoard, StageHistoryRow, WeeklyReview } from '@career/core';

import { changeSignals, type ChangeSignal } from './change-signals';
import { dataChanged, focus, type IntakeDeps } from './intake';
import { loadSkillPrompt } from './skills';

export interface WeeklyReviewOutput {
  facts?: Record<string, number>;
  insights?: Array<{ finding: string; evidence?: string; strength?: string }>;
  suggestions?: Array<{ action: string; why?: string; category?: string; priority?: number; tool?: ChangeSignal['tool'] }>;
  baseline_note?: string;
  small_action?: string;
  tone_flag?: 'normal' | 'low_mood';
}

export interface WeekFacts { applied: number; advanced: number; rejected: number; silent: number; interviews: number }

/**
 * 本周事实从阶段历史里数，不交给模型报：投出按第一次真正投出的时刻（isSendNote，不含只评估、邮件补建的），
 * 推进 = 本周第一次走到面试或 Offer，拒信 = 本周进入 rejected。静默是此刻的快照（漏斗里的 silent）。
 */
export function weekFacts(history: StageHistoryRow[], weekStartMs: number, isSendNote: (note: string | null | undefined) => boolean, silent: number, interviews: number): WeekFacts {
  const firstSend = new Map<string, number>();
  const advanced = new Set<string>();
  const seenAdvance = new Set<string>();
  let rejected = 0;
  for (const h of history) {
    const t = Date.parse(h.created_at);
    if (h.to_stage === 'applied' && !firstSend.has(h.application_id) && isSendNote(h.note)) firstSend.set(h.application_id, t);
    if ((h.to_stage === 'interview' || h.to_stage === 'offer') && !seenAdvance.has(h.application_id)) {
      seenAdvance.add(h.application_id);
      if (t >= weekStartMs) advanced.add(h.application_id);
    }
    if (h.to_stage === 'rejected' && t >= weekStartMs) rejected++;
  }
  const applied = [...firstSend.values()].filter(t => t >= weekStartMs).length;
  return { applied, advanced: advanced.size, rejected, silent, interviews };
}

/**
 * 他自己的基数（全部历史，不按周）：「投出多少份才第一次进面试」比任何行业区间都真，低谷时拿它说话。
 * 数据不够时不编，只说还没有。
 */
export function ownBaseline(overall: FunnelRow | null, rhythm: MonthBoard['rhythm']): string {
  const parts = [`累计投出 ${overall?.applied ?? 0} 份，走到面试 ${overall?.interview ?? 0} 份`];
  parts.push(rhythm.first_interview_after ? `第一次进面试前投出了 ${rhythm.first_interview_after} 份` : '还没有进过面试，没有自己的「几份换一个面试」可比');
  if (rhythm.reply_days !== null) parts.push(`投出到第一次有进展的中位数 ${rhythm.reply_days} 天`);
  return `他自己的基数（全部历史）：${parts.join('；')}`;
}

/** 判出低落时只收紧输出（2026-10-30 定，低谷面）：建议只留优先级最高的 1 条，加一个小动作；不改别的。 */
export const LOW_MOOD_MAX_SUGGESTIONS = 1;
export function shapeForMood(output: WeeklyReviewOutput): WeeklyReviewOutput {
  if (output.tone_flag !== 'low_mood' || !output.suggestions) return output;
  const top = [...output.suggestions].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).slice(0, LOW_MOOD_MAX_SUGGESTIONS);
  return { ...output, suggestions: top };
}

/** 没有对应信号的「换方向 / 补短板」建议不给（模型可能自己起意）。 */
export function keepSignaledChanges(output: WeeklyReviewOutput, signals: ChangeSignal[]): WeeklyReviewOutput {
  if (!output.suggestions) return output;
  const allowed = new Set(signals.map(s => s.tool));
  return { ...output, suggestions: output.suggestions.filter(x => !x.tool || allowed.has(x.tool)) };
}

export async function generateWeeklyReview(deps: IntakeDeps, opts: { week_start?: string; user_note?: string } = {}): Promise<{ review: WeeklyReview; output: WeeklyReviewOutput; funnel: ReturnType<IntakeDeps['repos']['funnel']> }> {
  const r = deps.repos;
  const nowIso = deps.now?.() ?? new Date().toISOString();
  const weekStart = opts.week_start ?? deps.core.weekStartOf(nowIso);
  const funnel = r.funnel(nowIso);
  const weekMs = Date.parse(weekStart + 'T00:00:00Z');
  const interviews = r.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM interview WHERE created_at >= ?', [weekStart])[0]?.n ?? 0;
  const facts = weekFacts(r.stageHistory(), weekMs, deps.core.isSendNote, funnel.overall?.silent ?? 0, interviews);
  const signals = changeSignals({ apps: r.applicationsWithJob(), history: r.stageHistory(), deadlines: r.listDeadlines(), nowIso });
  const previous = r.listWeeklyReviews(1)[0];
  let output: WeeklyReviewOutput = {};
  if (deps.llm) {
    const system = await loadSkillPrompt('weekly-review');
    const user = [
      `周起点：${weekStart}，今天：${nowIso.slice(0, 10)}`,
      `本周投出：${facts.applied}；本周拒信：${facts.rejected}；本周新进面试或 Offer：${facts.advanced}；本周新增面试记录：${interviews}；此刻静默：${facts.silent}`,
      `累计漏斗（整体）：${JSON.stringify(funnel.overall)}`,
      ownBaseline(funnel.overall, r.monthBoard({ nowIso }).rhythm),
      `按岗位类别：${JSON.stringify(funnel.by_category)}`,
      `按平台：${JSON.stringify(funnel.by_platform)}`,
      `换方向 / 补短板信号：${signals.length ? signals.map(x => `${x.text}（可建议 ${x.tool}）`).join('；') : '无——这次不提换方向或补短板'}`,
      previous ? `上次复盘建议：${previous.suggestions_json}` : '上次复盘：无',
      opts.user_note ? `用户补充：${opts.user_note}` : '',
      `用户偏好：${JSON.stringify(r.kvGet('preferences') ?? {})}`,
    ].filter(Boolean).join('\n');
    const res = await deps.llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0.3 });
    output = deps.core.extractJson<WeeklyReviewOutput>(res.text);
  }
  // 事实一栏永远是我们数出来的那份：模型报的数可能把累计当本周，比例必须真实
  output = shapeForMood(keepSignaledChanges({ ...output, facts: { ...facts } }, signals));
  const review = r.saveWeeklyReview({ week_start: weekStart, funnel: { ...funnel, this_week: facts }, insights: output.insights ?? [], suggestions: output.suggestions ?? [], small_action: output.small_action ?? null });
  dataChanged(deps, ['weekly_review']);
  focus(deps, { surface: 'review', id: review.id });
  return { review, output, funnel };
}
