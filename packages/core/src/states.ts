/** 所有状态枚举集中定义：投递阶段、动作队列、任务、接管。 */

export const APPLICATION_STAGES = [
  'evaluated', 'ready', 'approved', 'applied', 'responded', 'interview', 'offer',
  'rejected', 'discarded', 'skip', 'hired', 'blocked', 'needs_user', 'pending',
] as const
export type ApplicationStage = typeof APPLICATION_STAGES[number]

/** 允许的阶段流转（from → to[]）。审核态 ready/approved 来自采集评分链；执行态 blocked/needs_user/pending 来自网申链。 */
export const STAGE_TRANSITIONS: Record<ApplicationStage, readonly ApplicationStage[]> = {
  evaluated: ['ready', 'skip', 'discarded'],
  ready: ['approved', 'skip', 'discarded'],
  approved: ['pending', 'applied', 'blocked', 'needs_user', 'skip'],
  pending: ['applied', 'blocked', 'needs_user', 'skip'],
  blocked: ['pending', 'approved', 'skip', 'discarded'],
  needs_user: ['pending', 'applied', 'skip'],
  applied: ['responded', 'interview', 'rejected', 'discarded'],
  responded: ['interview', 'rejected', 'discarded'],
  interview: ['interview', 'offer', 'rejected', 'discarded'],
  offer: ['hired', 'rejected', 'discarded'],
  rejected: [], discarded: [], skip: ['evaluated'], hired: [],
}
export function canTransition(from: ApplicationStage, to: ApplicationStage): boolean {
  return (STAGE_TRANSITIONS[from] ?? []).includes(to)
}
/** 沿状态机能否从 from 走到 to（to 在 from 前方）。相同阶段返回 false；状态机没有回退边，所以「已在面试再收到笔试」= false。 */
export function canReachStage(from: ApplicationStage, to: ApplicationStage): boolean {
  if (from === to) return false
  const seen = new Set<ApplicationStage>([from])
  const queue: ApplicationStage[] = [from]
  while (queue.length) {
    const cur = queue.shift()!
    for (const next of STAGE_TRANSITIONS[cur] ?? []) {
      if (next === to) return true
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return false
}

export const ACTION_KINDS = ['fill_form', 'submit', 'send_greeting', 'upload', 'answer_open_q', 'collect', 'research', 'send_mail'] as const
export type ActionKind = typeof ACTION_KINDS[number]
/** 这些动作永远需要用户审核后才能执行（提交 / 发送永远过人）。 */
export const ACTIONS_REQUIRING_REVIEW: readonly ActionKind[] = ['submit', 'send_greeting', 'answer_open_q', 'send_mail']

export const ACTION_STATUSES = ['pending_review', 'approved', 'executing', 'needs_user', 'done', 'failed', 'rejected'] as const
export type ActionStatus = typeof ACTION_STATUSES[number]

export const TASK_STATUSES = ['queued', 'running', 'paused', 'needs_user', 'done', 'failed', 'cancelled'] as const
export type TaskStatus = typeof TASK_STATUSES[number]

export const HANDOFF_REASONS = ['captcha', 'login', '2fa', 'assessment', 'submit_confirm', 'missing_info', 'user_request'] as const
export type HandoffReason = typeof HANDOFF_REASONS[number]

/** 浏览器接管状态机：running → paused(reason) → human_active → resuming → running */
export const BROWSER_CONTROL_STATES = ['idle', 'running', 'paused', 'human_active', 'resuming'] as const
export type BrowserControlState = typeof BROWSER_CONTROL_STATES[number]
export const BROWSER_CONTROL_TRANSITIONS: Record<BrowserControlState, readonly BrowserControlState[]> = {
  idle: ['running'],
  running: ['paused', 'idle'],
  paused: ['human_active', 'resuming', 'idle'],
  human_active: ['resuming', 'idle'],
  resuming: ['running', 'idle'],
}

export const CLAIM_STATUSES = ['verified', 'pending', 'user_confirmed'] as const
export const CLAIM_ATTRIBUTIONS = ['self', 'team', 'unknown'] as const
export const EVIDENCE_STRENGTHS = ['strong', 'mid', 'weak'] as const
export const INTERVIEW_RESULTS = ['none', 'rejected', 'advanced', 'no_feedback_inferred'] as const
export const INTERVIEW_RESULT_SOURCES = ['none', 'official', 'inferred'] as const

// ===== 五个面（收件箱 / 今日 / 卷宗 / 素材 / 复盘）用到的枚举 =====
export const INBOX_SOURCES = ['paste', 'mail', 'file', 'url', 'chat'] as const
export type InboxSource = typeof INBOX_SOURCES[number]
export const INBOX_KINDS = ['jd', 'interview_invite', 'assessment', 'written_test', 'rejection', 'offer', 'referral', 'deadline', 'other'] as const
export type InboxKind = typeof INBOX_KINDS[number]
export const INBOX_STATUSES = ['new', 'processed', 'dismissed'] as const
export type InboxStatus = typeof INBOX_STATUSES[number]

export const DEADLINE_KINDS = ['assessment', 'written_test', 'interview', 'application_deadline', 'offer_reply', 'referral_expiry', 'other'] as const
export type DeadlineKind = typeof DEADLINE_KINDS[number]
export const DEADLINE_STATUSES = ['open', 'done', 'missed', 'cancelled'] as const
export type DeadlineStatus = typeof DEADLINE_STATUSES[number]

export const DOSSIER_NOTE_KINDS = ['note', 'said', 'heard', 'contact', 'referral', 'mail'] as const
export type DossierNoteKind = typeof DOSSIER_NOTE_KINDS[number]

export const MATERIAL_KINDS = ['open_question', 'project_story', 'self_intro', 'why_company', 'why_role', 'strength_weakness', 'career_plan', 'other'] as const
export type MaterialKind = typeof MATERIAL_KINDS[number]

export const MAIL_PROVIDERS = ['qq', '163', '126', 'gmail', 'outlook', 'imap'] as const
export type MailProvider = typeof MAIL_PROVIDERS[number]

/** 投递静默判定：某阶段停留超过 N 天且没有任何新事件，视为"可关闭的静默"。 */
export const SILENCE_DAYS: Partial<Record<ApplicationStage, number>> = { applied: 21, responded: 14, interview: 14, pending: 7 }
