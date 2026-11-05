/**
 * 投递切面的读接口（挂在 `/api/career/*` 下，由 career.ts 的路由表展开）：
 * - GET /api/career/asks?since=ISO：等你条——要你的事（服务端合并、排序）+ 今天这批的进度（since = 客户端本地零点）；
 * - GET /api/career/run?action_ids=a,b：一张批次卡的海报墙（这句话开的那几份）；
 * - GET /api/career/away?since=ISO：回来卡（since = 上次离开的时间）。
 * - POST /api/career/asks/:id/login-journey：「N 个网站要你登录」——一家一家带你登录（career/login-journey.ts）；{ cancel: true } 停下；{ skip: true } 这家先跳过。
 * - POST /api/career/asks/:id/fill：缺信息填一次，存进私密库 / 答案库后整批交给后台接着填（career/ask-fill.ts）。
 * - POST /api/career/asks/:id/retry：「N 家没填成」再试一次——整件放回队列，后台只填这几份（career/fill-failures.ts）。
 * - POST /api/career/asks/:id/self：「N 家没填成」我自己来——开接管、现场画面切到那一家；{ application_id } 只接这一家。
 * 时区由客户端给，服务端不猜。其余要你的事走各源已有的接口（截止、审批、接管）。
 */
import type { Repos, Vault } from '@career/core';

import { AskFillError, chooseAsk, fillAsk } from '../career/ask-fill';
import { FailedAskError, retryFailedAsk, takeOverFailedAsk } from '../career/fill-failures';
import { cancelJourney, skipJourneyStep } from '../career/login-journey';
import { asksFor, buildAway, buildRun } from '../career/delivery';

import { fail, ok, type Json } from './career-http';

export interface DeliveryRouteCtx { repos: Repos; url: URL; params: Record<string, string>; body: Json; vault: Vault; dataChanged: (tables: string[]) => void }
type Handler = (ctx: DeliveryRouteCtx) => Response | Promise<Response>;

const isoParam = (url: URL, key: string): string | null => {
  const v = url.searchParams.get(key);
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
};
/** 一张批次卡最多几份：jobs_apply 一次最多 50 个岗位。 */
const MAX_RUN_IDS = 50;

/** 「没填成」那件已经不在 / 没法重跑：409 带原因，其余照常抛出。 */
function failedAskRoute(fn: () => Response): Response {
  try { return fn(); } catch (error) {
    if (error instanceof FailedAskError) return fail(error.message, 409);
    throw error;
  }
}

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
    ['POST', '/api/career/asks/:id/choose', ({ repos, params, body, dataChanged }) => {
      if (typeof body.choice !== 'string' || !body.choice.trim()) return fail('choice 必须是选项文字');
      try {
        const out = chooseAsk(repos, params.id, body.choice);
        dataChanged(['handoff', 'action_queue', 'task']);
        return ok({ resumed: out.resumed });
      } catch (error) {
        if (error instanceof AskFillError) return fail(error.message, 409);
        throw error;
      }
    }],
    ['POST', '/api/career/asks/:id/login-journey', async ({ repos, params, body, dataChanged }) => {
      if (body.cancel === true) { cancelJourney(); return ok({ cancelled: true }); }
      if (body.skip === true) { skipJourneyStep(); return ok({ skipped: true }); }
      const ask = asksFor(repos).find(a => a.id === params.id && a.kind === 'login');
      if (!ask) return fail(`这件事已经不在了：${params.id}`, 409);
      try {
        // 动态加载：只有 Global 侧车有浏览器宿主
        const { beginLoginJourney } = await import('../career/login-journey-host');
        const handoffs = ask.sources.filter(x => x.type === 'handoff').map(x => x.id);
        // 他点了其中一家：只登这一家，不拉着整串走
        const one = typeof body.handoff_id === 'string' && handoffs.includes(body.handoff_id) ? [body.handoff_id] : null;
        const started = await beginLoginJourney(repos, ask.id, one ?? handoffs, dataChanged);
        return ok({ started });
      } catch (error) {
        console.error(`[career] login-journey start FAILED ${params.id}`, error instanceof Error ? error.message : error);
        return fail(error instanceof Error ? error.message : '浏览器还没就绪', 503);
      }
    }],
    ['POST', '/api/career/asks/:id/retry', ({ repos, params, dataChanged }) => failedAskRoute(() => {
      const retried = retryFailedAsk(repos, params.id);
      dataChanged(['action_queue', 'application']);
      return ok({ retried });
    })],
    ['POST', '/api/career/asks/:id/self', ({ repos, params, body, dataChanged }) => failedAskRoute(() => {
      const apps = takeOverFailedAsk(repos, params.id, typeof body.application_id === 'string' ? body.application_id : undefined);
      dataChanged(['handoff', 'action_queue', 'application', 'task']);
      return ok({ application_ids: apps });
    })],
    ['GET', '/api/career/away', ({ repos, url }) => {
      const since = isoParam(url, 'since');
      if (!since) return fail('需要 since（ISO 时间）');
      return ok({ away: buildAway(repos, since) });
    }],
  ];
}
