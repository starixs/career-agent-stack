/** 方向探索的示例：两个方向的路牌，各带依据、差距、拿不准的地方和怎么验证。 */
import type { Direction } from '../../types';

import { daysFromNow } from './sampleMode';

export const SAMPLE_DIRECTIONS: Direction[] = [
  {
    id: 'sample_dir_1', name: 'AI 应用开发 / Agent 工程', status: 'tentative', created_at: daysFromNow(-8), updated_at: daysFromNow(-2),
    rationale_json: JSON.stringify({
      typical_titles: ['AI 应用开发工程师', 'Agent 开发工程师'],
      fit_reasons: [{ reason: '独立完成过 Agent workflow 与报告生成链路' }, { reason: '用 Function Calling 封装过内部查询接口' }],
      gaps: ['没有模型微调和大规模部署的经历'],
      uncertainty: ['不同城市的岗位数量差别大'],
      how_to_validate: ['先投两三个这类岗位，看简历反馈和面试问题的方向'],
    }),
  },
  {
    id: 'sample_dir_2', name: 'Java 后端开发（平台 / 中台方向）', status: 'candidate', created_at: daysFromNow(-8), updated_at: daysFromNow(-8),
    rationale_json: JSON.stringify({
      typical_titles: ['Java 后端开发工程师', '服务端开发工程师'],
      fit_reasons: [{ reason: '做过运营管理平台的后端接口与权限模块' }],
      gaps: ['缺少大流量线上系统的经验'],
      uncertainty: ['竞争激烈，要看笔试'],
      how_to_validate: ['刷一套同类岗位的往年笔试题'],
    }),
  },
];
