import type { SiteAdapter } from './types.js'

/** 兜底适配器：不做站点假设，全靠通用启发式。 */
export const generic: SiteAdapter = {
  id: 'generic',
  match: () => true,
  hints: {
    nextButton: ['下一步', '下一页', '继续', '保存并继续', '保存并下一步', 'Next', 'Continue', 'Save and continue'],
    submitWords: ['提交', '确认提交', '提交申请', '投递', '立即投递', 'Submit', 'Apply now'],
    loginIndicators: ['请先登录', '登录后继续', '扫码登录', '账号密码登录'],
    captchaIndicators: ['拖动滑块', '滑动验证', '人机验证', '安全验证', '图形验证码'],
  },
}
