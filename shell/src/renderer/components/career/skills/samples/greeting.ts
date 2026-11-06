/** 招呼语第一次打开时预设的一句：写给一个岗位的第一句话（技能约定：120 字以内、最重要的放最前）；只摆一条。 */
import type { GreetingRow } from '../results/GreetingList';

export const SAMPLE_GREETINGS: GreetingRow[] = [
  {
    id: 'sample_greet_1', company: '云图智能', title: 'AI 应用开发工程师', manual: true,
    text: '您好，我在实习里用 Function Calling 把运营平台的查询接口做成了 Agent 工具，运营同学一句话就能查活动数据。看到贵司在招 AI 应用开发，想投一份简历。',
  },
];
