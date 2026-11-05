/**
 * 填好的网申页面没了（浏览器关过 / 重启过 / 页面被关）：把这一家最近一次填完的填表放回 approved 重新填，
 * 作废它那张提交（投前过目），填好后自然再出一张新的。提交执行器（提交时页面没了）和「去看」（点去看时页面没了）共用。
 *
 * 2026-11-05：「2 家填好了 · 去看」点了没反应——页面已经关了，服务端回 404，前端只记了一行日志。
 */
import type { Repos } from '@career/core';

export interface RefillResult {
  /** 放回重填的填表动作。 */
  fillActionId: string;
  /** 作废的那几张提交。 */
  submitActionIds: string[];
}

/** 这一家还在等投前过目 / 正在执行的提交。 */
function openSubmitsOf(r: Repos, applicationId: string): string[] {
  return ['pending_review', 'approved', 'executing', 'needs_user']
    .flatMap(status => r.listActions(status))
    .filter(a => a.kind === 'submit' && a.application_id === applicationId)
    .map(a => a.id);
}

/** 没有填完过的填表（还没填好、本来就没有页面可看）返回 null，调用方照实说。 */
export function refillLostPage(r: Repos, applicationId: string, why: string): RefillResult | null {
  const fillActionId = r.refillAfterPageLoss(applicationId);
  if (!fillActionId) return null;
  const submitActionIds = openSubmitsOf(r, applicationId);
  for (const id of submitActionIds) {
    r.setActionStatus(id, 'failed', { status: 'page_gone', message: `${why}，已重排重新填写` });
    for (const h of r.openHandoffs()) {
      if (h.action_id !== id) continue;
      try { r.closeHandoff(h.id, 'page_gone_refill'); } catch (e) { console.warn(`[career] refill close handoff FAILED ${h.id}`, e instanceof Error ? e.message : e); }
    }
  }
  try { r.jumpTo(applicationId, 'approved', `${why}，重新填写后再提交`); } catch (e) { console.warn(`[career] refill jumpTo skipped app=${applicationId}`, e instanceof Error ? e.message : e); }
  try { r.addDossierNote({ application_id: applicationId, kind: 'note', content: `${why}：网申将重新填写，填好后会再出一张提交卡` }); } catch (e) { console.warn(`[career] refill note FAILED app=${applicationId}`, e instanceof Error ? e.message : e); }
  return { fillActionId, submitActionIds };
}
