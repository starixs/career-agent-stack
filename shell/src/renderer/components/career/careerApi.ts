/**
 * Global 路由 `/api/career/*` 的前端封装（见 docs/API.md）。
 * 响应统一 `{ ok: true, ...data }`；列表字段名由后端决定，这里做宽容解包。
 */
import type { ResumeData as StudioResumeData } from '@career/resume-studio/schema';

import { apiDelete, apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';

import type {
  ActivityEntry,
  ExamPractice,
  CareerCard, CareerCardState, CareerSetupStatus,
  ActionQueueItem, Application, Board, Company, Deadline, Direction, Dossier, DossierNote, DossierSummary, ExperienceNode, Funnel, GapPlan,
  InboxItem, IntakeResult, Interview, Job, MailAccount, MailMessage, MailPreset, Material, MaterialUse, MockInterview, Offer, OnboardingChecklist,
  ProbePrediction, ResumeMaster, ResumeTailored, TodayQueue, WeeklyReview,
  VaultAccessLogRow, VaultItemMeta, VaultOverview, VaultScope, BatchState, LiveSnapshot,
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
  /** 简历工作台文档（resume-studio ResumeData）；preview 是占位符 → 明文，只给预览用。 */
  getStudio: (id: string) => apiGetJson<unknown>(careerPath(`/resumes/${encodeURIComponent(id)}/studio`)).then(r => {
    const d = asDict(r);
    return { data: d.data as StudioResumeData, contentUpdatedAt: String(d.content_updated_at ?? ''), preview: (d.preview as Record<string, string>) ?? {} };
  }),
  saveStudio: (id: string, data: StudioResumeData) => apiPutJson<unknown>(careerPath(`/resumes/${encodeURIComponent(id)}/studio`), { data }).then(r => {
    const d = asDict(r);
    return { contentUpdatedAt: String(d.content_updated_at ?? ''), preview: (d.preview as Record<string, string>) ?? {} };
  }),
  /** 模型 / 搜索 Key 是否已配置（只有状态，不含 Key）。 */
  setupStatus: () => apiGetJson<unknown>(careerPath('/setup')).then(r => asDict(r).setup as CareerSetupStatus),
  /** 对话内卡片（持久化）：按会话读回；完成 / 忽略 / 重新打开。 */
  listCards: (sessionId: string) => apiGetJson<unknown>(careerPath(`/cards?session_id=${encodeURIComponent(sessionId)}`)).then(r => pickList<CareerCard>(r, 'cards')),
  setCardState: (id: string, state: CareerCardState) => apiPostJson<unknown>(careerPath(`/cards/${encodeURIComponent(id)}/state`), { state }).then(r => asDict(r)),
  /** 答案库：网申里需要用户回答 / 确认过的草稿；question_key 用表单标签，下次填表按标签命中。 */
  saveAnswer: (body: { question_key: string; question_text: string; answer: string; high_impact?: boolean; confirmed?: boolean }) =>
    apiPostJson<unknown>(careerPath('/answer-bank'), body).then(r => asDict(r)),
  /** 应用定制简历提案（只取勾选的 JSON Pointer 路径；缺省全部）并确认。 */
  confirmResume: (id: string, acceptedPaths?: string[]) =>
    apiPostJson<unknown>(careerPath(`/resumes/${encodeURIComponent(id)}/confirm`), acceptedPaths ? { accepted_paths: acceptedPaths } : {}).then(r => asDict(r)),

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
  examPractices: () => apiGetJson<unknown>(careerPath('/exam-practices')).then(r => pickList<ExamPractice>(r, 'examPractices')),
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
  /** 接管期间把现场窗里的鼠标 / 键盘转发到托管 Chrome；坐标按帧尺寸给。 */
  liveInput: (input: { type: 'click' | 'move' | 'wheel' | 'type' | 'press'; x?: number; y?: number; dx?: number; dy?: number; text?: string; key?: string; double?: boolean; frame?: { width: number; height: number } }) =>
    apiPostJson<unknown>(careerPath('/live/input'), input).then(r => asDict(r)),
  /** 临时放出 / 收回真实 Chrome 窗口（默认浏览器只在产品画面里出现）。 */
  liveWindow: (visible: boolean) => apiPostJson<unknown>(careerPath('/live/window'), { visible }).then(r => asDict(r).revealed === true),
  /** 把产品里选好的文件交给页面被拦截的选文件框；data 为 base64。 */
  liveFile: (id: string, files: Array<{ name: string; mimeType?: string; data: string }>) =>
    apiPostJson<unknown>(careerPath('/live/file'), { id, files }).then(r => asDict(r)),
  liveFileCancel: (id: string) => apiPostJson<unknown>(careerPath('/live/file'), { id, cancel: true }).then(r => asDict(r).cancelled === true),
  // ----- 今日 / 引导 -----
  today: () => apiGetJson<unknown>(careerPath('/today')).then(r => {
    const d = asDict(r);
    return { items: pickList<TodayQueue['items'][number]>(d.items), waiting: (d.waiting as TodayQueue['waiting']) ?? { count: 0, by_stage: [] }, inbox_new: typeof d.inbox_new === 'number' ? d.inbox_new : 0, pending_review: typeof d.pending_review === 'number' ? d.pending_review : 0 } satisfies TodayQueue;
  }),
  /** 「今天做过」：从 since（本地零点）起的活动，新的在前。 */
  activity: (since: string) => apiGetJson<unknown>(careerPath(`/activity?since=${encodeURIComponent(since)}`)).then(r => pickList<ActivityEntry>(r, 'entries')),
  onboarding: () => apiGetJson<unknown>(careerPath('/onboarding')).then(r => pickObject<OnboardingChecklist>(r, 'checklist')),
  handoffs: () => apiGetJson<unknown>(careerPath('/handoffs')).then(r => pickList<{ id: string; reason: string; message: string | null; paused_at: string }>(r, 'handoffs')),

  // ----- 收件箱 -----
  inbox: (status?: 'new' | 'processed' | 'dismissed') => apiGetJson<unknown>(careerPath(`/inbox${status ? `?status=${status}` : ''}`)).then(r => pickList<InboxItem>(r, 'items')),
  captureInbox: (body: { text: string; source?: 'paste' | 'file' | 'url'; application_id?: string | null }) => apiPostJson<unknown>(careerPath('/inbox'), body).then(r => pickObject<IntakeResult>(r, 'result')),
  dismissInbox: (id: string) => apiPostJson<unknown>(careerPath(`/inbox/${encodeURIComponent(id)}/dismiss`), {}).then(r => pickObject<InboxItem>(r, 'item')),
  retryInbox: (id: string, application_id?: string | null) => apiPostJson<unknown>(careerPath(`/inbox/${encodeURIComponent(id)}/retry`), { application_id }).then(r => pickObject<IntakeResult>(r, 'result')),

  // ----- 截止事件 -----
  deadlines: (status?: 'open' | 'done' | 'missed' | 'cancelled' | 'open_or_missed') => apiGetJson<unknown>(careerPath(`/deadlines${status ? `?status=${status}` : ''}`)).then(r => pickList<Deadline>(r, 'deadlines')),
  createDeadline: (body: { kind: Deadline['kind']; title: string; due_at: string; application_id?: string | null; job_id?: string | null; url?: string | null; note?: string | null }) => apiPostJson<unknown>(careerPath('/deadlines'), body).then(r => pickObject<Deadline>(r, 'deadline')),
  setDeadlineStatus: (id: string, status: Deadline['status']) => apiPostJson<unknown>(careerPath(`/deadlines/${encodeURIComponent(id)}/status`), { status }).then(r => pickObject<Deadline>(r, 'deadline')),

  // ----- 卷宗 -----
  dossiers: () => apiGetJson<unknown>(careerPath('/dossiers')).then(r => pickList<DossierSummary>(r, 'dossiers')),
  dossier: (applicationId: string) => apiGetJson<unknown>(careerPath(`/dossiers/${encodeURIComponent(applicationId)}`)).then(r => pickObject<Dossier>(r, 'dossier')),
  addDossierNote: (applicationId: string, body: { kind?: DossierNote['kind']; round?: string | null; content: string }) => apiPostJson<unknown>(careerPath(`/dossiers/${encodeURIComponent(applicationId)}/notes`), body).then(r => pickObject<DossierNote>(r, 'note')),
  closeSilent: (applicationId: string, note?: string) => apiPostJson<unknown>(careerPath(`/applications/${encodeURIComponent(applicationId)}/close-silent`), { note }).then(r => pickObject<Application>(r, 'application')),

  // ----- 素材 -----
  materials: (kind?: Material['kind']) => apiGetJson<unknown>(careerPath(`/materials${kind ? `?kind=${kind}` : ''}`)).then(r => pickList<Material>(r, 'materials')),
  createMaterial: (body: { kind: Material['kind']; title: string; content: string; question_key?: string | null; length_variant?: string | null; company_scope?: string | null; confirmed?: boolean; claim_ids?: string[]; tags?: string[] }) => apiPostJson<unknown>(careerPath('/materials'), body).then(r => pickObject<Material>(r, 'material')),
  updateMaterial: (id: string, body: { title?: string; content?: string; confirmed?: boolean; company_scope?: string | null; tags?: string[] }) => apiPutJson<unknown>(careerPath(`/materials/${encodeURIComponent(id)}`), body).then(r => pickObject<Material>(r, 'material')),
  deleteMaterial: (id: string) => apiDelete<unknown>(careerPath(`/materials/${encodeURIComponent(id)}`)),
  materialUses: (filter: { application_id?: string; company_name?: string; material_id?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0)).toString();
    return apiGetJson<unknown>(careerPath(`/materials/uses${q ? `?${q}` : ''}`)).then(r => pickList<MaterialUse>(r, 'uses'));
  },
  recordMaterialUse: (body: { material_id?: string | null; application_id?: string | null; job_id?: string | null; company_name?: string | null; context: string; content_snapshot: string }) => apiPostJson<unknown>(careerPath('/materials/uses'), body).then(r => pickObject<MaterialUse>(r, 'use')),

  // ----- 复盘 -----
  review: () => apiGetJson<unknown>(careerPath('/review')).then(r => {
    const d = asDict(r);
    return { funnel: (d.funnel as Funnel) ?? { by_category: [], by_platform: [], overall: null }, reviews: pickList<WeeklyReview>(d.reviews) };
  }),
  generateWeeklyReview: (body: { week_start?: string; user_note?: string } = {}) => apiPostJson<unknown>(careerPath('/review/weekly'), body).then(r => asDict(r) as { review?: WeeklyReview; output?: Record<string, unknown> }),

  // ----- 邮箱 -----
  mailAccounts: () => apiGetJson<unknown>(careerPath('/mail/accounts')).then(r => {
    const d = asDict(r);
    return { accounts: pickList<MailAccount>(d.accounts), presets: (d.presets as Record<string, MailPreset>) ?? {} };
  }),
  bindMailAccount: (body: { address: string; password?: string; provider?: string; display_name?: string; imap_host?: string; imap_port?: number; smtp_host?: string; smtp_port?: number; verify?: boolean }) =>
    apiPostJson<unknown>(careerPath('/mail/accounts'), body).then(r => asDict(r) as { account?: MailAccount; verify?: { error?: string; fetched?: number; job_related?: number } | null }),
  deleteMailAccount: (id: string) => apiDelete<unknown>(careerPath(`/mail/accounts/${encodeURIComponent(id)}`)),
  syncMail: (account_id?: string) => apiPostJson<unknown>(careerPath('/mail/sync'), { account_id }).then(r => pickList<{ account_id: string; fetched: number; stored: number; job_related: number; ignored: number; error?: string; archived: Array<{ summary: string }> }>(r, 'results')),
  mailMessages: (filter: { application_id?: string; direction?: 'in' | 'out'; relevance?: 'job' | 'ignored' | 'unknown'; limit?: number } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return apiGetJson<unknown>(careerPath(`/mail/messages${q ? `?${q}` : ''}`)).then(r => pickList<MailMessage>(r, 'messages'));
  },
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
