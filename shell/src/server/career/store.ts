/**
 * CareerStore：Repos 之外、API.md 需要但 @career/core 未封装的表（简历、公司、面试、方向、
 * 差距、Offer、答案库）的薄读写层。规则只有两条：
 *   1. 不绕过 Repos 的状态机（投递阶段、动作队列、接管仍走 Repos）；
 *   2. 简历保存前写快照（resume_snapshot）。
 */
import type { Repos, Company, Interview, Offer, ResumeMaster, ResumeTailored, Application, Task, Job, Deadline, DossierNote, MaterialUse, MailMessage, ActionQueueItem } from '@career/core';
import type { CoreModule } from './core-module';

/** CareerStore 只需要 core 的两个纯函数；由调用方在 `await loadCore()` 后注入，避免静态 import。 */
export type CoreIds = Pick<CoreModule, 'newId' | 'now'>;

export interface Direction { id: string; name: string; status: 'candidate' | 'tentative' | 'chosen' | 'dropped'; rationale_json: string | null; created_at: string; updated_at: string }
export interface GapPlan { id: string; job_id: string | null; direction_id: string | null; gaps_json: string; actions_json: string; created_at: string }
export interface MockInterview { id: string; job_id: string | null; resume_tailored_id: string | null; mode: string; company_type: string | null; round: string | null; turns_json: string; report_json: string | null; created_at: string; updated_at: string }
export interface ExamPractice { id: string; title: string; company_name: string | null; job_id: string | null; kind: string | null; questions_json: string; answers_json: string; review_json: string; summary: string | null; status: 'answering' | 'reviewed'; created_at: string; updated_at: string }
export interface AnswerBankRow { id: string; question_key: string; question_text: string; answer: string; high_impact: number; confirmed: number; updated_at: string }
export interface ProbePrediction { id: string; resume_tailored_id: string | null; claim_id: string | null; statement: string; target_type: string; expected_chain_json: string; risk: string; created_at: string }
export type ApplicationWithJob = Application & { title: string; company_name: string | null; deadline: string | null };

export const DIRECTION_STATUSES = ['candidate', 'tentative', 'chosen', 'dropped'] as const;
export const INTERVIEW_ROUNDS = ['hr', 'first', 'second', 'final', 'group', 'other'] as const;

function jsonOrEmpty(v: unknown, fallback = '{}'): string {
  if (v === undefined || v === null) return fallback;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export class CareerStore {
  private readonly newId: CoreIds['newId'];
  private readonly now: CoreIds['now'];
  constructor(public readonly repos: Repos, core: CoreIds) {
    this.newId = core.newId;
    this.now = core.now;
  }
  private get db() { return this.repos.db; }

  // ---------- 概览 ----------
  overview() {
    const board = this.repos.board();
    const tasks = [...this.repos.listTasks('running'), ...this.repos.listTasks('needs_user')] as Task[];
    return { board, tasks, openHandoffs: this.repos.openHandoffs(), pendingReview: board.pendingReview };
  }

  // ---------- 简历 ----------
  listResumeMasters(): ResumeMaster[] { return this.db.all<ResumeMaster>('SELECT * FROM resume_master ORDER BY updated_at DESC'); }
  listResumeTailored(): ResumeTailored[] { return this.db.all<ResumeTailored>('SELECT * FROM resume_tailored ORDER BY updated_at DESC'); }
  createResumeMaster(input: { name: string; direction?: string | null; schema_json?: unknown }): ResumeMaster {
    const t = this.now(); const id = this.newId('rsm');
    this.db.insert('resume_master', { id, name: input.name, direction: input.direction ?? null, schema_json: jsonOrEmpty(input.schema_json), created_at: t, updated_at: t });
    return this.db.get<ResumeMaster>('SELECT * FROM resume_master WHERE id=?', [id])!;
  }
  /** master 或 tailored 都可以按 id 取。 */
  getResume(id: string): { kind: 'master'; row: ResumeMaster } | { kind: 'tailored'; row: ResumeTailored } | undefined {
    const m = this.db.get<ResumeMaster>('SELECT * FROM resume_master WHERE id=?', [id]);
    if (m) return { kind: 'master', row: m };
    const t = this.db.get<ResumeTailored>('SELECT * FROM resume_tailored WHERE id=?', [id]);
    return t ? { kind: 'tailored', row: t } : undefined;
  }
  /** 保存并写快照；返回更新后的行。 */
  saveResume(id: string, schema: unknown, note = '保存前快照', opts: { snapshot?: boolean } = {}): ResumeMaster | ResumeTailored {
    const cur = this.getResume(id);
    if (!cur) throw new Error(`简历不存在：${id}`);
    const table = cur.kind === 'master' ? 'resume_master' : 'resume_tailored';
    const t = this.now();
    this.db.transaction(() => {
      if (opts.snapshot !== false) this.db.insert('resume_snapshot', { id: this.newId('rss'), resume_id: id, schema_json: cur.row.schema_json, note, created_at: t });
      this.db.update(table, id, { schema_json: jsonOrEmpty(schema), updated_at: t });
    });
    return this.getResume(id)!.row;
  }
  /** 最近一次快照时间（工作台自动保存按它节流快照）。 */
  lastSnapshotAt(id: string): string | null {
    return this.db.get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM resume_snapshot WHERE resume_id=?', [id])?.at ?? null;
  }
  createTailored(input: { master_id: string; job_id?: string | null; schema_json: unknown; strength?: ResumeTailored['strength'] }): ResumeTailored {
    const t = this.now(); const id = this.newId('rst');
    this.db.insert('resume_tailored', { id, master_id: input.master_id, job_id: input.job_id ?? null, schema_json: jsonOrEmpty(input.schema_json), strength: input.strength ?? 'keywords', diff_confirmed_at: null, export_pdf: null, export_docx: null, export_png: null, created_at: t, updated_at: t });
    return this.db.get<ResumeTailored>('SELECT * FROM resume_tailored WHERE id=?', [id])!;
  }
  confirmTailored(id: string, schema?: unknown): ResumeTailored {
    const cur = this.getResume(id);
    if (!cur || cur.kind !== 'tailored') throw new Error(`定制简历不存在：${id}`);
    const t = this.now();
    this.db.transaction(() => {
      this.db.insert('resume_snapshot', { id: this.newId('rss'), resume_id: id, schema_json: cur.row.schema_json, note: '确认前快照', created_at: t });
      this.db.update('resume_tailored', id, { ...(schema !== undefined ? { schema_json: jsonOrEmpty(schema) } : {}), diff_confirmed_at: t, updated_at: t });
    });
    return this.db.get<ResumeTailored>('SELECT * FROM resume_tailored WHERE id=?', [id])!;
  }
  recordExport(id: string, format: 'pdf' | 'docx' | 'png', path: string): void {
    const cur = this.getResume(id);
    if (cur?.kind === 'tailored') this.db.update('resume_tailored', id, { [`export_${format}`]: path, updated_at: this.now() });
  }

  // ---------- 投递（join 岗位） ----------
  listApplicationsWithJob(): ApplicationWithJob[] {
    return this.db.all<ApplicationWithJob>('SELECT a.*, j.title, j.company_name, j.deadline FROM application a JOIN job j ON j.id=a.job_id ORDER BY a.updated_at DESC');
  }

  // ---------- 公司 ----------
  listCompanies(): Company[] { return this.db.all<Company>('SELECT * FROM company ORDER BY updated_at DESC'); }
  findCompany(name: string): Company | undefined {
    return this.db.get<Company>(`SELECT * FROM company WHERE legal_name=? OR brand_names LIKE ? LIMIT 1`, [name, `%${JSON.stringify(name).slice(1, -1)}%`]);
  }
  upsertCompany(name: string, patch: { dd_report_json?: unknown; traffic_light?: string | null; manual_checks?: unknown; legal_name?: string | null }): Company {
    const existing = this.findCompany(name);
    const t = this.now();
    if (existing) {
      this.db.update('company', existing.id, {
        ...(patch.legal_name !== undefined ? { legal_name: patch.legal_name } : {}),
        ...(patch.dd_report_json !== undefined ? { dd_report_json: jsonOrEmpty(patch.dd_report_json) } : {}),
        ...(patch.traffic_light !== undefined ? { traffic_light: patch.traffic_light } : {}),
        ...(patch.manual_checks !== undefined ? { manual_checks: jsonOrEmpty(patch.manual_checks, '[]') } : {}),
        updated_at: t,
      });
      return this.db.get<Company>('SELECT * FROM company WHERE id=?', [existing.id])!;
    }
    const id = this.newId('cmp');
    this.db.insert('company', { id, legal_name: patch.legal_name ?? name, brand_names: JSON.stringify([name]), dd_report_json: patch.dd_report_json !== undefined ? jsonOrEmpty(patch.dd_report_json) : null, traffic_light: patch.traffic_light ?? null, manual_checks: jsonOrEmpty(patch.manual_checks, '[]'), updated_at: t });
    return this.db.get<Company>('SELECT * FROM company WHERE id=?', [id])!;
  }

  // ---------- 面试 ----------
  listInterviews(): Interview[] { return this.db.all<Interview>('SELECT * FROM interview ORDER BY COALESCE(date, created_at) DESC'); }
  getInterview(id: string): Interview | undefined { return this.db.get<Interview>('SELECT * FROM interview WHERE id=?', [id]); }
  createInterview(input: Partial<Interview> & { round?: string }): Interview {
    const t = this.now(); const id = this.newId('itv');
    this.db.insert('interview', {
      id, application_id: input.application_id ?? null, company_name: input.company_name ?? null, title: input.title ?? null,
      round: input.round ?? 'other', date: input.date ?? null, interviewer_role_guess: input.interviewer_role_guess ?? null,
      transcript: input.transcript ?? null, tags_json: jsonOrEmpty(input.tags_json, '[]'), retro_json: input.retro_json !== undefined && input.retro_json !== null ? jsonOrEmpty(input.retro_json) : null,
      result: input.result ?? 'none', result_source: input.result_source ?? 'none', created_at: t, updated_at: t,
    });
    return this.getInterview(id)!;
  }
  updateInterview(id: string, patch: Partial<Interview> & { tags_json?: unknown; retro_json?: unknown }): Interview {
    if (!this.getInterview(id)) throw new Error(`面试记录不存在：${id}`);
    const allowed = ['application_id', 'company_name', 'title', 'round', 'date', 'interviewer_role_guess', 'transcript', 'result', 'result_source'] as const;
    const row: Record<string, unknown> = {};
    for (const k of allowed) if (patch[k] !== undefined) row[k] = patch[k];
    if (patch.tags_json !== undefined) row.tags_json = jsonOrEmpty(patch.tags_json, '[]');
    if (patch.retro_json !== undefined) row.retro_json = patch.retro_json === null ? null : jsonOrEmpty(patch.retro_json);
    this.db.update('interview', id, { ...row, updated_at: this.now() });
    return this.getInterview(id)!;
  }
  listMockInterviews(): MockInterview[] { return this.db.all<MockInterview>('SELECT * FROM mock_interview ORDER BY updated_at DESC'); }
  createMockInterview(input: { job_id?: string | null; resume_tailored_id?: string | null; mode: string; company_type?: string | null; round?: string | null; turns?: unknown; report?: unknown }): MockInterview {
    const t = this.now(); const id = this.newId('mok');
    this.db.insert('mock_interview', { id, job_id: input.job_id ?? null, resume_tailored_id: input.resume_tailored_id ?? null, mode: input.mode, company_type: input.company_type ?? null, round: input.round ?? null, turns_json: jsonOrEmpty(input.turns, '[]'), report_json: input.report !== undefined ? jsonOrEmpty(input.report) : null, created_at: t, updated_at: t });
    return this.db.get<MockInterview>('SELECT * FROM mock_interview WHERE id=?', [id])!;
  }
  // ---------- 笔试练习 ----------
  listExamPractices(): ExamPractice[] { return this.db.all<ExamPractice>('SELECT * FROM exam_practice ORDER BY updated_at DESC'); }
  getExamPractice(id: string): ExamPractice | undefined { return this.db.get<ExamPractice>('SELECT * FROM exam_practice WHERE id=?', [id]); }
  /** 出题时新建；作答 / 批改时按 index 合并答案与点评（后写覆盖同题），finish 后标记已复盘。 */
  saveExamPractice(input: {
    id?: string; title?: string; company_name?: string | null; job_id?: string | null; kind?: string | null;
    questions?: unknown[]; answers?: Array<{ index: number; answer: string }>; review?: Array<{ index: number; verdict: string; comment?: string }>;
    summary?: string | null; finish?: boolean;
  }): ExamPractice {
    const t = this.now();
    const existing = input.id ? this.getExamPractice(input.id) : undefined;
    if (input.id && !existing) throw new Error(`exam_practice 不存在: ${input.id}`);
    const mergeByIndex = <T extends { index: number }>(current: string, next: T[] | undefined): string => {
      if (!next) return current;
      const byIndex = new Map<number, T>((JSON.parse(current) as T[]).map(item => [item.index, item]));
      for (const item of next) byIndex.set(item.index, item);
      return JSON.stringify([...byIndex.values()].sort((a, b) => a.index - b.index));
    };
    if (!existing) {
      if (!input.title) throw new Error('新建笔试练习需要 title');
      const id = this.newId('exm');
      this.db.insert('exam_practice', {
        id, title: input.title, company_name: input.company_name ?? null, job_id: input.job_id ?? null, kind: input.kind ?? null,
        questions_json: jsonOrEmpty(input.questions ?? [], '[]'),
        answers_json: mergeByIndex('[]', input.answers), review_json: mergeByIndex('[]', input.review),
        summary: input.summary ?? null, status: input.finish ? 'reviewed' : 'answering', created_at: t, updated_at: t,
      });
      return this.getExamPractice(id)!;
    }
    this.db.update('exam_practice', existing.id, {
      title: input.title ?? existing.title,
      company_name: input.company_name !== undefined ? input.company_name : existing.company_name,
      kind: input.kind !== undefined ? input.kind : existing.kind,
      questions_json: input.questions ? jsonOrEmpty(input.questions, '[]') : existing.questions_json,
      answers_json: mergeByIndex(existing.answers_json, input.answers),
      review_json: mergeByIndex(existing.review_json, input.review),
      summary: input.summary !== undefined ? input.summary : existing.summary,
      status: input.finish ? 'reviewed' : existing.status,
      updated_at: t,
    });
    return this.getExamPractice(existing.id)!;
  }

  addProbePredictions(rows: Array<{ resume_tailored_id?: string | null; claim_id?: string | null; statement: string; target_type: string; expected_chain?: unknown; risk?: string }>): ProbePrediction[] {
    const out: ProbePrediction[] = [];
    this.db.transaction(() => {
      for (const r of rows) {
        const id = this.newId('prb');
        this.db.insert('probe_prediction', { id, resume_tailored_id: r.resume_tailored_id ?? null, claim_id: r.claim_id ?? null, statement: r.statement, target_type: r.target_type, expected_chain_json: jsonOrEmpty(r.expected_chain, '[]'), risk: r.risk ?? 'mid', created_at: this.now() });
        out.push(this.db.get<ProbePrediction>('SELECT * FROM probe_prediction WHERE id=?', [id])!);
      }
    });
    return out;
  }

  // ---------- 方向 / 差距 / Offer ----------
  listDirections(): Direction[] { return this.db.all<Direction>('SELECT * FROM direction ORDER BY updated_at DESC'); }
  createDirection(name: string, rationale?: unknown): Direction {
    const t = this.now(); const id = this.newId('dir');
    this.db.insert('direction', { id, name, status: 'candidate', rationale_json: rationale !== undefined ? jsonOrEmpty(rationale) : null, created_at: t, updated_at: t });
    return this.db.get<Direction>('SELECT * FROM direction WHERE id=?', [id])!;
  }
  setDirectionStatus(id: string, status: Direction['status']): Direction {
    if (!DIRECTION_STATUSES.includes(status)) throw new Error(`非法的方向状态：${status}`);
    if (!this.db.update('direction', id, { status, updated_at: this.now() })) throw new Error(`方向不存在：${id}`);
    return this.db.get<Direction>('SELECT * FROM direction WHERE id=?', [id])!;
  }
  listGapPlans(): GapPlan[] { return this.db.all<GapPlan>('SELECT * FROM gap_plan ORDER BY created_at DESC'); }
  createGapPlan(input: { job_id?: string | null; direction_id?: string | null; gaps: unknown; actions: unknown }): GapPlan {
    const id = this.newId('gap');
    this.db.insert('gap_plan', { id, job_id: input.job_id ?? null, direction_id: input.direction_id ?? null, gaps_json: jsonOrEmpty(input.gaps), actions_json: jsonOrEmpty(input.actions, '[]'), created_at: this.now() });
    return this.db.get<GapPlan>('SELECT * FROM gap_plan WHERE id=?', [id])!;
  }
  listOffers(): Offer[] { return this.db.all<Offer>('SELECT * FROM offer ORDER BY updated_at DESC'); }
  getOffer(id: string): Offer | undefined { return this.db.get<Offer>('SELECT * FROM offer WHERE id=?', [id]); }
  createOffer(input: Partial<Offer> & { comp_json?: unknown }): Offer {
    const t = this.now(); const id = this.newId('ofr');
    this.db.insert('offer', { id, application_id: input.application_id ?? null, company_name: input.company_name ?? null, title: input.title ?? null, comp_json: jsonOrEmpty(input.comp_json), location: input.location ?? null, content_match: input.content_match ?? null, risk_notes: input.risk_notes ?? null, deadline: input.deadline ?? null, created_at: t, updated_at: t });
    return this.getOffer(id)!;
  }
  updateOffer(id: string, patch: Partial<Offer> & { comp_json?: unknown }): Offer {
    if (!this.getOffer(id)) throw new Error(`Offer 不存在：${id}`);
    const allowed = ['application_id', 'company_name', 'title', 'location', 'content_match', 'risk_notes', 'deadline'] as const;
    const row: Record<string, unknown> = {};
    for (const k of allowed) if (patch[k] !== undefined) row[k] = patch[k];
    if (patch.comp_json !== undefined) row.comp_json = jsonOrEmpty(patch.comp_json);
    this.db.update('offer', id, { ...row, updated_at: this.now() });
    return this.getOffer(id)!;
  }

  // ---------- 答案库 ----------
  listAnswerBank(): AnswerBankRow[] { return this.db.all<AnswerBankRow>('SELECT * FROM answer_bank ORDER BY updated_at DESC'); }

  // ---------- 卷宗（每条投递一个档案） ----------
  /** 卷宗列表：进行中的线 + 已关闭的线，带静默天数与下一个截止。 */
  dossierSummaries(nowIso = this.now()): DossierSummary[] {
    const deadlines = this.repos.listDeadlines({ status: 'open' });
    const interviews = this.listInterviews();
    return this.repos.applicationsWithJob().map(a => {
      const next = deadlines.filter(d => d.application_id === a.id).sort((x, y) => x.due_at.localeCompare(y.due_at))[0] ?? null;
      const itv = interviews.filter(i => i.application_id === a.id);
      const days = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(a.updated_at)) / 86_400_000));
      return { application_id: a.id, job_id: a.job_id, company_name: a.job.company_name, title: a.job.title, stage: a.stage, updated_at: a.updated_at, days_since_update: days, next_deadline: next, interview_count: itv.length, resume_tailored_id: a.resume_tailored_id, closed: ['rejected', 'discarded', 'skip', 'hired'].includes(a.stage) };
    });
  }
  /** 面试前一键摊开的全部材料。 */
  dossier(applicationId: string): Dossier | undefined {
    const app = this.repos.getApplication(applicationId);
    if (!app) return undefined;
    const job = this.repos.getJob(app.job_id);
    if (!job) return undefined;
    const resume = app.resume_tailored_id ? this.getResume(app.resume_tailored_id) : undefined;
    const company = job.company_name ? this.findCompany(job.company_name) : undefined;
    const interviews = this.listInterviews().filter(i => i.application_id === applicationId);
    const offers = this.listOffers().filter(o => o.application_id === applicationId);
    const history = this.db.all<{ from_stage: string | null; to_stage: string; note: string | null; created_at: string }>('SELECT from_stage, to_stage, note, created_at FROM application_history WHERE application_id=? ORDER BY created_at', [applicationId]);
    const predictions = resume ? this.db.all<ProbePrediction>('SELECT * FROM probe_prediction WHERE resume_tailored_id=? ORDER BY created_at DESC', [resume.row.id]) : [];
    return {
      application: app, job, company: company ?? null,
      resume: resume ? { kind: resume.kind, id: resume.row.id, schema: safeJson(resume.row.schema_json), confirmed: resume.kind === 'tailored' ? !!resume.row.diff_confirmed_at : true } : null,
      answers_used: safeJson(app.answers_used_json),
      material_uses: this.repos.listMaterialUses({ application_id: applicationId }),
      notes: this.repos.listDossierNotes(applicationId),
      deadlines: this.repos.listDeadlines({ application_id: applicationId }),
      interviews, offers, history,
      mails: this.repos.listMailMessages({ application_id: applicationId, limit: 50 }),
      actions: this.db.all<ActionQueueItem>('SELECT * FROM action_queue WHERE application_id=? ORDER BY created_at DESC', [applicationId]),
      predictions,
    };
  }
}

export interface DossierSummary { application_id: string; job_id: string; company_name: string | null; title: string; stage: Application['stage']; updated_at: string; days_since_update: number; next_deadline: Deadline | null; interview_count: number; resume_tailored_id: string | null; closed: boolean }
export interface Dossier {
  application: Application; job: Job; company: Company | null;
  resume: { kind: 'master' | 'tailored'; id: string; schema: unknown; confirmed: boolean } | null;
  answers_used: unknown; material_uses: MaterialUse[]; notes: DossierNote[]; deadlines: Deadline[];
  interviews: Interview[]; offers: Offer[]; history: Array<{ from_stage: string | null; to_stage: string; note: string | null; created_at: string }>;
  mails: MailMessage[]; actions: ActionQueueItem[]; predictions: ProbePrediction[];
}

function safeJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
