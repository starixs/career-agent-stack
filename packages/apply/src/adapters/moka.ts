import type { SiteAdapter } from './types.js'
import { hostOf } from './types.js'

/**
 * Moka（mokahr.com）：很多互联网公司的校招/社招入口（app.mokahr.com/campus_apply/…、*.jobs.mokahr.com）。
 * 单页长表单 + antd 控件（自定义下拉、级联）。
 * 【未在真实登录态下验证】。
 */
export const moka: SiteAdapter = {
  id: 'moka',
  match: url => /mokahr\.com/.test(hostOf(url)),
  hints: {
    nextButton: ['下一步', '继续', '保存并继续'],
    submitWords: ['提交', '提交申请', '立即申请', '确认提交'],
    loginIndicators: ['请先登录', '验证码登录', '手机号登录', '登录 / 注册'],
    captchaIndicators: ['拖动滑块', '滑动验证', '安全验证', '图形验证码'],
    fieldAliases: {
      name: ['姓名', '中文姓名'],
      phone: ['手机号', '手机号码', '电话'],
      email: ['邮箱', '电子邮箱'],
      school: ['学校', '毕业学校', '院校'],
      major: ['专业'],
      degree: ['学历', '学位'],
      graduation: ['毕业时间', '毕业年份'],
      city: ['期望城市', '工作城市', '意向城市'],
      wechat: ['微信号', '微信'],
    },
  },
}
