import { describe, expect, it } from 'vitest'
import {
  Db, PRICING_TEMPLATE, Repos, asrCredits, countBusinessEvents, recordBusinessEvent, backgroundScope, billingSummary, buildPriceList, canonicalizeModelName, ceilCredits,
  checkin, creditsFromCents, deductCredits, ensureAccount, grantCredits, isFallbackPriced, listTransactions, rawLlmCredits,
  recordLlmUsage, recordToolUsage, toolCogsMicroUsd, toolCredits, type PricingTemplate,
} from '../src/index.js'

function mem(): Db { const db = new Db(':memory:'); db.migrate(); return db }
const noGrant: PricingTemplate = { ...PRICING_TEMPLATE, signupGrantCredits: 0 }

describe('价目：与 Star AI 同口径', () => {
  it('内置模型的各种写法都归到 deepseek-v4-flash，不跌进兜底价', () => {
    for (const n of ['deepseek-flash', 'DeepSeek-Chat', 'deepseek:deepseek-v4-flash', 'deepseek-v4-flash-2026-01-23', 'deepseek-reasoner']) {
      expect(canonicalizeModelName(n)).toBe('deepseek-v4-flash')
      expect(isFallbackPriced(n)).toBe(false)
    }
    expect(isFallbackPriced('some-new-model')).toBe(true)
    expect(isFallbackPriced('constructor')).toBe(true)
  })

  it('输入不含缓存：缓存命中按缓存价单算', () => {
    // flash：5 / 10 / 0.1 每百万；100 万输入 + 100 万输出 + 1000 万缓存 = 5 + 10 + 1 = 16，毛利 7 倍 = 112
    expect(rawLlmCredits('deepseek-flash', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e7 }, 7)).toBeCloseTo(112, 9)
    // 写缓存按普通输入
    expect(rawLlmCredits('deepseek-flash', { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1e6 })).toBeCloseTo(5, 9)
  })

  it('取整前抹浮点误差，0.1×10 不会多收 1 积分', () => {
    let raw = 0
    for (let i = 0; i < 10; i++) raw += 0.1
    expect(ceilCredits(raw)).toBe(1)
    expect(ceilCredits(1.0000001)).toBe(2)
  })

  it('搜索按次 1 积分；没登记的工具返回 undefined 而不是 0', () => {
    expect(toolCredits('search:bocha')).toBe(1)
    // 内置模型 Key 走的 DeepSeek 搜索是默认路径：必须有价目，不能落成「未定价」；成本按官方 ¥5 / 千次
    expect(toolCredits('search:deepseek')).toBe(1)
    expect(toolCogsMicroUsd('search:deepseek')).toBe(714)
    expect(toolCredits('web_fetch')).toBe(0)
    expect(toolCredits('brand_new_tool')).toBeUndefined()
    expect(toolCredits('toString')).toBeUndefined()
  })

  it('语音：免费时长内不扣，超过按整段计、至少 1', () => {
    expect(asrCredits(null)).toBe(0)
    expect(asrCredits(180_000)).toBe(0)
    expect(asrCredits(181_000)).toBe(1)
    expect(asrCredits(60 * 60_000)).toBe(12)
  })
})

describe('账本', () => {
  it('第一次开户送开户积分，只送一次', () => {
    const db = mem()
    expect(ensureAccount(db).credits).toBe(PRICING_TEMPLATE.signupGrantCredits)
    expect(ensureAccount(db).credits).toBe(PRICING_TEMPLATE.signupGrantCredits)
    expect(listTransactions(db).filter(t => t.source_type === 'signup')).toHaveLength(1)
  })

  it('先扣限时积分再扣永久；不够扣到 0 并记缺口', () => {
    const db = mem()
    ensureAccount(db, noGrant)
    grantCredits(db, 10, { sourceType: 'topup', idempotencyKey: 't1' })
    grantCredits(db, 5, { sourceType: 'subscription', idempotencyKey: 's1' }, { bucket: 'subscription', expiresAt: '2099-01-01T00:00:00Z' })
    const r = deductCredits(db, 20, { sourceType: 'llm_usage', idempotencyKey: 'd1' })
    expect(r.account.subscription_credits).toBe(0)
    expect(r.account.credits).toBe(0)
    expect(r.txn.amount).toBe(-15)
    expect(JSON.parse(r.txn.extra_json)).toMatchObject({ from_subscription: 5, from_permanent: 10, shortfall: 5 })
  })

  it('同一幂等键重放不重复扣', () => {
    const db = mem()
    ensureAccount(db, noGrant)
    grantCredits(db, 10, { sourceType: 'topup', idempotencyKey: 't1' })
    expect(deductCredits(db, 3, { sourceType: 'x', idempotencyKey: 'k' }).created).toBe(true)
    const again = deductCredits(db, 3, { sourceType: 'x', idempotencyKey: 'k' })
    expect(again.created).toBe(false)
    expect(again.account.credits).toBe(7)
  })

  it('套餐积分到期清零并留一笔流水', () => {
    const db = mem()
    ensureAccount(db, noGrant)
    grantCredits(db, 9, { sourceType: 'subscription', idempotencyKey: 's1' }, { bucket: 'subscription', expiresAt: '2000-01-01T00:00:00Z' })
    expect(ensureAccount(db).subscription_credits).toBe(0)
    expect(listTransactions(db)[0]).toMatchObject({ type: 'admin_adjust', amount: -9, source_type: 'subscription' })
  })

  it('签到一天一次', () => {
    const db = mem()
    const day = new Date(2026, 10, 5, 9)
    expect(checkin(db, day).granted).toBe(true)
    expect(checkin(db, day).granted).toBe(false)
    expect(checkin(db, new Date(2026, 10, 6, 9)).granted).toBe(true)
  })
})

describe('用量记账', () => {
  const turn = (i: number) => ({ idempotencyKey: `chat:s1:${i}`, scope: 'chat:s1', origin: 'chat' as const, model: 'deepseek-flash', inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 50_000 })

  it('会话内累计后再取整：逐轮零点几积分不会被放大', () => {
    const db = mem()
    // 每轮 (1万×5 + 1千×10 + 5万×0.1)/1e6 × 7 = 0.455 积分；10 轮精确 4.55 → 实扣 5，不是逐轮取整的 10
    let charged = 0
    for (let i = 0; i < 10; i++) charged += recordLlmUsage(db, turn(i)).creditsCharged
    expect(charged).toBe(5)
    expect(ensureAccount(db).credits).toBe(PRICING_TEMPLATE.signupGrantCredits - 5)
  })

  it('同一轮重报只记一次', () => {
    const db = mem()
    expect(recordLlmUsage(db, turn(0)).recorded).toBe(true)
    expect(recordLlmUsage(db, turn(0)).recorded).toBe(false)
    expect(db.all('SELECT * FROM billing_usage')).toHaveLength(1)
  })

  it('没定价的工具也落一行（priced=0），不扣钱但看得见', () => {
    const db = mem()
    const r = recordToolUsage(db, { idempotencyKey: 'tool:1', scope: backgroundScope(), tool: 'brand_new_tool' })
    expect(r).toMatchObject({ recorded: true, creditsCharged: 0, unpriced: true })
    const s = recordToolUsage(db, { idempotencyKey: 'tool:2', scope: backgroundScope(), tool: 'search:bocha', count: 3 })
    expect(s.creditsCharged).toBe(3)
  })

  it('汇总按来源和名字分组', () => {
    const db = mem()
    recordLlmUsage(db, turn(0))
    recordToolUsage(db, { idempotencyKey: 'tool:1', scope: 'chat:s1', tool: 'search:tavily' })
    const s = billingSummary(db)
    expect(s.buckets.map(b => `${b.origin}/${b.name}`).sort()).toEqual(['chat/deepseek-v4-flash', 'tool/search:tavily'])
    expect(s.spentInWindow).toBeGreaterThan(0)
    expect(s.balance).toBe(s.account.credits + s.account.subscription_credits)
  })
})

describe('场景卖点', () => {
  function withApp() {
    const repos = new Repos(mem())
    repos.db.insert('job', { id: 'job_1', title: '后端开发', company_name: '美团', source_platform: 'official', created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z' })
    const app = repos.createApplication('job_1')
    return { repos, app }
  }

  it('动作做完按种类记：提交 / 邮件投递 = 替你投出，填表 = 填好网申表；同一动作重复标 done 只记一次', () => {
    const { repos, app } = withApp()
    const fill = repos.enqueueAction('fill_form', { a: 1 }, app.id, true)
    const submit = repos.enqueueAction('submit', { a: 1 }, app.id, true)
    const mail = repos.enqueueAction('send_mail', { to: 'hr@x.com' }, app.id, true)
    const research = repos.enqueueAction('research', {}, app.id, true)
    for (const a of [fill, submit, mail, research]) repos.setActionStatus(a.id, 'done')
    repos.setActionStatus(submit.id, 'done')
    repos.setActionStatus(fill.id, 'executing')
    const counts = Object.fromEntries(countBusinessEvents(repos.db, '2000-01-01').map(e => [e.event, e.count]))
    expect(counts).toEqual({ application_sent: 2, form_filled: 1 })
  })

  it('同一幂等键只记一次；汇总和清单都带上卖点', () => {
    const db = mem()
    expect(recordBusinessEvent(db, { event: 'resume_tailored', key: 'tool:resume_tailor:t1' })).toBe(true)
    expect(recordBusinessEvent(db, { event: 'resume_tailored', key: 'tool:resume_tailor:t1' })).toBe(false)
    recordBusinessEvent(db, { event: 'exam_answered', key: 'exam:s1:5', quantity: 5 })
    expect(billingSummary(db).events).toEqual([
      { event: 'exam_answered', label: '笔试搜题', unit: '道', count: 5 },
      { event: 'resume_tailored', label: '按岗位定制简历', unit: '份', count: 1 },
    ])
    expect(buildPriceList().events.map(e => e.event)).toContain('application_sent')
  })
})

describe('计费清单', () => {
  it('从模板推导：面值、毛利后的单价、充值包积分数', () => {
    const list = buildPriceList()
    expect(creditsFromCents(1000)).toBe(50)
    expect(list.models.find(m => m.model === 'deepseek-v4-flash')).toMatchObject({ label: '内置模型', inputPerMillion: 35, outputPerMillion: 70, cachePerMillion: 0.7 })
    expect(list.topupPackages.map(p => p.credits)).toEqual([50, 150, 250, 500])
    expect(list.plans.find(p => p.id === 'season_quarterly')?.discount).toBeCloseTo(9900 / 11700, 4)
  })
})
