/** 岗位评估第一次打开时预设的一条：一个很值得投的岗位（雷达图、硬门槛、投前确认都有），展开着；只摆这一条，不把硬门槛没过的另摆一条。公司是虚构的。 */
import type { JobEvaluation } from '../../types';

import { daysFromNow } from './sampleMode';

const strong = {
  prefilter: {
    pass: true,
    checks: [
      { item: '学历 / 专业 / 届别', status: 'pass', evidence: '要求本科及以上、计算机相关、2027 届，你都符合' },
      { item: '地点', status: 'pass', evidence: 'JD 写的是上海，你没有排除' },
      { item: '到岗时间与每周天数', status: 'unverified', evidence: 'JD 没写' },
    ],
  },
  score: { skills: 82, experience: 80, direction: 82, culture: 36, growth: 70, total: 77 },
  reasons: [
    { dimension: 'skills', reason: '主流后端技术栈和 AI 应用开发都有实证，RAG 没有直接证据' },
    { dimension: 'experience', reason: '做的是 Agent 和工具调用的落地，和岗位职责同源' },
    { dimension: 'direction', reason: '研究方向和实习方向都是 AI 应用的工程落地' },
    { dimension: 'culture', reason: '没有金融业务经验，也还没查过这家公司' },
    { dimension: 'growth', reason: '应届硕士投应用岗，不算越级' },
  ],
  verdict: 'strong',
  ask_user: ['JD 没写每周到岗天数，投之前问一下', '要不要先查一下这家公司'],
};

export const SAMPLE_EVALUATIONS: JobEvaluation[] = [
  { job_id: 'sample_job_1', company_name: '云图智能', title: 'AI 应用开发工程师', url: null, score_json: JSON.stringify(strong), prefilter_json: null, updated_at: daysFromNow(-2) },
];
