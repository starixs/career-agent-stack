import { type Repos, type LLM, type Vault, type Application, type ActionQueueItem, type Handoff, type ApplicationStage, canTransition } from '@career/core'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PageLike } from './page.js'
import { driveApplication, type DriveOptions, type DriveResult } from './drive.js'
import type { Profile } from './interpret.js'
import { pickAdapter, type SiteAdapter } from './adapters/index.js'
import { RiskGuard } from './safety.js'

/**
 * ApplyService：把 driveApplication 的结果落到 Repos。
 *  - action_queue：fill_form 执行记录（approved → executing → done/failed/needs_user）；
 *    若停在提交前，再 enqueue 一个 submit 动作 → 永远 pending_review（core 保证），由用户批准后另行执行；
 *  - handoff 表：验证码 / 登录 / 2FA / 测评 / 缺信息 → openHandoff(reason)；
 *  - application 阶段：approved→pending（开始）→ needs_user / blocked（结果）；停在提交前则停留在 pending 等审核。
 */
export interface ApplyRunOptions extends Omit<DriveOptions, 'adapter' | 'riskGuard'> {
  adapter?: SiteAdapter
  riskGuard?: RiskGuard
  /** 截图保存目录（可选）。 */
  screenshotDir?: string
  taskId?: string | null
}
export interface ApplyRunOutcome {
  /** 原始结果（含明文填写值）。只能留在 Node 侧，不要直接回传模型。 */
  result: DriveResult
  /** 已脱敏的摘要：私密库里的明文已换回占位符，可以回传模型 / 展示。 */
  summary: ApplyRunSummary
  action: ActionQueueItem
  submitAction?: ActionQueueItem
  handoff?: Handoff
  application: Application
  screenshotPath?: string
}
export interface ApplyRunSummary {
  status: DriveResult['status']; reason?: string; message: string; finalUrl: string; adapter: string
  filled: DriveResult['filled']; needsUser: DriveResult['needsUser']; drafts: DriveResult['drafts']; mismatches: DriveResult['mismatches']; uploads: DriveResult['uploads']
  submitButton?: string; loginFilled?: DriveResult['loginFilled']; screenshotPath?: string
  /** 字段级最终状态（verified / needs_user + 原因码 / empty_optional …）。 */
  fields?: DriveResult['fields']; blockers?: DriveResult['blockers']; entryClicked?: string; telemetry?: DriveResult['telemetry']
  pages: Array<{ index: number; url: string; fieldCount: number; nextButton?: string; errors: string[] }>
}

export interface ApplyServiceDefaults {
  adapters?: readonly SiteAdapter[]
  maxPages?: number
  /**
   * 私密信息库。给了之后：
   *  - buildProfile 的 basics 来自私密库（覆盖 kv:profile.basics）；
   *  - 填写前把计划值里的 {{vault:...}} 占位符解成明文；
   *  - 登录墙时代填账号密码（只填不点）；
   *  - 落库与回传的摘要全部脱敏（明文 → 占位符）。
   */
  vault?: Vault
}

export class ApplyService {
  constructor(private repos: Repos, private llm: LLM, private defaults: ApplyServiceDefaults = {}) {}
  get vault(): Vault | undefined { return this.defaults.vault }

  /** 从 Repos 组装 Profile 的默认实现（basics 来自私密库，兜底 kv:profile.basics；经历来自经历库，答案库来自 answer_bank）。 */
  buildProfile(resumePath?: string): Profile {
    const basics: Record<string, string> = { ...(this.repos.kvGet<Record<string, string>>('profile.basics') ?? {}) }
    if (this.vault) Object.assign(basics, this.vault.profileBasics({ actor: 'form_fill', purpose: '组装网申资料' }))
    const experiences = this.repos.experienceTree().map(e => ({ title: e.title, org: e.org ?? undefined, role: e.role ?? undefined, period: [e.start_date, e.end_date].filter(Boolean).join('~') || undefined, claims: e.claims.filter(c => c.status !== 'pending').map(c => c.text) }))
    // 停用的不用；excluded（证件 / 密码 / 是否使用 AI…）从不进答案库；固定的排最前
    const answerBank = this.repos.db.all<{ question_key: string; question_text: string; answer: string; high_impact: number; confirmed: number; status: string }>(`SELECT question_key, question_text, answer, high_impact, confirmed, status FROM answer_bank WHERE status!='archived' AND sensitivity!='excluded' ORDER BY (status='pinned') DESC, confirmed DESC, updated_at DESC`)
      .map(a => ({ question_key: a.question_key, question_text: a.question_text, answer: a.answer, high_impact: !!a.high_impact, confirmed: !!a.confirmed, pinned: a.status === 'pinned' }))
    // 教育经历：经历库里 type=education 的经历优先（title=学校，role=专业，summary=学历），否则由基本信息拼一段
    const eduExps = this.repos.experienceTree().filter(e => e.type === 'education')
    const education = eduExps.length
      ? eduExps.map(e => ({ school: e.org ?? e.title, major: e.role ?? undefined, degree: e.summary ?? basics.degree, start: e.start_date ?? undefined, end: e.end_date ?? undefined }))
      : basics.school ? [{ school: basics.school, major: basics.major, degree: basics.degree, end: basics.graduation }] : []
    return { basics, experiences: experiences.filter(e => !eduExps.some(x => x.title === e.title)), education, answerBank, resumePath }
  }

  async run(page: PageLike, applicationId: string, profile: Profile, opts: ApplyRunOptions = {}): Promise<ApplyRunOutcome> {
    const app0 = this.repos.getApplication(applicationId)
    if (!app0) throw new Error(`application 不存在: ${applicationId}`)
    const job = this.repos.getJob(app0.job_id)
    const url = page.url()
    const adapter = opts.adapter ?? pickAdapter(url, this.defaults.adapters)
    const riskGuard = opts.riskGuard ?? new RiskGuard(this.repos, { platform: adapter.id })

    // 阶段：approved / blocked / needs_user → pending
    if (app0.stage !== 'pending') {
      if (!canTransition(app0.stage, 'pending')) throw new Error(`当前阶段 ${app0.stage} 不能开始网申`)
      this.repos.transition(applicationId, 'pending', '开始网申填写', { page_url: url, blocker_reason: null })
    }
    const action = this.repos.enqueueAction('fill_form', { url, adapter: adapter.id, job: job ? { title: job.title, company: job.company_name } : null }, applicationId, true)
    this.repos.claimAction(action.id)

    const vault = this.vault
    const result = await driveApplication(page, this.llm, profile, {
      ...opts, adapter, riskGuard, maxPages: opts.maxPages ?? this.defaults.maxPages,
      interpret: { ...opts.interpret, job: opts.interpret?.job ?? (job ? { title: job.title, company: job.company_name ?? undefined, jd: job.jd_raw ?? undefined } : undefined) },
      resolveValue: opts.resolveValue ?? (vault ? v => vault.resolve(v, { actor: 'form_fill', purpose: `网申填写 ${applicationId}` }) : undefined),
      loginFill: opts.loginFill ?? (vault ? u => { const c = vault.credential(u, { actor: 'login_fill', purpose: `登录页代填 ${u}` }); return c && c.autofill ? { username: c.username, password: c.password } : undefined } : undefined),
    })
    let screenshotPath: string | undefined
    if (opts.screenshotDir && result.screenshot) {
      try { mkdirSync(opts.screenshotDir, { recursive: true }); screenshotPath = join(opts.screenshotDir, `${action.id}.jpg`); writeFileSync(screenshotPath, result.screenshot) } catch { /* 忽略截图落盘失败 */ }
    }
    const rawSummary: ApplyRunSummary = {
      status: result.status, reason: result.reason, message: result.message, finalUrl: result.finalUrl, adapter: result.adapterId,
      filled: result.filled, needsUser: result.needsUser, drafts: result.drafts, mismatches: result.mismatches, uploads: result.uploads, submitButton: result.submitButton, loginFilled: result.loginFilled, screenshotPath,
      fields: result.fields, blockers: result.blockers, entryClicked: result.entryClicked, telemetry: result.telemetry,
      pages: result.pages.map(p => ({ index: p.index, url: p.url, fieldCount: p.fieldCount, nextButton: p.nextButton, errors: p.errors })),
    }
    // 落库 / 回传的一律脱敏：私密库里的明文换回占位符
    const summary = vault ? vault.redactDeep(rawSummary) : rawSummary
    const answersUsed = Object.fromEntries(summary.filled.map(f => [f.label, f.value]))
    let submitAction: ActionQueueItem | undefined
    let handoff: Handoff | undefined
    let to: ApplicationStage = 'pending'
    let note = result.message

    if (result.status === 'stopped_before_submit') {
      this.repos.setActionStatus(action.id, 'done', summary)
      // 永远不自动提交：submit 进待审核
      submitAction = this.repos.enqueueAction('submit', { url: result.finalUrl, submitButton: result.submitButton, summary: { filled: result.filled.length, needsUser: result.needsUser.length, drafts: result.drafts.length, mismatches: result.mismatches.length, uploads: result.uploads }, screenshotPath }, applicationId)
      if (result.needsUser.length || result.drafts.length || result.mismatches.length) {
        to = 'needs_user'
        const parts = [result.needsUser.length ? `需要你补充 ${result.needsUser.length} 项：${result.needsUser.map(p => p.label).join('、')}` : '', result.drafts.length ? `有 ${result.drafts.length} 条草稿待确认` : '', result.mismatches.length ? `${result.mismatches.length} 个字段核对不一致` : ''].filter(Boolean)
        note = parts.join('；')
        handoff = this.repos.openHandoff('missing_info', { actionId: submitAction.id, taskId: opts.taskId ?? null, message: note })
      }
    } else if (result.status === 'handoff') {
      handoff = this.repos.openHandoff(result.reason ?? 'user_request', { actionId: action.id, taskId: opts.taskId ?? null, message: result.message })
      this.repos.setActionStatus(action.id, 'needs_user', summary)
      to = 'needs_user'
    } else {
      this.repos.setActionStatus(action.id, 'failed', summary)
      to = 'blocked'
    }
    const patch = {
      page_url: result.finalUrl, answers_used_json: JSON.stringify(answersUsed),
      blocker_reason: to === 'pending' ? null : `${result.reason ?? result.status}: ${note}`,
      next_action: to === 'pending' ? '审核后提交' : to === 'needs_user' ? '处理接管后继续' : '查看阻塞原因后重试',
    }
    // 仍停在 pending（等审核提交）时不是一次阶段流转，只更新字段
    if (to === 'pending') this.repos.db.update('application', applicationId, { ...patch, updated_at: new Date().toISOString() })
    else this.repos.transition(applicationId, to, note, patch)
    const application = this.repos.getApplication(applicationId)!
    return { result, summary, action: this.repos.getAction(action.id)!, submitAction, handoff, application, screenshotPath }
  }
}
