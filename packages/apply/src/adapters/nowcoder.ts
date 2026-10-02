import type { SiteAdapter } from './types.js'
import { hostOf } from './types.js'

/**
 * 牛客（nowcoder.com）：校招网申托管（*.nowcoder.com/careers、job.nowcoder.com）。
 * 表单分步较多，"保存"与"提交"按钮并存。
 * 【未在真实登录态下验证】。
 */
export const nowcoder: SiteAdapter = {
  id: 'nowcoder',
  match: url => /nowcoder\.com/.test(hostOf(url)),
  hints: {
    nextButton: ['下一步', '保存并下一步', '继续'],
    submitWords: ['提交', '提交简历', '确认提交', '投递'],
    loginIndicators: ['请先登录', '登录牛客', '手机号登录', '扫码登录'],
    captchaIndicators: ['拖动滑块', '滑动验证', '安全验证', '请完成验证'],
    fieldAliases: {
      name: ['姓名'],
      phone: ['手机号', '手机'],
      email: ['邮箱'],
      school: ['学校', '毕业院校'],
      major: ['专业'],
      degree: ['学历'],
      graduation: ['毕业时间', '毕业年份'],
      city: ['期望城市', '意向城市'],
    },
  },
}
