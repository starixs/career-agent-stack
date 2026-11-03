/**
 * 站点做法（思路来自 GenericAgent 的「执行路径固化为 Skill / SOP」，MIT，Copyright (c) 2025 lsdefine）：
 * 自主找路（pathfinder.ts）在某个网站走到网申表 / 登录页之后，把走通的那几步记下来；
 * 下次在同一个网站找路，先把这份做法放进提示照着走，对不上再自己找——同一类站越投越快，不靠人手补引擎。
 *
 * 按网站（siteOf，如 zhiye.com、feishu.cn）记，不按公司：同一套招聘系统的结构是一样的。
 */
import type { Repos } from '@career/core';

import type { PathfinderStep } from './pathfinder';

export interface SiteSop { site: string; steps: PathfinderStep[]; reached: 'form' | 'login'; updated_at: string; successes: number }

/** 一份做法最多记几步：再长说明这条路本身不稳，记了反而误导。 */
const MAX_SOP_STEPS = 10;
const keyOf = (site: string) => `apply:site_sop:${site}`;

/** 网址里的路径对不同公司不通用（租户号、岗位号），只留「去哪一类页」的样子。 */
function genericUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^[^.]+\.(?=[^.]+\.[^.]+\.)/, '*.')}${u.pathname.replace(/\/\d{3,}/g, '/<id>').replace(/\/[0-9a-f-]{16,}/gi, '/<id>')}`;
  } catch (error) {
    console.warn('[career] site-sop: 网址解析失败，按原样记', error instanceof Error ? error.message : error);
    return url;
  }
}

export function readSiteSop(repos: Repos, site: string | null): SiteSop | null {
  return site ? repos.kvGet<SiteSop>(keyOf(site)) ?? null : null;
}

/** 走通了（到了网申表或登录页）就记下；没走通不记，免得把错路教给下一次。 */
export function rememberSiteSop(repos: Repos, site: string | null, steps: readonly PathfinderStep[], reached: 'form' | 'login', now = new Date()): SiteSop | null {
  if (!site || !steps.length) return null;
  const prev = readSiteSop(repos, site);
  const sop: SiteSop = { site, steps: steps.slice(-MAX_SOP_STEPS).map(s => ({ ...s, url: genericUrl(s.url) })), reached, updated_at: now.toISOString(), successes: (prev?.successes ?? 0) + 1 };
  repos.kvSet(keyOf(site), sop);
  console.log(`[career] site-sop remembered site=${site} steps=${sop.steps.length} reached=${reached}`);
  return sop;
}

/** 放进找路提示的样子。 */
export function sopText(sop: SiteSop | null): string {
  if (!sop) return '';
  const lines = sop.steps.map((s, i) => `${i + 1}. ${s.action}「${s.target}」（之后在 ${s.url}）`);
  return `${lines.join('\n')}\n→ 走到${sop.reached === 'form' ? '网申表' : '登录页'}（成功过 ${sop.successes} 次）`;
}
