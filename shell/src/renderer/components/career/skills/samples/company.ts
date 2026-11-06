/**
 * 公司调研第一次打开时预设的一家（只摆一个对象的初始效果，不把红黄绿三种都摆出来），报告按公司调研技能的输出结构写。公司和主体名都是虚构的；
 * 来源链接用 example.com，只有「要你自己核实」那条指向真实的官方公示系统入口。
 */
import type { Company } from '../../types';

import { daysFromNow } from './sampleMode';

function report(light: string, legal: string, brand: string) {
  return {
    summary: { one_line: '可以投，签约主体和试用期要在面试里问清楚', points: ['主体清楚，没查到失信和经营异常', '校招岗位可能挂在子公司签约', '四条红线公开渠道查不了，要自己核实'] },
    intro: {
      business: `${brand}做企业用的数据平台，卖给零售和物流公司，按年收订阅费。成立十年左右，约两千人，总部在杭州。`,
      sources: [{ title: '公司官网', url: 'https://example.com/about' }],
      role: '这个岗位在平台团队写后端接口：给运营同学用的配置和权限模块。平时和产品、前端、测试配合，一周一个迭代。',
    },
    entity: { legal_name: legal, brand_names: [brand], candidates: [], confidence: 'high' },
    basic: { founded: '2014 年', status: '存续' },
    red_lines: [
      { id: 1, name: '当前被执行人 / 失信被执行人', status: 'clean', evidence: [] },
      { id: 2, name: '经营异常名录 / 吊销 / 注销中', status: 'clean', evidence: [] },
      { id: 3, name: '重大劳动保障违法 / 欠薪黑名单', status: 'unverified', evidence: [] },
      { id: 4, name: '近 1 年劳动仲裁频繁（≥5 起）', status: 'unverified', evidence: [] },
      { id: 5, name: '法定代表人 / 主要股东近 1 年频繁变更', status: 'clean', evidence: [] },
      { id: 6, name: '近 1 年诉讼频繁且多为被告', status: 'unverified', evidence: [] },
      { id: 7, name: '社保欠缴被公示', status: 'unverified', evidence: [] },
    ],
    signals: [{ category: '经营恶化', keyword: '裁员、降薪', hits: 1, strong: [{ title: '论坛帖子：去年年终打折', url: 'https://example.com/post', source_level: 'forum' }] }],
    traffic_light: light,
    pitfalls: [
      { risk: '校招岗位可能挂在子公司签约', evidence: '招聘页写的签约主体和品牌名不一致', ask_in_interview: '入职后劳动合同是和哪家主体签？' },
      { risk: '试用期考核标准没有公开说明', evidence: '招聘页和公告里都没写', ask_in_interview: '试用期多久，转正看哪些指标？' },
    ],
    interview_questions: ['这个岗位所在的团队现在有多少人，汇报给谁？', '校招生入职后前三个月主要做什么？'],
    manual_required: [{ item: '在企业信用公示系统核对经营状态', entry_url: 'https://www.gsxt.gov.cn', why: '官方渠道要验证码，小芽查不了' }],
  };
}

const company = (id: string, light: string, legal: string, brand: string, days: number): Company => ({
  id, legal_name: legal, brand_names: JSON.stringify([brand]), dd_report_json: JSON.stringify(report(light, legal, brand)),
  traffic_light: light, manual_checks: '[]', updated_at: daysFromNow(days),
});

export const SAMPLE_COMPANIES: Company[] = [company('sample_co_1', 'yellow', '星河科技（杭州）股份有限公司', '星河科技', -1)];
