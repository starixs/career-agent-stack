/** 招呼语的示例：两句写给不同岗位的第一句话（技能约定：120 字以内、最重要的放最前）。 */
import type { GreetingRow } from '../results/GreetingList';

export const SAMPLE_GREETINGS: GreetingRow[] = [
  {
    id: 'sample_greet_1', company: '云图智能', title: 'AI 应用开发工程师', manual: true,
    text: '您好，我在实习里用 Function Calling 把运营平台的查询接口做成了 Agent 工具，运营同学一句话就能查活动数据。看到贵司在招 AI 应用开发，想投一份简历。',
  },
  {
    id: 'sample_greet_2', company: '星河科技', title: 'Java 后端开发工程师', manual: true,
    text: '您好，我做过积分兑换模块的高并发优化，用 Redis 缓存把数据库直连请求降了八成，想应聘贵司的 Java 后端岗。',
  },
];
