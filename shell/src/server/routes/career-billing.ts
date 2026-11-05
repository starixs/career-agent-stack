/**
 * 路由 `/api/career/billing/*`：积分余额、用量、流水、计费清单、签到。
 * 由 handleCareerRoute 转进来，响应格式与 /api/career/* 一致：`{ ok: true, ... }` / `{ ok: false, error }`。
 *
 *   GET  summary        余额 + 最近 30 天用量分组 + 每日用量 + 最近流水
 *   GET  transactions   流水分页（?limit=&offset=）
 *   GET  price-list     计费清单（模型 / 工具 / 语音单价、套餐、充值包）
 *   POST checkin        每日签到
 */
import type { Repos } from '@career/core';

import { loadCore } from '../career/core-module';
import { getRepos } from '../career/db';
import { fail, ok } from './career-http';

export const BILLING_PREFIX = '/api/career/billing/';

/** 流水分页上限：界面一页 20 条，留余量给导出。 */
const MAX_TXN_PAGE = 200;

export interface BillingRouteDeps { repos?: Repos }

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

export async function handleBillingRoute(pathname: string, request: Request, deps: BillingRouteDeps = {}): Promise<Response | null> {
  if (!pathname.startsWith(BILLING_PREFIX)) return null;
  const action = pathname.slice(BILLING_PREFIX.length);
  const method = request.method.toUpperCase();
  try {
    const core = await loadCore();
    if (method === 'GET' && action === 'price-list') return ok({ priceList: core.buildPriceList() });
    const db = (deps.repos ?? await getRepos()).db;
    if (method === 'GET' && action === 'summary') return ok({ summary: core.billingSummary(db) });
    if (method === 'GET' && action === 'transactions') {
      const url = new URL(request.url);
      return ok({ transactions: core.listTransactions(db, { limit: intParam(url, 'limit', 20, MAX_TXN_PAGE), offset: intParam(url, 'offset', 0, Number.MAX_SAFE_INTEGER) }) });
    }
    if (method === 'POST' && action === 'checkin') return ok({ checkin: core.checkin(db) });
    return fail(`没有这个计费接口：${method} ${action}`, 404);
  } catch (error) {
    console.error(`[billing] route failed ${method} ${action}:`, error);
    return fail(`计费数据读取失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}
