/**
 * 服务端（共享岗位库 + 答案改动回传）的客户端。接口契约见 docs/SERVER-API.md；服务端由后端团队用 PostgreSQL 实现。
 *
 * 地址：kv `career:server`（{ base_url, token? }，设置里填）优先，环境变量 `CAREER_API_BASE_URL` / `CAREER_API_TOKEN` 兜底。
 * 没配置时一切照旧走本地（岗位来源只用本地 / 校招静态数据，答案改动在本地累积，配置后再补传）。
 */
import type { JobListing, JobPage, JobQuery, JobSource, Repos, AnswerEventRow } from '@career/core';

export const SERVER_CONFIG_KEY = 'career:server';
export interface ServerConfig { base_url: string; token?: string }

export function serverConfig(repos: Repos, env: NodeJS.ProcessEnv = process.env): ServerConfig | null {
  const saved = repos.kvGet<ServerConfig>(SERVER_CONFIG_KEY);
  const base = saved?.base_url?.trim() || env.CAREER_API_BASE_URL?.trim();
  if (!base) return null;
  return { base_url: base.replace(/\/+$/, ''), token: saved?.token?.trim() || env.CAREER_API_TOKEN?.trim() || undefined };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function call<T>(cfg: ServerConfig, path: string, init: RequestInit = {}, fetchImpl: FetchLike = fetch): Promise<T> {
  const res = await fetchImpl(`${cfg.base_url}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}), ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`服务端 ${path} 返回 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
  return await res.json() as T;
}

/** 服务端共享岗位库：GET /v1/jobs。 */
export class RemoteJobSource implements JobSource {
  readonly id = 'server';
  constructor(private readonly cfg: ServerConfig, private readonly fetchImpl: FetchLike = fetch) {}
  async search(q: JobQuery): Promise<JobPage> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    const page = await call<JobPage>(this.cfg, `/v1/jobs?${params}`, {}, this.fetchImpl);
    return { items: Array.isArray(page.items) ? page.items : [], next_cursor: page.next_cursor ?? null };
  }
}

/** 答案改动回传：POST /v1/answer-events（批量，幂等：按事件 id 去重）。 */
export async function uploadAnswerEvents(repos: Repos, cfg: ServerConfig, fetchImpl: FetchLike = fetch, batch = 200): Promise<{ uploaded: number; error?: string }> {
  const events = repos.pendingAnswerEvents(batch);
  if (!events.length) return { uploaded: 0 };
  const body = { events: events.map(toWire) };
  try {
    await call(cfg, '/v1/answer-events', { method: 'POST', body: JSON.stringify(body) }, fetchImpl);
    repos.markAnswerEventsUploaded(events.map(e => e.id));
    return { uploaded: events.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    repos.markAnswerEventsUploaded(events.map(e => e.id), msg);
    return { uploaded: 0, error: msg };
  }
}

/** 上行字段：excluded 类从不入队；personal / self_id 入队时已去掉值（Repos.recordAnswerEvent）。不带 application_id（本地 id 对服务端无意义）。 */
function toWire(e: AnswerEventRow) {
  return { id: e.id, kind: e.kind, question_key: e.question_key, question_text: e.question_text, answer: e.answer, previous_value: e.previous_value, source: e.source, sensitivity: e.sensitivity, job_key: e.job_key, site_host: e.site_host, created_at: e.created_at };
}

/** 把一页岗位写进本地库（按 job_key upsert；服务端下架 / 合并的保留但标记）。 */
export function upsertListings(repos: Repos, items: JobListing[]): number {
  let n = 0;
  repos.db.transaction(() => {
    for (const it of items) {
      if (!it.title || !it.company_name) continue;
      const existing = repos.getJobByKey(it.job_key);
      if (existing && it.version != null && existing.source_version != null && it.version <= existing.source_version) continue;
      repos.upsertJob({
        job_key: it.job_key, remote_id: it.remote_id ?? null, source_platform: it.source_platform, source_job_id: it.source_job_id ?? null,
        url: it.url ?? null, company_name: it.company_name, title: it.title, location: it.location ?? null, salary: it.salary ?? null,
        jd_raw: it.jd_raw ?? null, deadline: it.deadline ?? null, deadline_verified_at: it.deadline_verified_at ?? null,
        employment_type: it.employment_type ?? 'unknown', cohort: it.cohort ?? null, source_version: it.version ?? null, source_status: it.status ?? 'open',
      });
      n++;
    }
  });
  return n;
}

/** 从一个来源拉取（翻页）并写入本地；返回写入条数。 */
export async function syncJobSource(repos: Repos, source: JobSource, query: JobQuery = {}, maxPages = 20): Promise<{ fetched: number; stored: number }> {
  let cursor: string | null | undefined = query.cursor;
  let fetched = 0; let stored = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await source.search({ ...query, cursor: cursor ?? undefined });
    fetched += page.items.length;
    stored += upsertListings(repos, page.items);
    cursor = page.next_cursor;
    if (!cursor || !page.items.length) break;
  }
  return { fetched, stored };
}
