/**
 * 定价配置：积分本位、毛利倍数、赠送、套餐、充值包，以及由它们推出来的「计费清单」。
 *
 * 结构照 Star AI `app/core/pricing_config.py` 的 PAYMENT_PRICING_TEMPLATE：只在模板里手填一次，
 * 套餐折扣、充值包积分数都由模板推导，不在多处各写一份。
 * 现在这份是本机默认值；云端账户上线后以云端下发的为准（docs/SERVER-API.md「计费」），本机这份退成估算。
 */
import { ASR_PRICING, MODEL_PRICING, PRICING_TABLE_ANCHOR, TOOL_PRICING } from './pricing.js'
import { BILLABLE_EVENTS } from './events.js'

export const PRICING_VERSION = 1

export type BillingPeriod = 'month' | 'quarter'

export interface PlanTemplate {
  id: string
  name: string
  tier: string
  billingPeriod: BillingPeriod
  priceCents: number
  /** 划线价；没有就不显示折扣 */
  originalPriceCents: number | null
  /** 当期发放的限时积分（进 subscription_credits，到期清零） */
  creditsGranted: number
  badge: string | null
  /** 只写系统里真实存在的权益 */
  features: string[]
}

export interface PricingTemplate {
  /** 1 积分的面值，单位分。20 = ¥0.2，即 1 元 = 5 积分。改它要同时改 pricing.ts 的 MODEL_PRICING */
  creditUnitPriceCents: number
  /** 模型 token 的加价倍数：实扣 = 厂商成本价 × 本倍数。1 = 成本透传 */
  llmMarginMultiplier: number
  /** 第一次开账时送的永久积分 */
  signupGrantCredits: number
  /** 每日签到送的永久积分，按会员档 */
  checkinDailyCredits: Record<string, number>
  /** 充值页最低充值金额，单位分 */
  minimumTopupCents: number
  /** 快捷充值档，单位分；积分数由面值推导 */
  topupAmountsCents: number[]
  plans: PlanTemplate[]
}

/**
 * 数值来由：
 *  - creditUnitPriceCents / llmMarginMultiplier：与 Star AI 现行值相同（¥0.2、7 倍）。
 *  - signupGrantCredits：Star AI 注册送 ¥10 面值，这里同面值 = 50 积分。
 *  - 套餐、充值档、签到额度：〔推〕按学生价位起的草稿，等记账数据出来再定，见 docs/BILLING.md。
 */
export const PRICING_TEMPLATE: PricingTemplate = {
  creditUnitPriceCents: 20,
  llmMarginMultiplier: 7,
  signupGrantCredits: 50,
  checkinDailyCredits: { free: 2, sprint: 5, season: 5 },
  minimumTopupCents: 1000,
  topupAmountsCents: [1000, 3000, 5000, 10000],
  plans: [
    {
      id: 'sprint_monthly', name: '冲刺月卡', tier: 'sprint', billingPeriod: 'month',
      priceCents: 3900, originalPriceCents: null, creditsGranted: 250, badge: null,
      features: ['每月 250 积分', '每日签到 +5 积分'],
    },
    {
      id: 'season_quarterly', name: '秋招季卡', tier: 'season', billingPeriod: 'quarter',
      priceCents: 9900, originalPriceCents: 3900 * 3, creditsGranted: 900, badge: '整季最省',
      features: ['一季 900 积分', '每日签到 +5 积分'],
    },
  ],
}

const CENTS_PER_YUAN = 100

function unitPriceCents(template: PricingTemplate): number {
  if (!(template.creditUnitPriceCents > 0)) throw new Error(`定价模板的 creditUnitPriceCents 必须为正，现在是 ${template.creditUnitPriceCents}`)
  return template.creditUnitPriceCents
}

/** 金额（分）按面值能换多少积分。 */
export function creditsFromCents(cents: number, template: PricingTemplate = PRICING_TEMPLATE): number {
  return Math.floor(cents / unitPriceCents(template))
}

/** 积分的面值，单位元。 */
export function creditsToYuan(credits: number, template: PricingTemplate = PRICING_TEMPLATE): number {
  return (credits * unitPriceCents(template)) / CENTS_PER_YUAN
}

export interface Plan extends PlanTemplate {
  pricingVersion: number
  /** 实付 / 划线价；没有划线价为 1 */
  discount: number
  /** 每积分实付多少分：比面值低多少一眼可比 */
  centsPerCredit: number
}

export function buildPlans(template: PricingTemplate = PRICING_TEMPLATE): Plan[] {
  return template.plans.map(p => ({
    ...p,
    features: [...p.features],
    pricingVersion: PRICING_VERSION,
    discount: p.originalPriceCents && p.originalPriceCents > 0 ? Number((p.priceCents / p.originalPriceCents).toFixed(4)) : 1,
    centsPerCredit: p.creditsGranted > 0 ? Number((p.priceCents / p.creditsGranted).toFixed(2)) : 0,
  }))
}

export interface TopupPackage { id: string; pricingVersion: number; credits: number; priceCents: number }

export function buildTopupPackages(template: PricingTemplate = PRICING_TEMPLATE): TopupPackage[] {
  return template.topupAmountsCents.map(cents => {
    const credits = creditsFromCents(cents, template)
    return { id: `credits_topup_${credits}`, pricingVersion: PRICING_VERSION, credits, priceCents: cents }
  })
}

export function checkinCredits(tier: string, template: PricingTemplate = PRICING_TEMPLATE): number {
  return Object.hasOwn(template.checkinDailyCredits, tier) ? template.checkinDailyCredits[tier] ?? 0 : template.checkinDailyCredits.free ?? 0
}

/** 内置模型对外的叫法：不在界面上露底层模型 id（立场 4：用户端没有模型设置）。 */
const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': '内置模型',
  'deepseek-v4-pro': '内置模型 · 高档',
}

export interface ModelPriceRow {
  model: string
  label: string
  /** 加过毛利之后，每百万 token 实扣的积分 */
  inputPerMillion: number
  outputPerMillion: number
  cachePerMillion: number
}
export interface ToolPriceRow { tool: string; label: string; credits: number; note: string }

/** 计费清单：界面、文档、云端对表都读这一份，不各自抄数。 */
export interface PriceList {
  anchor: string
  pricingVersion: number
  creditUnitPriceCents: number
  llmMarginMultiplier: number
  models: ModelPriceRow[]
  tools: ToolPriceRow[]
  asr: { freeSeconds: number; creditsPerMinute: number }
  signupGrantCredits: number
  checkinDailyCredits: Record<string, number>
  plans: Plan[]
  topupPackages: TopupPackage[]
  /** 候选卖点目录（现在只记数、不计价） */
  events: Array<{ event: string; label: string; unit: string; when: string }>
}

export function buildPriceList(template: PricingTemplate = PRICING_TEMPLATE): PriceList {
  const margin = template.llmMarginMultiplier
  const scaled = (n: number): number => Number((n * margin).toFixed(4))
  return {
    anchor: PRICING_TABLE_ANCHOR,
    pricingVersion: PRICING_VERSION,
    creditUnitPriceCents: unitPriceCents(template),
    llmMarginMultiplier: margin,
    models: Object.entries(MODEL_PRICING).map(([model, p]) => ({
      model, label: MODEL_DISPLAY_NAMES[model] ?? model,
      inputPerMillion: scaled(p.input), outputPerMillion: scaled(p.output), cachePerMillion: scaled(p.cache),
    })),
    tools: Object.entries(TOOL_PRICING).map(([tool, p]) => ({ tool, label: p.label, credits: p.credits, note: p.note })),
    asr: { ...ASR_PRICING },
    signupGrantCredits: template.signupGrantCredits,
    checkinDailyCredits: { ...template.checkinDailyCredits },
    plans: buildPlans(template),
    topupPackages: buildTopupPackages(template),
    events: Object.entries(BILLABLE_EVENTS).map(([event, d]) => ({ event, label: d.label, unit: d.unit, when: d.when })),
  }
}
