/**
 * 投递切面的读接口（挂在 `/api/career/*` 下，由 career.ts 的路由表展开）：
 * - GET /api/career/asks?since=ISO：等你条——要你的事（服务端合并、排序）+ 今天这批的进度（since = 客户端本地零点）；
 * - GET /api/career/run?action_ids=a,b：一张批次卡的海报墙（这句话开的那几份）；
 * - GET /api/career/away?since=ISO：回来卡（since = 上次离开的时间）。
 * - POST /api/career/asks/:id/fill：缺信息填一次，存进私密库 / 答案库后整批交给后台接着填（career/ask-fill.ts）。
 * 时区由客户端给，服务端不猜。其余要你的事走各源已有的接口（截止、审批、接管）。
 */
import type { Repos, Vault } from '@career/core';

import { AskFillError, fillAsk } from '../career/ask-fill';
import { asksFor, buildAway, buildRun } from '../career/delivery';

import { fail, ok, type Json } from './career-http';

export interface DeliveryRouteCtx { repos: Repos; url: URL; params: Record<string, string>; body: Json; vault: Vault; dataChanged: (tables: string[]) => void }
type Handler = (ctx: DeliveryRouteCtx) => Response;

const isoParam = (url: URL, key: string): string | null => {
  const v = url.searchParams.get(key);
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
};
/** 一张批次卡最多几份：jobs_prepare 一次最多 50 个岗位。 */
const MAX_RUN_IDS = 50;

export function deliveryRoutes(): Array<[string, string, Handler]> {
  return [
    ['GET', '/api/career/asks', ({ repos, url }) => {
      const asks = asksFor(repos);
      const since = isoParam(url, 'since');
      return ok({ asks, run: since ? buildRun(repos, { since }, asks) : null });
    }],
    ['GET', '/api/career/run', ({ repos, url }) => {
      const ids = (url.searchParams.get('action_ids') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_RUN_IDS);
      if (!ids.length) return fail('需要 action_ids');
      return ok({ run: buildRun(repos, { actionIds: ids }) });
    }],
    ['POST', '/api/career/asks/:id/fill', ({ repos, vault, params, body, dataChanged }) => {
      const raw = body.values;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('values 必须是 { 字段名: 值 }');
      const values = Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
      try {
        const out = fillAsk(repos, vault, params.id, values);
        dataChanged(['vault', 'answer_bank', 'handoff', 'action_queue', 'task']);
        return ok({ saved: out.saved, resumed: out.resumed, still_waiting: out.still_waiting });
      } catch (error) {
        if (error instanceof AskFillError) return fail(error.message, 409);
        throw error;
      }
    }],
    ['GET', '/api/career/away', ({ repos, url }) => {
      const since = isoParam(url, 'since');
      if (!since) return fail('需要 since（ISO 时间）');
      return ok({ away: buildAway(repos, since) });
    }],
  ];
}
