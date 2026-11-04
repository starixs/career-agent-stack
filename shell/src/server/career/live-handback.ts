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
