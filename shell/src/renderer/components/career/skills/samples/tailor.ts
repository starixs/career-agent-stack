/**
 * 按岗位改简历的示例：对话里那张「定制好了」卡（ResumeChainCards.TailorDiffCard）的数据。
 * 逐处原文 → 新文、对上哪条 JD；一处没依据的改动被拦下；岗位要、经历里还没写到的一条。
 */
import type { CareerCard } from '../../types';

import { daysFromNow } from './sampleMode';

export const SAMPLE_TAILOR_CARD: CareerCard = {
  id: 'sample_tailor', kind: 'tailor_diff', title: '为「云图智能 · AI 应用开发工程师」定制好了', createdAt: daysFromNow(-1), state: 'pending',
  data: {
    company: '云图智能', title: 'AI 应用开发工程师', total: 3,
    changes: [
      {
        op: 'replace', place: '实习经历 · 比邻数据',
        before: '负责运营管理平台的后端接口开发',
        after: '用 Function Calling 把运营平台的查询接口封装成 Agent 工具，运营同学用一句话就能查活动数据',
        jd: ['Agent 工具调用'], reason: null,
      },
      {
        op: 'replace', place: '项目 · 运营配置平台',
        before: '参与积分兑换模块的高并发优化',
        after: '积分兑换模块的高并发优化：Redis 缓存活动规则与用户状态，数据库直连请求削减 80%',
        jd: ['高并发', 'Redis'], reason: null,
      },
      { op: 'add', place: '技能', before: null, after: 'LangChain、向量检索（课程项目）', jd: ['RAG'], reason: '课程项目里用过，写进技能但不写成工作经历' },
    ],
    blocked: [{ place: '实习经历 · 比邻数据', after: '主导公司大模型平台建设', why: '经历里没有「主导」和「大模型平台」的依据' }],
    needs: ['模型微调或部署的实际经验'],
  },
};
