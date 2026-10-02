import { Db, now } from './db/db.js'
import { newId } from './ids.js'
import { canTransition, ACTIONS_REQUIRING_REVIEW, type ApplicationStage, type ActionKind, type HandoffReason, type TaskStatus } from './states.js'
import type { Experience, Claim, Evidence, Job, Application, ActionQueueItem, Handoff, Task, Session, Message } from './types.js'

/** 领域仓储：薄封装，保证状态流转规则只在一处实现。 */
export class Repos {
  constructor(public readonly db: Db) {}

  // ---------- 经历库 ----------
  createExperience(e: Partial<Experience> & { title: string }): Experience {
    const t = now(); const id = newId('exp')
    this.db.insert('experience', { id, title: e.title, role: e.role ?? null, org: e.org ?? null, start_date: e.start_date ?? null, end_date: e.end_date ?? null, type: e.type ?? 'other', summary: e.summary ?? null, redacted: e.redacted ?? 0, created_at: t, updated_at: t })
    return this.db.get<Experience>('SELECT * FROM experience WHERE id=?', [id])!
  }
  addClaim(c: Partial<Claim> & { experience_id: string; text: string }): Claim {
    const t = now(); const id = newId('clm')
    this.db.insert('claim', { id, experience_id: c.experience_id, text: c.text, attribution: c.attribution ?? 'unknown', result_metric: c.result_metric ?? null, status: c.status ?? 'pending', created_from: c.created_from ?? 'interview', created_at: t, updated_at: t })
    return this.db.get<Claim>('SELECT * FROM claim WHERE id=?', [id])!
  }
  addEvidence(ev: Partial<Evidence> & { claim_id: string; kind: string; locator: string }): Evidence {
    const id = newId('evd')
    this.db.insert('evidence', { id, claim_id: ev.claim_id, kind: ev.kind, locator: ev.locator, excerpt: ev.excerpt ?? null, strength: ev.strength ?? 'weak', captured_at: now() })
    return this.db.get<Evidence>('SELECT * FROM evidence WHERE id=?', [id])!
  }
  confirmClaim(id: string): void { this.db.update('claim', id, { status: 'user_confirmed', updated_at: now() }) }
  listExperiences(): Experience[] { return this.db.all<Experience>(`SELECT * FROM experience ORDER BY COALESCE(end_date, '9999') DESC, start_date DESC`) }
  listClaims(experienceId?: string): Claim[] {
    return experienceId ? this.db.all<Claim>('SELECT * FROM claim WHERE experience_id=? ORDER BY created_at', [experienceId]) : this.db.all<Claim>('SELECT * FROM claim ORDER BY created_at')
  }
  listEvidence(claimId: string): Evidence[] { return this.db.all<Evidence>('SELECT * FROM evidence WHERE claim_id=? ORDER BY captured_at', [claimId]) }
  /** 整棵经历树（经历 → 主张 → 证据），供简历/面试技能读取。 */
  experienceTree(): Array<Experience & { claims: Array<Claim & { evidence: Evidence[] }> }> {
    return this.listExperiences().map(e => ({ ...e, claims: this.listClaims(e.id).map(c => ({ ...c, evidence: this.listEvidence(c.id) })) }))
  }

  // ---------- 岗位 ----------
  upsertJob(j: Partial<Job> & { source_platform: string; title: string }): Job {
    const t = now()
    const existing = j.source_job_id ? this.db.get<Job>('SELECT * FROM job WHERE source_platform=? AND source_job_id=?', [j.source_platform, j.source_job_id]) : undefined
    if (existing) { this.db.update('job', existing.id, { ...stripUndefined(j), updated_at: t }); return this.db.get<Job>('SELECT * FROM job WHERE id=?', [existing.id])! }
    const id = newId('job')
    this.db.insert('job', { id, source_platform: j.source_platform, source_job_id: j.source_job_id ?? null, url: j.url ?? null, company_id: j.company_id ?? null, company_name: j.company_name ?? null, title: j.title, location: j.location ?? null, salary: j.salary ?? null, jd_raw: j.jd_raw ?? null, jd_parsed_json: j.jd_parsed_json ?? null, prefilter_json: j.prefilter_json ?? null, score_json: j.score_json ?? null, deadline: j.deadline ?? null, deadline_verified_at: j.deadline_verified_at ?? null, created_at: t, updated_at: t })
    return this.db.get<Job>('SELECT * FROM job WHERE id=?', [id])!
  }
  getJob(id: string): Job | undefined { return this.db.get<Job>('SELECT * FROM job WHERE id=?', [id]) }
  listJobs(): Job[] { return this.db.all<Job>('SELECT * FROM job ORDER BY created_at DESC') }
  /** 两级去重：(platform, job_id) 由唯一索引保证；这里做 (company, title, location) 软去重。 */
  findDuplicateJob(companyName: string, title: string, location?: string | null): Job | undefined {
    return this.db.get<Job>(`SELECT * FROM job WHERE company_name=? AND title=? AND COALESCE(location,'')=COALESCE(?,'') LIMIT 1`, [companyName, title, location ?? null])
  }

  // ---------- 投递台 ----------
  createApplication(jobId: string, resumeTailoredId?: string | null): Application {
    const t = now(); const id = newId('app')
    this.db.insert('application', { id, job_id: jobId, resume_tailored_id: resumeTailoredId ?? null, stage: 'evaluated', created_at: t, updated_at: t })
    this.db.insert('application_history', { id: newId('hist'), application_id: id, from_stage: null, to_stage: 'evaluated', note: null, created_at: t })
    return this.getApplication(id)!
  }
  getApplication(id: string): Application | undefined { return this.db.get<Application>('SELECT * FROM application WHERE id=?', [id]) }
  listApplications(): Application[] { return this.db.all<Application>('SELECT * FROM application ORDER BY updated_at DESC') }
  transition(appId: string, to: ApplicationStage, note?: string, extra: Partial<Application> = {}): Application {
    const app = this.getApplication(appId); if (!app) throw new Error(`application 不存在: ${appId}`)
    if (!canTransition(app.stage, to)) throw new Error(`不允许的阶段流转: ${app.stage} → ${to}`)
    const t = now()
    this.db.transaction(() => {
      this.db.update('application', appId, { ...stripUndefined(extra), stage: to, updated_at: t })
      this.db.insert('application_history', { id: newId('hist'), application_id: appId, from_stage: app.stage, to_stage: to, note: note ?? null, created_at: t })
    })
    return this.getApplication(appId)!
  }
  /** 看板三问题：今天必须做什么 / 哪里卡住 / 漏斗分布。 */
  board(today = now().slice(0, 10)) {
    const due = this.db.all<Application & { title: string; company_name: string | null; deadline: string | null }>(
      `SELECT a.*, j.title, j.company_name, j.deadline FROM application a JOIN job j ON j.id=a.job_id
       WHERE (a.next_action_due IS NOT NULL AND substr(a.next_action_due,1,10) <= ?) OR (j.deadline IS NOT NULL AND substr(j.deadline,1,10) <= ?) OR a.stage IN ('needs_user')
       ORDER BY COALESCE(a.next_action_due, j.deadline)`, [today, today])
    const blocked = this.db.all<Application & { title: string; company_name: string | null }>(
      `SELECT a.*, j.title, j.company_name FROM application a JOIN job j ON j.id=a.job_id WHERE a.stage='blocked' ORDER BY a.updated_at DESC`)
    const funnel = this.db.all<{ stage: string; n: number }>('SELECT stage, COUNT(*) AS n FROM application GROUP BY stage')
    const pendingReview = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM action_queue WHERE status='pending_review'`)!.n
    return { due, blocked, funnel, pendingReview }
  }

  // ---------- 动作队列（提交/发送永远过人） ----------
  enqueueAction(kind: ActionKind, payload: unknown, applicationId?: string | null, autoApprove = false): ActionQueueItem {
    const t = now(); const id = newId('act')
    const status = autoApprove && !ACTIONS_REQUIRING_REVIEW.includes(kind) ? 'approved' : 'pending_review'
    this.db.insert('action_queue', { id, application_id: applicationId ?? null, kind, payload_json: JSON.stringify(payload ?? {}), status, created_at: t, updated_at: t })
    return this.getAction(id)!
  }
  getAction(id: string): ActionQueueItem | undefined { return this.db.get<ActionQueueItem>('SELECT * FROM action_queue WHERE id=?', [id]) }
  listActions(status?: string): ActionQueueItem[] {
    return status ? this.db.all<ActionQueueItem>('SELECT * FROM action_queue WHERE status=? ORDER BY created_at', [status]) : this.db.all<ActionQueueItem>('SELECT * FROM action_queue ORDER BY created_at DESC')
  }
  reviewActions(ids: string[], decision: 'approved' | 'rejected'): number {
    const t = now(); let n = 0
    this.db.transaction(() => { for (const id of ids) n += this.db.update('action_queue', id, { status: decision, reviewed_at: t, updated_at: t }) })
    return n
  }
  setActionStatus(id: string, status: ActionQueueItem['status'], result?: unknown): void {
    this.db.update('action_queue', id, { status, result_json: result === undefined ? undefined : JSON.stringify(result), updated_at: now() })
  }

  // ---------- 接管 ----------
  openHandoff(reason: HandoffReason, opts: { actionId?: string | null; taskId?: string | null; message?: string } = {}): Handoff {
    const id = newId('hnd')
    this.db.insert('handoff', { id, action_id: opts.actionId ?? null, task_id: opts.taskId ?? null, reason, message: opts.message ?? null, paused_at: now() })
    if (opts.taskId) this.db.update('task', opts.taskId, { status: 'needs_user', updated_at: now() })
    if (opts.actionId) this.setActionStatus(opts.actionId, 'needs_user')
    return this.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [id])!
  }
  closeHandoff(id: string, resumedFromStep?: string): Handoff {
    const h = this.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [id]); if (!h) throw new Error('handoff 不存在')
    this.db.update('handoff', id, { resumed_at: now(), resumed_from_step: resumedFromStep ?? null })
    if (h.task_id) this.db.update('task', h.task_id, { status: 'running', updated_at: now() })
    if (h.action_id) this.setActionStatus(h.action_id, 'executing')
    return this.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [id])!
  }
  openHandoffs(): Handoff[] { return this.db.all<Handoff>('SELECT * FROM handoff WHERE resumed_at IS NULL ORDER BY paused_at') }

  // ---------- 任务与会话 ----------
  createTask(t: { title: string; kind: string; sessionId?: string | null; payload?: unknown }): Task {
    const ts = now(); const id = newId('tsk')
    this.db.insert('task', { id, title: t.title, kind: t.kind, status: 'queued', progress: 0, session_id: t.sessionId ?? null, payload_json: JSON.stringify(t.payload ?? {}), created_at: ts, updated_at: ts })
    return this.getTask(id)!
  }
  getTask(id: string): Task | undefined { return this.db.get<Task>('SELECT * FROM task WHERE id=?', [id]) }
  listTasks(status?: TaskStatus): Task[] {
    return status ? this.db.all<Task>('SELECT * FROM task WHERE status=? ORDER BY updated_at DESC', [status]) : this.db.all<Task>('SELECT * FROM task ORDER BY updated_at DESC LIMIT 200')
  }
  updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'progress' | 'step' | 'result_json' | 'usage_json' | 'title'>>): void {
    this.db.update('task', id, { ...stripUndefined(patch), updated_at: now() })
  }
  addUsage(taskId: string, usage: { input_tokens?: number; output_tokens?: number; browser_ms?: number }): void {
    const t = this.getTask(taskId); if (!t) return
    const cur = JSON.parse(t.usage_json || '{}') as Record<string, number>
    for (const [k, v] of Object.entries(usage)) cur[k] = (cur[k] ?? 0) + (v ?? 0)
    this.db.update('task', taskId, { usage_json: JSON.stringify(cur), updated_at: now() })
  }
  createSession(title?: string): Session {
    const t = now(); const id = newId('ses')
    this.db.insert('session', { id, title: title ?? null, created_at: t, updated_at: t })
    return this.db.get<Session>('SELECT * FROM session WHERE id=?', [id])!
  }
  listSessions(): Session[] { return this.db.all<Session>('SELECT * FROM session ORDER BY updated_at DESC') }
  addMessage(sessionId: string, role: Message['role'], content: unknown): Message {
    const id = newId('msg'); const t = now()
    this.db.insert('message', { id, session_id: sessionId, role, content_json: JSON.stringify(content), created_at: t })
    this.db.update('session', sessionId, { updated_at: t })
    return this.db.get<Message>('SELECT * FROM message WHERE id=?', [id])!
  }
  listMessages(sessionId: string): Message[] { return this.db.all<Message>('SELECT * FROM message WHERE session_id=? ORDER BY created_at', [sessionId]) }

  // ---------- KV / 答案库 ----------
  kvGet<T = unknown>(key: string): T | undefined { const r = this.db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key=?', [key]); return r ? JSON.parse(r.value_json) as T : undefined }
  kvSet(key: string, value: unknown): void { this.db.run('INSERT INTO kv(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at', [key, JSON.stringify(value), now()]) }
  findAnswer(questionKey: string) { return this.db.get<{ id: string; answer: string; high_impact: number; confirmed: number }>('SELECT id, answer, high_impact, confirmed FROM answer_bank WHERE question_key=? ORDER BY confirmed DESC, updated_at DESC LIMIT 1', [questionKey]) }
  saveAnswer(a: { question_key: string; question_text: string; answer: string; high_impact?: boolean; confirmed?: boolean }): void {
    this.db.insert('answer_bank', { id: newId('ans'), question_key: a.question_key, question_text: a.question_text, answer: a.answer, high_impact: a.high_impact ? 1 : 0, confirmed: a.confirmed ? 1 : 0, updated_at: now() })
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
