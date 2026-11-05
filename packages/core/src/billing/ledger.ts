/**
 * 积分账本（本机单账户）。扣减、发放、用量记账都在这里；口径照 Star AI 的 CreditRepository + 会话累加器：
 *  - 扣减先扣套餐限时积分、再扣永久积分；余额不够就扣到 0 为止，缺口记在 extra.shortfall，不抛错
 *    （活儿已经干完了，计费不能反过来打断它）。
 *  - 每笔增减都有幂等键，(account, key) 唯一；重放返回已有流水，不重复记。
 *  - 用量按 scope 累计精确成本，scope 内 ceil(累计) − 已扣 才是这次实扣，避免逐次取整多收。
 *
 * 现在只在本机记账、不拦截（还没有账号和充值）。云端账户上线后，同一批幂等键原样上报，云端为准。
 */
import { type Db, now } from '../db/db.js'
import { newId } from '../ids.js'
import { PRICING_TEMPLATE, type PricingTemplate } from './catalog.js'

export const LOCAL_ACCOUNT_ID = 'local'

export type CreditTxnType = 'earn' | 'spend' | 'refund' | 'admin_adjust'

export interface CreditAccount {
  id: string
  tier: string
  credits: number
  subscription_credits: number
  subscription_expires_at: string | null
  total_earned: number
  total_spent: number
  created_at: string
  updated_at: string
}

export interface CreditTransaction {
  id: string
  account_id: string
  type: CreditTxnType
  amount: number
  balance_after: number
  source_type: string | null
  source_id: string | null
  idempotency_key: string | null
  description: string | null
  extra_json: string
  created_at: string
}

export interface LedgerEntry {
  sourceType: string
  sourceId?: string | null
  idempotencyKey?: string | null
  description?: string
  extra?: Record<string, unknown>
}

export interface LedgerResult { created: boolean; txn: CreditTransaction; account: CreditAccount }

export const balanceOf = (a: Pick<CreditAccount, 'credits' | 'subscription_credits'>): number => a.credits + a.subscription_credits

/**
 * 写事务：用 BEGIN IMMEDIATE 先拿写锁。Global 与 Session 两个侧车共用一个库，
 * 普通 BEGIN 在读后升级写锁时会撞 SQLITE_BUSY（迁移也是这么做的）。可嵌套：已在事务里就直接跑。
 */
export function writeTx<T>(db: Db, fn: () => T): T {
  if (db.raw.isTransaction) return fn()
  db.raw.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.raw.exec('COMMIT')
    return r
  } catch (e) {
    db.raw.exec('ROLLBACK')
    throw e
  }
}

function readAccount(db: Db, accountId: string): CreditAccount | undefined {
  return db.get<CreditAccount>('SELECT * FROM credit_account WHERE id=?', [accountId])
}

function findTxn(db: Db, accountId: string, key: string | null | undefined): CreditTransaction | undefined {
  if (!key) return undefined
  return db.get<CreditTransaction>('SELECT * FROM credit_transaction WHERE account_id=? AND idempotency_key=?', [accountId, key])
}

function insertTxn(db: Db, account: CreditAccount, type: CreditTxnType, amount: number, entry: LedgerEntry, extra: Record<string, unknown>): CreditTransaction {
  const txn: CreditTransaction = {
    id: newId('ctx'), account_id: account.id, type, amount, balance_after: balanceOf(account),
    source_type: entry.sourceType, source_id: entry.sourceId ?? null, idempotency_key: entry.idempotencyKey ?? null,
    description: entry.description ?? null, extra_json: JSON.stringify(extra), created_at: account.updated_at,
  }
  db.insert('credit_transaction', { ...txn })
  return txn
}

function saveAccount(db: Db, a: CreditAccount): void {
  db.run('UPDATE credit_account SET tier=?, credits=?, subscription_credits=?, subscription_expires_at=?, total_earned=?, total_spent=?, updated_at=? WHERE id=?',
    [a.tier, a.credits, a.subscription_credits, a.subscription_expires_at, a.total_earned, a.total_spent, a.updated_at, a.id])
}

/** 过期的限时积分清零（读账户时顺手做，免得到期后还被当余额用）。 */
function expireSubscription(db: Db, a: CreditAccount, at: string): CreditAccount {
  if (!a.subscription_expires_at || a.subscription_expires_at > at || a.subscription_credits === 0) return a
  const expired = a.subscription_credits
  const next = { ...a, subscription_credits: 0, updated_at: at }
  saveAccount(db, next)
  insertTxn(db, next, 'admin_adjust', -expired, {
    sourceType: 'subscription', idempotencyKey: `expire:${a.subscription_expires_at}`, description: '套餐积分到期清零',
  }, { expired })
  return next
}

/** 取账户；第一次用时开户并送开户积分（幂等键 grant:signup，开过就不再送）。 */
export function ensureAccount(db: Db, template: PricingTemplate = PRICING_TEMPLATE, accountId = LOCAL_ACCOUNT_ID): CreditAccount {
  return writeTx(db, () => {
    const at = now()
    const existing = readAccount(db, accountId)
    if (existing) return expireSubscription(db, existing, at)
    db.insert('credit_account', { id: accountId, tier: 'free', credits: 0, subscription_credits: 0, total_earned: 0, total_spent: 0, created_at: at, updated_at: at })
    if (template.signupGrantCredits > 0) {
      grantCredits(db, template.signupGrantCredits, { sourceType: 'signup', idempotencyKey: 'grant:signup', description: '开户赠送' }, { accountId })
    }
    const opened = readAccount(db, accountId)
    if (!opened) throw new Error(`[billing] 开户后读不到账户 ${accountId}`)
    return opened
  })
}

/**
 * 扣积分：先扣限时、再扣永久；不够就扣到 0，缺口进 extra.shortfall。
 * 撞幂等键返回已有流水、created=false，调用方据此跳过后续副作用。
 */
export function deductCredits(db: Db, amount: number, entry: LedgerEntry, accountId = LOCAL_ACCOUNT_ID): LedgerResult {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`[billing] 扣减积分必须是非负整数，收到 ${amount}（${entry.sourceType}）`)
  return writeTx(db, () => {
    const current = ensureAccount(db, PRICING_TEMPLATE, accountId)
    const dup = findTxn(db, accountId, entry.idempotencyKey)
    if (dup) return { created: false, txn: dup, account: current }
    const fromSubscription = Math.min(amount, current.subscription_credits)
    const fromPermanent = Math.min(amount - fromSubscription, current.credits)
    const actual = fromSubscription + fromPermanent
    const account: CreditAccount = {
      ...current, subscription_credits: current.subscription_credits - fromSubscription, credits: current.credits - fromPermanent,
      total_spent: current.total_spent + actual, updated_at: now(),
    }
    saveAccount(db, account)
    const extra: Record<string, unknown> = { ...entry.extra, requested_amount: amount, actual_deducted: actual, from_subscription: fromSubscription, from_permanent: fromPermanent }
    if (amount > actual) extra.shortfall = amount - actual
    return { created: true, txn: insertTxn(db, account, 'spend', -actual, entry, extra), account }
  })
}

export interface GrantOptions {
  accountId?: string
  /** 进限时桶（套餐积分）还是永久桶；默认永久 */
  bucket?: 'permanent' | 'subscription'
  /** 限时桶的到期时间 */
  expiresAt?: string
  type?: Exclude<CreditTxnType, 'spend'>
}

/** 加积分（开户、签到、充值、套餐发放、退款、人工调整）。 */
export function grantCredits(db: Db, amount: number, entry: LedgerEntry, opts: GrantOptions = {}): LedgerResult {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`[billing] 发放积分必须是正整数，收到 ${amount}（${entry.sourceType}）`)
  const accountId = opts.accountId ?? LOCAL_ACCOUNT_ID
  return writeTx(db, () => {
    const current = readAccount(db, accountId) ?? ensureAccount(db, PRICING_TEMPLATE, accountId)
    const dup = findTxn(db, accountId, entry.idempotencyKey)
    if (dup) return { created: false, txn: dup, account: current }
    const toSubscription = opts.bucket === 'subscription'
    const account: CreditAccount = {
      ...current,
      credits: toSubscription ? current.credits : current.credits + amount,
      subscription_credits: toSubscription ? current.subscription_credits + amount : current.subscription_credits,
      subscription_expires_at: toSubscription ? opts.expiresAt ?? current.subscription_expires_at : current.subscription_expires_at,
      total_earned: current.total_earned + amount, updated_at: now(),
    }
    saveAccount(db, account)
    const extra = { ...entry.extra, bucket: toSubscription ? 'subscription' : 'permanent' }
    return { created: true, txn: insertTxn(db, account, opts.type ?? 'earn', amount, entry, extra), account }
  })
}

export function listTransactions(db: Db, opts: { limit?: number; offset?: number; accountId?: string } = {}): CreditTransaction[] {
  return db.all<CreditTransaction>('SELECT * FROM credit_transaction WHERE account_id=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
    [opts.accountId ?? LOCAL_ACCOUNT_ID, opts.limit ?? 50, opts.offset ?? 0])
}
