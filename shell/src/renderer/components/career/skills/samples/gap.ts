/** 差距计划的示例：一个岗位，已有 / 缺证据 / 真没有三栏，加两条可验收的小任务。 */
import type { GapPlan } from '../../types';
import type { GapTargets } from '../results/GapPlans';

import { daysFromNow } from './sampleMode';

export const SAMPLE_GAP_PLANS: GapPlan[] = [{
  id: 'sample_gap_1', job_id: 'sample_job_1', direction_id: null, created_at: daysFromNow(-2),
  gaps_json: JSON.stringify({
    have: [{ requirement: 'Java 后端开发经验' }, { requirement: 'Redis 缓存与分布式锁' }],
    need_evidence: [{ requirement: '高并发场景的量化结果' }],
    missing: [{ requirement: '消息队列的线上经验' }],
  }),
  actions_json: JSON.stringify([
    { title: '补一份积分兑换模块的压测记录', acceptance: '有优化前后的 QPS 和响应时间对比', est_hours: 4 },
    { title: '用消息队列做一个延迟消息的小练习', acceptance: '能讲清消息丢失和重复消费怎么处理', est_hours: 8 },
  ]),
}];

export const SAMPLE_GAP_TARGETS: GapTargets = {
  jobs: [{ job_id: 'sample_job_1', company_name: '星河科技', title: 'Java 后端开发工程师' }],
  directions: [],
};
