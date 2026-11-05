/**
 * 现场窗里点「交还」时交还哪几家（2026-11-03 用户：「哪家要你接手，就在那家接手，而不是一批下来全有问题」）：
 * 只交还他眼前这一家——登录之旅钉住的那家，或现场窗正看着的那家。原来没钉住时把所有等你处理的网申一起关掉，
 * 后台把整批重跑一遍，没处理的几家又一起撞回来。
 */
import type { Handoff, Repos } from '@career/core';

export interface HandbackTarget { pinnedHandoffId?: string | null; appKey?: string | null }

/** 等你处理、且交还后能从原页接着填的接管（填表动作的；别的动作有自己的收尾）。 */
function resumable(repos: Repos, h: Handoff): boolean {
  const action = h.action_id ? repos.getAction(h.action_id) : undefined;
  return !action || action.kind === 'fill_form';
}

export function appKeyOfHandoff(repos: Repos, h: Handoff): string | null {
  const action = h.action_id ? repos.getAction(h.action_id) : undefined;
  return action ? (action.application_id ?? action.id) : null;
}

export function handoffsToHandBack(repos: Repos, target: HandbackTarget): Handoff[] {
  const open = repos.openHandoffs().filter(h => resumable(repos, h));
  if (target.pinnedHandoffId) return open.filter(h => h.id === target.pinnedHandoffId);
  if (target.appKey) return open.filter(h => appKeyOfHandoff(repos, h) === target.appKey);
  // 看不出他在看哪一家：只有一家在等时就是它；好几家在等就一家都不动，免得把没处理的也当成处理完
  return open.length === 1 ? open : [];
}

/** 每一家有没有在等他、等什么（现场窗顶上的公司小签用）。 */
export function waitingByApp(repos: Repos): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of repos.openHandoffs()) {
    const key = appKeyOfHandoff(repos, h);
    if (key && !out.has(key)) out.set(key, h.reason);
  }
  return out;
}

/**
 * 他接手的这一家已经填好、在等投前过目：他在页面上动过（补了格子、点到了「确认提交」页），交还后要重新看一遍这一页，
 * 不能还挂着交还前那句「已填完，停在预览并提交前」（2026-11-05 滴滴）。
 * 做法：作废那张旧的投前过目，把这一家最近填完的填表以「接管后续跑」放回（开一个立刻交回的接管），
 * 批量运行器从当前页接着看——他改过的值记进答案库，到了确认页就重新出一张停在「确认提交」前的过目。
 * 返回放回续跑的填表动作 id；这一家没有在等过目的提交就返回 null。
 */
export function recheckAfterHandback(repos: Repos, appKey: string): string | null {
  const submit = repos.listActions('pending_review').find(a => a.kind === 'submit' && a.application_id === appKey);
  if (!submit) return null;
  const fill = repos.db.get<{ id: string }>(`SELECT id FROM action_queue WHERE kind='fill_form' AND application_id=? AND status='done' ORDER BY updated_at DESC LIMIT 1`, [appKey]);
  if (!fill) return null;
  repos.setActionStatus(submit.id, 'rejected', { status: 'superseded', message: '你接手改过页面，交还后重新检查' });
  repos.setActionStatus(fill.id, 'needs_user');
  const h = repos.openHandoff('user_request', { actionId: fill.id, message: '你接手改过页面' });
  repos.closeHandoff(h.id, 'live_handback_recheck');
  return fill.id;
}
