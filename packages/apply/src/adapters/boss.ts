import type { SiteAdapter } from './types.js'
import { hostOf } from './types.js'

/**
 * Boss 直聘（zhipin.com）。这里没有"网申表单"，主要动作是打招呼（由 greeting.ts 做决策、发送永远过人）。
 * 适配器只提供风控指示词与"立即沟通/继续沟通"这类不能自动点的按钮词。
 * 【未在真实登录态下验证】：风控文案随版本变化，命中即停止是保守策略。
 */
export const boss: SiteAdapter = {
  id: 'boss',
  match: url => /zhipin\.com/.test(hostOf(url)),
  hints: {
    nextButton: [],
    submitWords: ['立即沟通', '继续沟通', '发送', '投递简历', '发送简历'],
    loginIndicators: ['请先登录', '扫码登录', '登录/注册', '手机号登录', '账号登录'],
    captchaIndicators: ['安全验证', '拖动滑块', '滑动验证', '请完成验证', '当前IP地址可能存在异常访问行为', '访问频繁', '操作频繁'],
    fieldAliases: {},
  },
}
