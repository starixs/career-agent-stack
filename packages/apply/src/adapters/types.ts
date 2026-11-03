import type { PageLike } from '../page.js'

/**
 * 站点适配器：只提供"提示"（按钮词、登录/验证码指示词、字段别名、可选的预处理），
 * 引擎本身是通用的。国内站的 selector / 文案只能按公开页面结构尽力写，
 * 均【未在真实登录态下验证】。
 */
export interface SiteAdapterHints {
  /** "下一步"类按钮文案（优先于通用正则）。 */
  nextButton?: string[]
  /** 该站提交按钮文案（追加到 SUBMIT 守卫）。 */
  submitWords?: string[]
  /** 登录墙指示词（页面文本包含即视为需要登录）。 */
  loginIndicators?: string[]
  /** 验证码 / 滑块指示词。 */
  captchaIndicators?: string[]
  /** 字段别名：profile 键 → 该站常见 label 写法。 */
  fieldAliases?: Record<string, string[]>
  /**
   * 这个站的岗位详情页上，这些按钮只是打开网申表（要登录、要填表），不是一键投递。
   * 只在页面上还没有表单字段、本次也没填过东西时当入口点；表单页上的同名按钮仍是最终提交，永远不点。
   */
  detailEntryWords?: string[]
  /** 岗位详情链接的 href 样子（从首页 / 列表页挑岗位时只认这种链接）。 */
  positionLink?: RegExp
}

export interface SiteAdapter {
  id: string
  match(url: string): boolean
  hints: SiteAdapterHints
  /** 进入表单前的预处理（关闭弹窗、切到表单 tab 等）。失败不应抛出。 */
  preprocess?(page: PageLike): Promise<void>
  /** 站内岗位搜索的网址（首页 / 合集页 → 搜关键词）；认不出这个站的网址结构就返回 null。 */
  positionSearchUrl?(url: string, keyword: string): string | null
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return url.toLowerCase() }
}
