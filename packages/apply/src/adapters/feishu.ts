import type { SiteAdapter } from './types.js'
import { hostOf } from './types.js'

/**
 * 飞书招聘（*.feishu.cn/hire、people.feishu.cn、*.jobs.feishu.cn、larkoffice.com/hire）。
 * 表单为单页 + 分节，上传简历后会自动解析填充教育/工作经历。
 * 【未在真实登录态下验证】。
 */
export const feishu: SiteAdapter = {
  id: 'feishu',
  match: url => { const h = hostOf(url); return /people\.feishu\.cn|jobs\.feishu\.cn|larkoffice\.com/.test(h) || (/feishu\.cn/.test(h) && /\/hire/.test(url)) },
  hints: {
    nextButton: ['下一步', '继续'],
    submitWords: ['提交', '提交申请', '投递', '立即投递', '确认投递'],
    loginIndicators: ['请先登录', '手机号登录', '登录后投递', '验证码登录'],
    captchaIndicators: ['拖动滑块', '滑动验证', '安全验证'],
    // 详情页的「投递」只打开网申表、要先登录（2026-10-31 小鹏校招页）；表单页上的「投递」仍是最终提交
    detailEntryWords: ['投递', '立即投递', '投递简历', '申请职位'],
    positionLink: /\/position\/\d+\/detail/,
    fieldAliases: {
      name: ['姓名'],
      phone: ['手机号', '手机'],
      email: ['邮箱'],
      school: ['学校', '毕业院校'],
      major: ['专业'],
      degree: ['学历'],
      graduation: ['毕业时间'],
      city: ['期望城市', '工作地点'],
      availableDate: ['到岗时间', '可入职时间'],
    },
  },
  // <公司>.jobs.feishu.cn/<campus|index|…>/… → 同一前缀下的 /position/list?keywords=…
  positionSearchUrl: (url, keyword) => {
    const m = /^(https?:\/\/[^/]+\.jobs\.feishu\.cn)\/([^/?#]+)/.exec(url)
    return m ? `${m[1]}/${m[2]}/position/list?keywords=${encodeURIComponent(keyword)}` : null
  },
}
