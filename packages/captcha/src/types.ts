import type { LLM } from '@career/core'

/** 验证码种类（与 @career/apply obstacles.ts 的分类保持兼容，独立维护避免包环）。 */
export type CaptchaKind = 'slider' | 'rotation' | 'image_click' | 'image_text' | 'browser_check' | 'sms' | 'unknown'

/** 能识别的验证码厂商（决定选择器与核验方式）。 */
export type CaptchaVendor =
  | 'geetest'    // 极验
  | 'yidun'      // 网易易盾
  | 'tencent'    // 腾讯防水墙 / TCaptcha
  | 'hcaptcha'
  | 'recaptcha'
  | 'turnstile'  // Cloudflare Turnstile
  | 'aliyun'     // 阿里云验证码
  | 'unknown'

/** CDP 会话最小接口：shell 侧由 playwright-core 的 CDPSession 适配，测试用 FakeCdp。 */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
}

/** 视口 CSS 像素矩形。 */
export interface CaptchaRect { x: number; y: number; width: number; height: number }

/**
 * CaptchaPage：求解器只依赖这个最小接口（契约 §25——浏览器代码不自己启动浏览器）。
 * 真实实现由 shell 的 browser-host 适配 playwright-core 的 Page；测试用内存假页。
 */
export interface CaptchaPage {
  url(): string
  /** 在页面主世界执行 JS 表达式 / IIFE，返回 JSON 可序列化结果（TMWebDriver execute_js 的同款语义）。 */
  evalJson<T>(expr: string): Promise<T>
  /** 全页截图（PNG 字节）。 */
  screenshot(): Promise<Uint8Array>
  /** 页面级 CDP 会话；为 null 表示没有可信输入通道，求解器返回 needs_cdp。 */
  cdp(): CdpSessionLike | null
  viewport(): Promise<{ width: number; height: number } | null>
  waitForTimeout(ms: number): Promise<void>
}

/** detectCaptcha 的产出：识别到验证码时的定位与题面。 */
export interface CaptchaTarget {
  kind: CaptchaKind
  vendor: CaptchaVendor
  /** 验证码主容器（视口 CSS 像素）；点选 / 滑块的主交互区。 */
  rect?: CaptchaRect
  /** 题面文本（点选顺序、图选类别），读得到就带上。 */
  prompt?: string
}

export type SolveOutcome =
  | 'passed'      // 已通过（页面验证码消失 / 成功标志出现）
  | 'failed'      // 试过了没过（预算内）
  | 'needs_cdp'   // 页面没有可信输入通道，求解不了
  | 'unsupported' // 该种类不支持自动求解（如短信），留给人工
  | 'budget'      // 策略预算用尽

export interface SolveResult {
  outcome: SolveOutcome
  detail: string
  /** 实际做出的尝试次数（点击 / 拖动轮数）。 */
  attempts: number
}

export interface SolverDeps {
  page: CaptchaPage
  llm: LLM
  sleep?: (ms: number) => Promise<void>
  /** [0,1) 随机源；注入用。缺省 Math.random。 */
  rand?: () => number
  /** 单次求解里同一种验证码最多试几轮；缺省 2。 */
  maxAttempts?: number
}
