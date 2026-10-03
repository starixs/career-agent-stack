import { Db, now } from './db/db.js'
import { newId } from './ids.js'
import { canTransition, STAGE_TRANSITIONS, ACTIONS_REQUIRING_REVIEW, type ApplicationStage, type ActionKind, type HandoffReason, type TaskStatus, type InboxKind, type InboxSource, type DeadlineKind, type DeadlineStatus, type DossierNoteKind, type MaterialKind } from './states.js'
import type { Experience, Claim, Evidence, Job, Application, ActionQueueItem, Handoff, Task, Session, Message, InboxItem, Deadline, DossierNote, Material, MaterialUse, WeeklyReview, MailAccount, MailMessage } from './types.js'
import { classifyJobTitle, deadlineToToday, funnelBy, sortToday, staleToToday, type TodayItem, type FunnelRow } from './surfaces.js'

/** 领域仓储：薄封装，保证状态流转规则只在一处实现。 */
export interface ChatCardRow { id: string; session_id: string | null; tool_use_id: string | null; kind: string; title: string; data_json: string; state: 'pending' | 'completed' | 'dismissed'; created_at: string; updated_at: string }

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
  /**
   * 沿状态机最短合法路径把投递推进到目标阶段（收件箱 / 邮件归档用：收到面试邀请时投递可能还停在 evaluated）。
   * 每一步都写 application_history；到不了目标阶段抛错。
   */
  jumpTo(appId: string, to: ApplicationStage, note?: string, extra: Partial<Application> = {}): Application {
    const app = this.getApplication(appId); if (!app) throw new Error(`application 不存在: ${appId}`)
    if (app.stage === to) return app
    const path = shortestStagePath(app.stage, to)
    if (!path) throw new Error(`无法从 ${app.stage} 推进到 ${to}`)
    // transition 自带事务（SQLite 不支持嵌套），这里顺序执行即可。
    let cur = app
    path.forEach((stage, i) => { cur = this.transition(appId, stage, i === path.length - 1 ? note : `自动推进（${note ?? ''}）`, i === path.length - 1 ? extra : {}) })
    return cur
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
  // ---------- 对话内流程卡片 ----------
  /** 同 id 覆盖内容；已完成 / 已忽略的卡片被重新推出时回到 pending（说明又需要用户了）。 */
  upsertChatCard(c: { id: string; session_id?: string | null; tool_use_id?: string | null; kind: string; title: string; data: unknown }): ChatCardRow {
    const t = now()
    this.db.run(`INSERT INTO chat_card(id, session_id, tool_use_id, kind, title, data_json, state, created_at, updated_at) VALUES(?,?,?,?,?,?, 'pending', ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id=COALESCE(excluded.session_id, chat_card.session_id), tool_use_id=COALESCE(excluded.tool_use_id, chat_card.tool_use_id), kind=excluded.kind, title=excluded.title, data_json=excluded.data_json, state='pending', updated_at=excluded.updated_at`,
    [c.id, c.session_id ?? null, c.tool_use_id ?? null, c.kind, c.title, JSON.stringify(c.data ?? {}), t, t])
    return this.getChatCard(c.id)!
  }
  getChatCard(id: string): ChatCardRow | undefined { return this.db.get<ChatCardRow>('SELECT * FROM chat_card WHERE id=?', [id]) }
  listChatCards(sessionId: string, limit = 200): ChatCardRow[] { return this.db.all<ChatCardRow>('SELECT * FROM chat_card WHERE session_id=? ORDER BY created_at DESC LIMIT ?', [sessionId, limit]).reverse() }
  setChatCardState(id: string, state: 'pending' | 'completed' | 'dismissed'): ChatCardRow | undefined {
    this.db.run('UPDATE chat_card SET state=?, updated_at=? WHERE id=?', [state, now(), id])
    return this.getChatCard(id)
  }
  kvGet<T = unknown>(key: string): T | undefined { const r = this.db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key=?', [key]); return r ? JSON.parse(r.value_json) as T : undefined }
  kvSet(key: string, value: unknown): void { this.db.run('INSERT INTO kv(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at', [key, JSON.stringify(value), now()]) }
  findAnswer(questionKey: string) { return this.db.get<{ id: string; answer: string; high_impact: number; confirmed: number }>('SELECT id, answer, high_impact, confirmed FROM answer_bank WHERE question_key=? ORDER BY confirmed DESC, updated_at DESC LIMIT 1', [questionKey]) }
  saveAnswer(a: { question_key: string; question_text: string; answer: string; high_impact?: boolean; confirmed?: boolean }): void {
    this.db.insert('answer_bank', { id: newId('ans'), question_key: a.question_key, question_text: a.question_text, answer: a.answer, high_impact: a.high_impact ? 1 : 0, confirmed: a.confirmed ? 1 : 0, updated_at: now() })
  }

  // ======================================================================
  // 五个面：收件箱 / 今日 / 卷宗 / 素材 / 复盘 / 邮箱
  // ======================================================================

  // ---------- 收件箱 ----------
  createInboxItem(i: { source?: InboxSource; raw_text: string; mail_message_id?: string | null; note?: string | null }): InboxItem {
    const id = newId('inb')
    this.db.insert('inbox_item', { id, source: i.source ?? 'paste', raw_text: i.raw_text, kind: null, status: 'new', parsed_json: null, linked_type: null, linked_id: null, mail_message_id: i.mail_message_id ?? null, note: i.note ?? null, created_at: now(), processed_at: null })
    return this.getInboxItem(id)!
  }
  getInboxItem(id: string): InboxItem | undefined { return this.db.get<InboxItem>('SELECT * FROM inbox_item WHERE id=?', [id]) }
  listInbox(status?: InboxItem['status'], limit = 200): InboxItem[] {
    return status
      ? this.db.all<InboxItem>('SELECT * FROM inbox_item WHERE status=? ORDER BY created_at DESC LIMIT ?', [status, limit])
      : this.db.all<InboxItem>('SELECT * FROM inbox_item ORDER BY created_at DESC LIMIT ?', [limit])
  }
  /** 助理归类后回写：kind + 结构化字段 + 关联对象；status 缺省 processed。 */
  resolveInboxItem(id: string, r: { kind?: InboxKind | null; parsed?: unknown; linked_type?: string | null; linked_id?: string | null; note?: string | null; status?: InboxItem['status'] }): InboxItem {
    if (!this.getInboxItem(id)) throw new Error(`收件箱条目不存在：${id}`)
    this.db.update('inbox_item', id, { ...stripUndefined({ kind: r.kind, linked_type: r.linked_type, linked_id: r.linked_id, note: r.note }), ...(r.parsed !== undefined ? { parsed_json: JSON.stringify(r.parsed) } : {}), status: r.status ?? 'processed', processed_at: now() })
    return this.getInboxItem(id)!
  }
  dismissInboxItem(id: string): InboxItem { return this.resolveInboxItem(id, { status: 'dismissed' }) }

  // ---------- 截止与定时事件（不丢球） ----------
  createDeadline(d: { kind: DeadlineKind; title: string; due_at: string; application_id?: string | null; job_id?: string | null; interview_id?: string | null; offer_id?: string | null; source?: string; url?: string | null; note?: string | null }): Deadline {
    const t = now(); const id = newId('ddl')
    this.db.insert('deadline', { id, kind: d.kind, title: d.title, due_at: d.due_at, application_id: d.application_id ?? null, job_id: d.job_id ?? null, interview_id: d.interview_id ?? null, offer_id: d.offer_id ?? null, source: d.source ?? 'manual', status: 'open', url: d.url ?? null, note: d.note ?? null, created_at: t, updated_at: t })
    return this.getDeadline(id)!
  }
  getDeadline(id: string): Deadline | undefined { return this.db.get<Deadline>('SELECT * FROM deadline WHERE id=?', [id]) }
  listDeadlines(f: { status?: DeadlineStatus | 'open_or_missed'; application_id?: string; until?: string } = {}): Deadline[] {
    const where: string[] = []; const params: unknown[] = []
    if (f.status === 'open_or_missed') where.push(`status IN ('open','missed')`)
    else if (f.status) { where.push('status=?'); params.push(f.status) }
    if (f.application_id) { where.push('application_id=?'); params.push(f.application_id) }
    if (f.until) { where.push('due_at<=?'); params.push(f.until) }
    return this.db.all<Deadline>(`SELECT * FROM deadline ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY due_at`, params as (string | number)[])
  }
  setDeadlineStatus(id: string, status: DeadlineStatus): Deadline {
    if (!this.db.update('deadline', id, { status, updated_at: now() })) throw new Error(`截止事件不存在：${id}`)
    return this.getDeadline(id)!
  }
  /** 把已过期仍 open 的事件标为 missed（今日队列读取前调用）。 */
  markMissedDeadlines(nowIso = now()): number {
    return this.db.run(`UPDATE deadline SET status='missed', updated_at=? WHERE status='open' AND due_at < ?`, [nowIso, nowIso]).changes
  }

  // ---------- 卷宗 ----------
  addDossierNote(n: { application_id: string; kind?: DossierNoteKind; round?: string | null; content: string }): DossierNote {
    if (!this.getApplication(n.application_id)) throw new Error(`application 不存在: ${n.application_id}`)
    const id = newId('dnt')
    this.db.insert('dossier_note', { id, application_id: n.application_id, kind: n.kind ?? 'note', round: n.round ?? null, content: n.content, created_at: now() })
    return this.db.get<DossierNote>('SELECT * FROM dossier_note WHERE id=?', [id])!
  }
  listDossierNotes(applicationId: string): DossierNote[] { return this.db.all<DossierNote>('SELECT * FROM dossier_note WHERE application_id=? ORDER BY created_at', [applicationId]) }
  applicationsWithJob(): Array<Application & { job: Job }> {
    const jobs = new Map(this.listJobs().map(j => [j.id, j]))
    return this.listApplications().flatMap(a => { const job = jobs.get(a.job_id); return job ? [{ ...a, job }] : [] })
  }
  /** 按公司名（含品牌别名）找仍在进行中的投递；邮件 / 收件箱归档用。 */
  findOpenApplicationsByCompany(companyName: string): Array<Application & { job: Job }> {
    const key = companyName.trim().toLowerCase()
    if (!key) return []
    return this.applicationsWithJob().filter(a => {
      const name = (a.job.company_name ?? '').toLowerCase()
      return name && (name.includes(key) || key.includes(name)) && !['rejected', 'discarded', 'skip', 'hired'].includes(a.stage)
    })
  }

  // ---------- 素材 ----------
  createMaterial(m: { kind: MaterialKind; title: string; content: string; question_key?: string | null; length_variant?: string | null; claim_ids?: string[]; tags?: string[]; company_scope?: string | null; confirmed?: boolean }): Material {
    const t = now(); const id = newId('mat')
    this.db.insert('material', { id, kind: m.kind, title: m.title, question_key: m.question_key ?? null, content: m.content, length_variant: m.length_variant ?? null, claim_ids_json: JSON.stringify(m.claim_ids ?? []), tags_json: JSON.stringify(m.tags ?? []), company_scope: m.company_scope ?? null, confirmed: m.confirmed ? 1 : 0, created_at: t, updated_at: t })
    return this.getMaterial(id)!
  }
  getMaterial(id: string): Material | undefined { return this.db.get<Material>('SELECT * FROM material WHERE id=?', [id]) }
  updateMaterial(id: string, patch: { title?: string; content?: string; length_variant?: string | null; claim_ids?: string[]; tags?: string[]; company_scope?: string | null; confirmed?: boolean; question_key?: string | null }): Material {
    if (!this.getMaterial(id)) throw new Error(`素材不存在：${id}`)
    const row: Record<string, unknown> = stripUndefined({ title: patch.title, content: patch.content, length_variant: patch.length_variant, company_scope: patch.company_scope, question_key: patch.question_key })
    if (patch.claim_ids) row.claim_ids_json = JSON.stringify(patch.claim_ids)
    if (patch.tags) row.tags_json = JSON.stringify(patch.tags)
    if (patch.confirmed !== undefined) row.confirmed = patch.confirmed ? 1 : 0
    this.db.update('material', id, { ...row, updated_at: now() })
    return this.getMaterial(id)!
  }
  deleteMaterial(id: string): void { this.db.run('DELETE FROM material WHERE id=?', [id]) }
  listMaterials(f: { kind?: MaterialKind; question_key?: string; company?: string } = {}): Material[] {
    const where: string[] = []; const params: string[] = []
    if (f.kind) { where.push('kind=?'); params.push(f.kind) }
    if (f.question_key) { where.push('question_key=?'); params.push(f.question_key) }
    if (f.company) { where.push('(company_scope IS NULL OR company_scope=?)'); params.push(f.company) }
    return this.db.all<Material>(`SELECT * FROM material ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY confirmed DESC, updated_at DESC`, params)
  }
  recordMaterialUse(u: { material_id?: string | null; application_id?: string | null; job_id?: string | null; company_name?: string | null; context: string; content_snapshot: string }): MaterialUse {
    const id = newId('muse')
    let company = u.company_name ?? null
    if (!company && u.application_id) { const app = this.getApplication(u.application_id); company = app ? this.getJob(app.job_id)?.company_name ?? null : null }
    this.db.insert('material_use', { id, material_id: u.material_id ?? null, application_id: u.application_id ?? null, job_id: u.job_id ?? null, company_name: company, context: u.context, content_snapshot: u.content_snapshot, used_at: now() })
    return this.db.get<MaterialUse>('SELECT * FROM material_use WHERE id=?', [id])!
  }
  listMaterialUses(f: { application_id?: string; company_name?: string; material_id?: string } = {}): MaterialUse[] {
    const where: string[] = []; const params: string[] = []
    if (f.application_id) { where.push('application_id=?'); params.push(f.application_id) }
    if (f.company_name) { where.push('company_name=?'); params.push(f.company_name) }
    if (f.material_id) { where.push('material_id=?'); params.push(f.material_id) }
    return this.db.all<MaterialUse>(`SELECT * FROM material_use ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY used_at DESC`, params)
  }

  // ---------- 今日队列 ----------
  /** 今天必须做的事（已排序）：过期 / 今天到期 → 待审 → 接管 → 今日面试 → 新收件 → 静默可关 → 近三天到期。 */
  today(nowIso = now()): { items: TodayItem[]; waiting: { count: number; by_stage: Array<{ stage: string; n: number }> }; inbox_new: number; pending_review: number } {
    this.markMissedDeadlines(nowIso)
    const items: TodayItem[] = []
    for (const d of this.listDeadlines({ status: 'open_or_missed' })) { const it = deadlineToToday({ ...d, status: 'open' }, nowIso); if (it) items.push(it) }
    const pendingActions = this.listActions('pending_review')
    for (const a of pendingActions) {
      const app = a.application_id ? this.getApplication(a.application_id) : undefined
      const job = app ? this.getJob(app.job_id) : undefined
      items.push({ kind: 'review', priority: 2, title: `待你批准：${actionLabel(a.kind)}${job ? ` · ${job.company_name ?? ''} ${job.title}` : ''}`, detail: '助理已准备好，批准后才会执行', ref: { type: 'action', id: a.id } })
    }
    for (const h of this.openHandoffs()) items.push({ kind: 'handoff', priority: 3, title: `需要你本人处理：${h.reason}`, detail: h.message ?? undefined, ref: { type: 'handoff', id: h.id } })
    const apps = this.applicationsWithJob()
    for (const a of apps) { const it = staleToToday({ ...a, title: a.job.title, company_name: a.job.company_name }, nowIso); if (it) items.push(it) }
    const inboxNew = this.listInbox('new')
    if (inboxNew.length) items.push({ kind: 'inbox', priority: 5, title: `收件箱有 ${inboxNew.length} 条新内容待归档`, ref: { type: 'inbox', id: inboxNew[0].id }, suggest: '帮我把收件箱里的新内容归档' })
    const waitingStages: ApplicationStage[] = ['applied', 'responded', 'interview', 'pending']
    const waiting = apps.filter(a => waitingStages.includes(a.stage))
    const byStage = new Map<string, number>()
    for (const a of waiting) byStage.set(a.stage, (byStage.get(a.stage) ?? 0) + 1)
    return { items: sortToday(items), waiting: { count: waiting.length, by_stage: [...byStage].map(([stage, n]) => ({ stage, n })) }, inbox_new: inboxNew.length, pending_review: pendingActions.length }
  }

  // ---------- 漏斗 / 复盘 ----------
  funnel(nowIso = now()): { by_category: FunnelRow[]; by_platform: FunnelRow[]; overall: FunnelRow | null } {
    const rows = this.applicationsWithJob()
    const byCategory = funnelBy(rows, r => classifyJobTitle(r.job.title), nowIso)
    const byPlatform = funnelBy(rows, r => r.job.source_platform, nowIso)
    const overall = funnelBy(rows, () => 'all', nowIso)[0] ?? null
    return { by_category: byCategory, by_platform: byPlatform, overall }
  }
  saveWeeklyReview(r: { week_start: string; funnel: unknown; insights?: unknown; suggestions?: unknown; small_action?: string | null }): WeeklyReview {
    const id = newId('wrv')
    this.db.insert('weekly_review', { id, week_start: r.week_start, funnel_json: JSON.stringify(r.funnel ?? {}), insights_json: JSON.stringify(r.insights ?? []), suggestions_json: JSON.stringify(r.suggestions ?? []), small_action: r.small_action ?? null, created_at: now() })
    return this.db.get<WeeklyReview>('SELECT * FROM weekly_review WHERE id=?', [id])!
  }
  listWeeklyReviews(limit = 12): WeeklyReview[] { return this.db.all<WeeklyReview>('SELECT * FROM weekly_review ORDER BY created_at DESC LIMIT ?', [limit]) }

  // ---------- 邮箱 ----------
  upsertMailAccount(a: { provider: MailAccount['provider']; address: string; display_name?: string | null; imap_host: string; imap_port?: number; smtp_host: string; smtp_port?: number }): MailAccount {
    const t = now()
    const existing = this.db.get<MailAccount>('SELECT * FROM mail_account WHERE address=?', [a.address])
    if (existing) {
      this.db.update('mail_account', existing.id, { provider: a.provider, display_name: a.display_name ?? existing.display_name, imap_host: a.imap_host, imap_port: a.imap_port ?? existing.imap_port, smtp_host: a.smtp_host, smtp_port: a.smtp_port ?? existing.smtp_port, updated_at: t })
      return this.getMailAccount(existing.id)!
    }
    const id = newId('mla')
    this.db.insert('mail_account', { id, provider: a.provider, address: a.address, display_name: a.display_name ?? null, imap_host: a.imap_host, imap_port: a.imap_port ?? 993, smtp_host: a.smtp_host, smtp_port: a.smtp_port ?? 465, status: 'unverified', last_sync_at: null, last_uid: 0, last_error: null, created_at: t, updated_at: t })
    return this.getMailAccount(id)!
  }
  getMailAccount(id: string): MailAccount | undefined { return this.db.get<MailAccount>('SELECT * FROM mail_account WHERE id=?', [id]) }
  listMailAccounts(): MailAccount[] { return this.db.all<MailAccount>('SELECT * FROM mail_account ORDER BY created_at') }
  updateMailAccount(id: string, patch: Partial<Pick<MailAccount, 'status' | 'last_sync_at' | 'last_uid' | 'last_error' | 'display_name'>>): void { this.db.update('mail_account', id, { ...stripUndefined(patch), updated_at: now() }) }
  deleteMailAccount(id: string): void { this.db.run('DELETE FROM mail_account WHERE id=?', [id]) }
  /** 同账号同 uid 只存一次；返回 null 表示已存在。 */
  insertMailMessage(m: Omit<MailMessage, 'id' | 'created_at'>): MailMessage | null {
    if (m.uid !== null && this.db.get('SELECT 1 FROM mail_message WHERE account_id=? AND uid=?', [m.account_id, m.uid])) return null
    const id = newId('mail')
    this.db.insert('mail_message', { ...m, id, created_at: now() })
    return this.getMailMessage(id)!
  }
  getMailMessage(id: string): MailMessage | undefined { return this.db.get<MailMessage>('SELECT * FROM mail_message WHERE id=?', [id]) }
  updateMailMessage(id: string, patch: Partial<Pick<MailMessage, 'relevance' | 'kind' | 'inbox_item_id' | 'application_id' | 'action_id'>>): void { this.db.update('mail_message', id, stripUndefined(patch)) }
  listMailMessages(f: { account_id?: string; application_id?: string; direction?: 'in' | 'out'; relevance?: MailMessage['relevance']; limit?: number } = {}): MailMessage[] {
    const where: string[] = []; const params: (string | number)[] = []
    if (f.account_id) { where.push('account_id=?'); params.push(f.account_id) }
    if (f.application_id) { where.push('application_id=?'); params.push(f.application_id) }
    if (f.direction) { where.push('direction=?'); params.push(f.direction) }
    if (f.relevance) { where.push('relevance=?'); params.push(f.relevance) }
    params.push(f.limit ?? 200)
    return this.db.all<MailMessage>(`SELECT * FROM mail_message ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(received_at, created_at) DESC LIMIT ?`, params)
  }
  findMailByMessageId(messageId: string): MailMessage | undefined { return this.db.get<MailMessage>('SELECT * FROM mail_message WHERE message_id=?', [messageId]) }
}

function actionLabel(kind: ActionKind): string {
  const map: Record<ActionKind, string> = { fill_form: '网申填表', submit: '提交网申', send_greeting: '发送招呼语', upload: '上传附件', answer_open_q: '回答开放题', collect: '采集岗位', research: '公司调研', send_mail: '发送投递邮件' }
  return map[kind] ?? kind
}

/** BFS 求状态机上的最短路径（不含起点，含终点）；无路径返回 null。 */
export function shortestStagePath(from: ApplicationStage, to: ApplicationStage): ApplicationStage[] | null {
  if (from === to) return []
  const prev = new Map<ApplicationStage, ApplicationStage | null>([[from, null]])
  const queue: ApplicationStage[] = [from]
  while (queue.length) {
    const cur = queue.shift()!
    for (const next of STAGE_TRANSITIONS[cur] ?? []) {
      if (prev.has(next)) continue
      prev.set(next, cur)
      if (next === to) {
        const path: ApplicationStage[] = []
        for (let s: ApplicationStage | null = to; s && s !== from; s = prev.get(s) ?? null) path.unshift(s)
        return path
      }
      queue.push(next)
    }
  }
  return null
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
