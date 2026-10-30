import type { SiteAdapter } from './types.js'
import { hostOf } from './types.js'

/**
 * 北森（Beisen / hotjob）校招网申。常见域名：*.beisen.com、*.hotjob.cn、*.italent.cn。
 * 页面多为单页多模块（基本信息 / 教育经历 / 实习经历 …），模块里"保存"不等于提交。
 * 【未在真实登录态下验证】：按钮文案与 label 写法来自公开页面观察，可能随版本变化。
 */
export const beisen: SiteAdapter = {
  id: 'beisen',
  match: url => /beisen|hotjob|italent|zhiye\.com/.test(hostOf(url)),
  hints: {
    nextButton: ['下一步', '保存并下一步', '下一页', '继续填写'],
    submitWords: ['提交申请', '确认提交', '提交简历', '提交'],
    loginIndicators: ['请先登录', '登录后继续申请', '账号登录', '手机号登录'],
    captchaIndicators: ['拖动滑块', '滑动验证', '安全验证', '请完成验证'],
    detailEntryWords: ['申请职位', '立即申请', '投递简历', '立即投递'],
    positionLink: /\/(campus|social|jobs?)\/[^?#]*detail|jobAdId=|positionId=|\/job\/\d+/i,
    fieldAliases: {
      name: ['姓名', '真实姓名'],
      phone: ['手机号码', '手机号', '联系电话'],
      email: ['电子邮箱', '邮箱'],
      school: ['毕业院校', '学校名称', '院校'],
      major: ['专业名称', '所学专业', '专业'],
      degree: ['学历', '最高学历'],
      graduation: ['毕业时间', '毕业年月'],
      city: ['期望工作城市', '意向城市', '期望城市'],
      politics: ['政治面貌'],
      idNumber: ['证件号码', '身份证号'],
    },
  },
  // 北森自建页（<公司>.zhiye.com）的校招列表固定在 /campus/jobs；hotjob（wecruit.hotjob.cn/<租户>/pb/）在 school.html。
  // 两种都不带关键词参数：进列表后按方向词挑。
  positionSearchUrl: (url) => {
    const zhiye = /^(https?:\/\/[^/]+\.zhiye\.com)/.exec(url)
    if (zhiye) return `${zhiye[1]}/campus/jobs`
    const hotjob = /^(https?:\/\/[^/]*hotjob\.cn\/[^/]+\/pb)\//.exec(url)
    return hotjob ? `${hotjob[1]}/school.html` : null
  },
}
