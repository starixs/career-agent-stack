import { type Repos, type LLM, type Application, type ActionQueueItem, type Handoff, type ApplicationStage, canTransition } from '@career/core'
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
  result: DriveResult
  action: ActionQueueItem
  submitAction?: ActionQueueItem
  handoff?: Handoff
  application: Application
  screenshotPath?: string
}

export class ApplyService {
  constructor(private repos: Repos, private llm: LLM, private defaults: { adapters?: readonly SiteAdapter[]; maxPages?: number } = {}) {}

  /** 从 Repos 组装 Profile 的默认实现（basics 来自 kv:profile.basics，经历来自经历库，答案库来自 answer_bank）。 */
  buildProfile(resumePath?: string): Profile {
    const basics = this.repos.kvGet<Record<string, string>>('profile.basics') ?? {}
    const experiences = this.repos.experienceTree().map(e => ({ title: e.title, org: e.org ?? undefined, role: e.role ?? undefined, period: [e.start_date, e.end_date].filter(Boolean).join('~') || undefined, claims: e.claims.filter(c => c.status !== 'pending').map(c => c.text) }))
    const answerBank = this.repos.db.all<{ question_key: string; question_text: string; answer: string; high_impact: number; confirmed: number }>('SELECT question_key, question_text, answer, high_impact, confirmed FROM answer_bank ORDER BY confirmed DESC, updated_at DESC')
      .map(a => ({ question_key: a.question_key, question_text: a.question_text, answer: a.answer, high_impact: !!a.high_impact, confirmed: !!a.confirmed }))
    return { basics, experiences, answerBank, resumePath }
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
    this.repos.setActionStatus(action.id, 'executing')

    const result = await driveApplication(page, this.llm, profile, {
      ...opts, adapter, riskGuard, maxPages: opts.maxPages ?? this.defaults.maxPages,
      interpret: { ...opts.interpret, job: opts.interpret?.job ?? (job ? { title: job.title, company: job.company_name ?? undefined, jd: job.jd_raw ?? undefined } : undefined) },
    })
    let screenshotPath: string | undefined
    if (opts.screenshotDir && result.screenshot) {
      try { mkdirSync(opts.screenshotDir, { recursive: true }); screenshotPath = join(opts.screenshotDir, `${action.id}.jpg`); writeFileSync(screenshotPath, result.screenshot) } catch { /* 忽略截图落盘失败 */ }
    }
    const summary = {
      status: result.status, reason: result.reason, message: result.message, finalUrl: result.finalUrl, adapter: result.adapterId,
      filled: result.filled, needsUser: result.needsUser, drafts: result.drafts, mismatches: result.mismatches, uploads: result.uploads, submitButton: result.submitButton, screenshotPath,
      pages: result.pages.map(p => ({ index: p.index, url: p.url, fieldCount: p.fieldCount, nextButton: p.nextButton, errors: p.errors })),
    }
    const answersUsed = Object.fromEntries(result.filled.map(f => [f.label, f.value]))
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
    return { result, action: this.repos.getAction(action.id)!, submitAction, handoff, application, screenshotPath }
  }
}
