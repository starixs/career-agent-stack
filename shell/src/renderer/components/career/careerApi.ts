/**
 * Global 路由 `/api/career/*` 的前端封装（见 docs/API.md）。
 * 响应统一 `{ ok: true, ...data }`；列表字段名由后端决定，这里做宽容解包。
 */
import { apiDelete, apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';

import type {
  ActionQueueItem, Application, Board, Company, Direction, ExperienceNode, GapPlan, Interview, Job,
  MockInterview, Offer, ProbePrediction, ResumeMaster, ResumeTailored,
  VaultAccessLogRow, VaultItemMeta, VaultOverview, VaultScope,
  BatchState, LiveSnapshot,
} from './types';

type Dict = Record<string, unknown>;

function asDict(res: unknown): Dict {
  return res && typeof res === 'object' ? (res as Dict) : {};
}

/** 从响应里取列表：响应本身是数组 → 直接用；否则按 keys 顺序找数组字段；最后退到第一个数组值。 */
export function pickList<T>(res: unknown, ...keys: string[]): T[] {
  if (Array.isArray(res)) return res as T[];
  const dict = asDict(res);
  for (const key of keys) {
    const v = dict[key];
    if (Array.isArray(v)) return v as T[];
  }
  for (const [key, v] of Object.entries(dict)) {
    if (key !== 'ok' && Array.isArray(v)) return v as T[];
  }
  return [];
}

/** 从响应里取对象：按 keys 顺序找对象字段；没有则去掉 ok 后把整个响应当对象。 */
export function pickObject<T>(res: unknown, ...keys: string[]): T {
  const dict = asDict(res);
  for (const key of keys) {
    const v = dict[key];
    if (v && typeof v === 'object') return v as T;
  }
  const { ok: _ok, ...rest } = dict;
  return rest as T;
}

export function careerPath(p: string): string {
  return `/api/career${p}`;
}

export const careerApi = {
  // ----- 经历库 -----
  experiences: () => apiGetJson<unknown>(careerPath('/experiences')).then(r => pickList<ExperienceNode>(r, 'experiences', 'tree', 'items')),
  addExperience: (body: Partial<ExperienceNode>) => apiPostJson<unknown>(careerPath('/experiences'), body).then(r => pickObject<ExperienceNode>(r, 'experience')),
  confirmClaim: (id: string) => apiPostJson<unknown>(careerPath(`/claims/${encodeURIComponent(id)}/confirm`), {}),

  // ----- 简历 -----
  resumes: () => apiGetJson<unknown>(careerPath('/resumes')).then(r => {
    const d = asDict(r);
    return { masters: pickList<ResumeMaster>(d.masters), tailored: pickList<ResumeTailored>(d.tailored) };
  }),
  saveResume: (id: string, schema_json: string) => apiPutJson<unknown>(careerPath(`/resumes/${encodeURIComponent(id)}`), { schema_json }),
  exportResume: (id: string, format: 'pdf' | 'docx' | 'png') =>
    apiPostJson<unknown>(careerPath(`/resumes/${encodeURIComponent(id)}/export`), { format }).then(r => pickObject<{ path?: string }>(r, 'result')),
  resumeFilePath: (id: string, format: 'pdf' | 'png' = 'pdf') => careerPath(`/resumes/${encodeURIComponent(id)}/file?format=${format}`),

  // ----- 岗位与投递 -----
  jobs: () => apiGetJson<unknown>(careerPath('/jobs')).then(r => pickList<Job>(r, 'jobs', 'items')),
  importJob: (body: { url?: string; jd_raw?: string; title?: string; company_name?: string; source_platform?: string }) =>
    apiPostJson<unknown>(careerPath('/jobs/import'), body).then(r => pickObject<Job>(r, 'job')),
  applications: () => apiGetJson<unknown>(careerPath('/applications')).then(r => pickList<Application>(r, 'applications', 'items')),
  board: () => apiGetJson<unknown>(careerPath('/board')).then(r => {
    const d = asDict(r);
    const b = asDict(d.board && typeof d.board === 'object' ? d.board : d);
    return {
      due: pickList<Board['due'][number]>(b.due),
      blocked: pickList<Board['blocked'][number]>(b.blocked),
      funnel: pickList<Board['funnel'][number]>(b.funnel),
      pendingReview: typeof b.pendingReview === 'number' ? b.pendingReview : 0,
    } satisfies Board;
  }),
  setStage: (id: string, to: string, note?: string) =>
    apiPostJson<unknown>(careerPath(`/applications/${encodeURIComponent(id)}/stage`), { to, note }).then(r => pickObject<Application>(r, 'application')),
  pendingActions: () => apiGetJson<unknown>(careerPath('/actions?status=pending_review')).then(r => pickList<ActionQueueItem>(r, 'actions', 'items')),
  reviewActions: (ids: string[], decision: 'approved' | 'rejected') =>
    apiPostJson<unknown>(careerPath('/actions/review'), { ids, decision }).then(r => pickObject<{ n?: number }>(r)),
  browserControl: (control: 'agent' | 'human', reason?: string) =>
    apiPostJson<unknown>(careerPath('/browser/control'), { control, reason }).then(r => pickObject<{ control?: string }>(r)),
  browserState: () => apiGetJson<unknown>(careerPath('/browser/state')).then(r => pickObject<{ control?: string; url?: string; title?: string }>(r, 'state')),

  // ----- 调研 -----
  companies: () => apiGetJson<unknown>(careerPath('/companies')).then(r => pickList<Company>(r, 'companies', 'items')),
  directions: () => apiGetJson<unknown>(careerPath('/directions')).then(r => pickList<Direction>(r, 'directions', 'items')),
  setDirectionStatus: (id: string, status: Direction['status']) =>
    apiPostJson<unknown>(careerPath(`/directions/${encodeURIComponent(id)}/status`), { status }).then(r => pickObject<Direction>(r, 'direction')),
  gapPlans: () => apiGetJson<unknown>(careerPath('/gap-plans')).then(r => pickList<GapPlan>(r, 'gapPlans', 'gap_plans', 'plans', 'items')),

  // ----- 面试 -----
  interviews: () => apiGetJson<unknown>(careerPath('/interviews')).then(r => pickList<Interview>(r, 'interviews', 'items')),
  createInterview: (body: Partial<Interview>) => apiPostJson<unknown>(careerPath('/interviews'), body).then(r => pickObject<Interview>(r, 'interview')),
  updateInterview: (id: string, body: Partial<Interview>) =>
    apiPutJson<unknown>(careerPath(`/interviews/${encodeURIComponent(id)}`), body).then(r => pickObject<Interview>(r, 'interview')),
  mockInterviews: () => apiGetJson<unknown>(careerPath('/mock-interviews')).then(r => pickList<MockInterview>(r, 'mockInterviews', 'mock_interviews', 'items')),
  /** API.md 未列出该路由；后端若未实现则按空列表处理。 */
  probePredictions: () => apiGetJson<unknown>(careerPath('/probe-predictions'))
    .then(r => pickList<ProbePrediction>(r, 'predictions', 'probePredictions', 'items'))
    .catch(() => [] as ProbePrediction[]),

  // ----- Offer -----
  offers: () => apiGetJson<unknown>(careerPath('/offers')).then(r => pickList<Offer>(r, 'offers', 'items')),
  createOffer: (body: Partial<Offer>) => apiPostJson<unknown>(careerPath('/offers'), body).then(r => pickObject<Offer>(r, 'offer')),
  updateOffer: (id: string, body: Partial<Offer>) =>
    apiPutJson<unknown>(careerPath(`/offers/${encodeURIComponent(id)}`), body).then(r => pickObject<Offer>(r, 'offer')),

  // ----- 私密信息库（明文只在这组接口与用户之间流转，不经过模型） -----
  vault: () => apiGetJson<unknown>(careerPath('/vault')).then(r => {
    const d = asDict(r);
    const empty: VaultOverview['status'] = { profile: { filled: [], missing: [] }, sites: [], experiences: [] };
    return {
      status: d.status && typeof d.status === 'object' ? (d.status as VaultOverview['status']) : empty,
      items: pickList<VaultItemMeta>(d.items),
      profileFields: pickList<VaultOverview['profileFields'][number]>(d.profileFields),
      siteFields: pickList<string>(d.siteFields),
    } satisfies VaultOverview;
  }),
  vaultSet: (body: { scope: VaultScope; ref_id?: string; field: string; value: string; label?: string | null; sensitive?: boolean; policy?: { autofill?: boolean } }) =>
    apiPutJson<unknown>(careerPath('/vault/items'), body).then(r => pickObject<{ item: VaultItemMeta | null; deleted?: boolean }>(r)),
  vaultSetPolicy: (id: string, policy: { autofill?: boolean }) =>
    apiPostJson<unknown>(careerPath(`/vault/items/${encodeURIComponent(id)}/policy`), { policy }).then(r => pickObject<VaultItemMeta>(r, 'item')),
  vaultDelete: (id: string) => apiDelete<unknown>(careerPath(`/vault/items/${encodeURIComponent(id)}`)),
  vaultDeleteSite: (host: string) => apiDelete<unknown>(careerPath(`/vault/sites/${encodeURIComponent(host)}`)),
  /** 回显明文供用户查看 / 编辑；后端记访问日志。 */
  vaultReveal: (id: string) => apiPostJson<unknown>(careerPath(`/vault/items/${encodeURIComponent(id)}/reveal`), {}).then(r => String(asDict(r).value ?? '')),
  vaultAccessLog: () => apiGetJson<unknown>(careerPath('/vault/access-log?limit=50')).then(r => pickList<VaultAccessLogRow>(r, 'log')),

  // ----- 浏览器现场 / 批量投递（免令牌的 Global 路由；长连接流在 useGlobalLive 里走原生 fetch） -----
  liveState: () => apiGetJson<unknown>(careerPath('/live/state')).then(r => { const { ok: _ok, ...rest } = asDict(r); return rest as unknown as LiveSnapshot; }),
  liveControl: (control: 'human' | 'agent', reason?: string) => apiPostJson<unknown>(careerPath('/live/control'), { control, reason }).then(r => pickObject<{ control?: { control: string } }>(r)),
  batchCommand: (cmd: 'start' | 'pause' | 'stop') => apiPostJson<unknown>(careerPath('/batch/command'), { cmd }).then(r => asDict(r).batch as BatchState | undefined),
  batchState: () => apiGetJson<unknown>(careerPath('/batch/state')).then(r => (asDict(r).batch ?? null) as BatchState | null),
};

/** 安全解析 JSON 字段；失败返回 fallback。 */
export function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}
