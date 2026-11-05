/**
 * 建议条的主线一条与种子库（规则，不过模型）。
 *
 * 种子是"培养心智"的那一格：他不知道产品后面要用什么，我们知道——
 *  - 收偏好：批量投要按方向挑，偏好越早说清，勾选表越准；
 *  - 收数据：手投过的申请要从邮箱接过来；
 *  - 教功能：笔试搜题、面后复盘、查公司，在用得到之前先让他知道有；
 *  - 给底气：不信任 AI 的人最想问的那几句，替他问出来。
 * 每条只在对应阶段出现，已经有的数据不再收（连了邮箱就不出"手投过"）。
 */
import type { MainlineStage } from '../../shared/careerRail';

export interface SuggestContext {
  stage: MainlineStage;
  /** 等他处理的事有几件。 */
  waiting: number;
  hasResume: boolean;
  mailConnected: boolean;
  /** 他说过的条件拼成一串（用来判断某个偏好是否已经说过）。 */
  prefsText: string;
}

export interface Seed {
  id: string;
  text: string;
  stages: readonly MainlineStage[];
  /** 这条要收的东西已经有了 → 不出。 */
  skip?: (ctx: SuggestContext) => boolean;
}

const EARLY: readonly MainlineStage[] = ['profile', 'direction', 'first'];
const LATER: readonly MainlineStage[] = ['first', 'batch', 'released'];
const ALL: readonly MainlineStage[] = ['profile', 'direction', 'first', 'batch', 'released'];

export const SEEDS: readonly Seed[] = [
  { id: 'trust_review', text: '提交前我能先看吗', stages: EARLY },
  { id: 'mail_takeover', text: '我之前手投过一些了', stages: EARLY, skip: c => c.mailConnected },
  { id: 'pref_outsourcing', text: '我不考虑外包', stages: ['direction', 'first', 'batch'], skip: c => c.prefsText.includes('外包') },
  { id: 'pref_city', text: '我对城市有要求', stages: ['direction', 'first', 'batch'] },
  { id: 'pref_soe', text: '国企和银行也想试试', stages: ['direction', 'batch'], skip: c => /国企|银行/.test(c.prefsText) },
  { id: 'feat_company', text: '帮我看看一家公司靠谱吗', stages: ['direction', 'first', 'batch'] },
  { id: 'data_internship', text: '我还有段经历没说', stages: LATER },
  { id: 'trust_privacy', text: '我的身份证号安全吗', stages: ['first', 'batch'] },
  { id: 'feat_exam', text: '笔试时你能帮我搜题吗', stages: ['batch', 'released'] },
  { id: 'feat_retro', text: '面试完怎么复盘', stages: ['batch', 'released'] },
  { id: 'mail_connect', text: '帮我盯着邮箱', stages: ALL, skip: c => c.mailConnected },
];

/** 主线下一步：保证建议条里总有一条把他往前带。有事等他时先带他去处理。 */
export function mainlineChip(ctx: SuggestContext): string {
  if (ctx.waiting > 0) return '先处理等我的事';
  switch (ctx.stage) {
    case 'profile': return ctx.hasResume ? '帮我把简历理一理' : '我还没有简历，先聊聊';
    case 'direction': return '按我的经历推荐方向';
    case 'first': return '先投一家给我看看';
    case 'batch':
    case 'released': return '再投 5 家';
  }
}

/** 这一阶段能出的种子，去掉最近出过的和已经有数据的。 */
export function seedCandidates(ctx: SuggestContext, recent: ReadonlySet<string>): Seed[] {
  return SEEDS.filter(s => s.stages.includes(ctx.stage) && !recent.has(s.id) && !s.skip?.(ctx));
}
