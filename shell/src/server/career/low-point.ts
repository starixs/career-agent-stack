/**
 * 低谷开场（2026-10-30 定，低谷面）：连收拒信时不推送；他下一次在对话里说话时，助理开头只说一句，带他自己的基数。
 * 不展开复盘、不提换方向——那些等他自己问。
 */
import type { Repos } from '@career/core';

/** 这么多天内收到这么多封拒信，算「连收拒信」 */
export const LOW_POINT_WINDOW_DAYS = 7;
export const LOW_POINT_MIN_REJECTIONS = 5;
/** 上次开场的时间（kv）；窗口内只说一次 */
export const LOW_POINT_KV = 'low_point_opener_at';
const DAY_MS = 86_400_000;

/** 该开场就返回那一句；不该就 null。只读，不记 kv。 */
export function lowPointLine(repos: Repos, nowIso: string): string | null {
  const since = Date.parse(nowIso) - LOW_POINT_WINDOW_DAYS * DAY_MS;
  const rejections = repos.stageHistory().filter(h => h.to_stage === 'rejected' && Date.parse(h.created_at) >= since).length;
  if (rejections < LOW_POINT_MIN_REJECTIONS) return null;
  const lastReview = repos.listWeeklyReviews(1)[0];
  if (lastReview && Date.parse(lastReview.created_at) >= since) return null;
  const said = repos.kvGet<string>(LOW_POINT_KV);
  if (said && Date.parse(said) >= since) return null;
  const overall = repos.funnel(nowIso).overall;
  const before = repos.monthBoard({ nowIso }).rhythm.first_interview_after;
  const base = before
    ? `你之前投出 ${before} 份才第一次进面试，现在一共 ${overall?.interview ?? 0} 个面试。`
    : `累计投出 ${overall?.applied ?? 0} 份，还没进过面试，现在的数据还不够下结论。`;
  return `这 ${LOW_POINT_WINDOW_DAYS} 天收到 ${rejections} 封拒信。${base}`;
}

/** 给模型的本轮附加上下文；返回前记下已经说过。 */
export function lowPointOpener(repos: Repos, nowIso: string): string | null {
  const line = lowPointLine(repos, nowIso);
  if (!line) return null;
  repos.kvSet(LOW_POINT_KV, nowIso);
  return [
    '〔低谷开场〕在这次回复的最开头先说这一句（口吻可以自然些，数字一个都不能改）：',
    `「${line}」`,
    '然后照常回应用户这条消息。不展开复盘、不提换方向或补短板、不加安慰话；用户想复盘时再调 weekly_review。',
  ].join('\n');
}
