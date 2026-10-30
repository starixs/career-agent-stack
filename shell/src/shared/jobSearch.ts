/**
 * 岗位库搜索：页面（jobBoardFilters.ts）和助理的 jobs_board 共用这一份，保证两边搜到同一批。
 *
 * 学生搜的是方向词（「后端」「算法」），岗位名写的是招聘方的说法（「服务端开发」「Java 开发」「推荐策略」），
 * 只做字面包含会漏掉大半；字面里的「后端」反而命中芯片的「数字后端设计」（2026-10-31 实例测试）。
 * 所以方向词按同义组展开：命中组里任一说法就算命中；不在表里的词照旧字面匹配。
 */
const DIRECTION_SYNONYMS: ReadonlyArray<readonly string[]> = [
  ['后端', '服务端', '服务器端', 'java', 'golang', 'go开发', 'go 开发', 'c++开发', 'php', '软件开发', '全栈', 'server', 'backend'],
  ['前端', 'web前端', 'web 前端', 'h5', 'react', 'vue', 'frontend'],
  ['客户端', 'ios', 'android', '安卓', '移动端'],
  ['算法', '机器学习', '深度学习', '大模型', 'nlp', '推荐', '搜索算法', 'cv'],
  ['测试', 'qa', '质量保障', '测开'],
  ['数据', '数据分析', '数仓', '数据开发', '大数据', 'bi'],
  ['运维', 'sre', 'devops', '云计算'],
  ['产品', '产品经理', 'pm'],
  ['运营', '新媒体', '内容运营', '用户运营'],
  ['设计', 'ui', 'ux', '交互', '视觉'],
];

/** 搜索词展开成要找的说法（小写）；不认识的词只返回它自己。 */
export function expandJobQuery(raw: string): string[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const group = DIRECTION_SYNONYMS.find(g => g.includes(q));
  return group ? [...group] : [q];
}

/** 公司名 + 岗位名里是否出现搜索词或它的同义说法。 */
export function jobMatchesQuery(company: string | null | undefined, title: string | null | undefined, raw: string): boolean {
  const terms = expandJobQuery(raw);
  if (!terms.length) return true;
  const text = `${company ?? ''} ${title ?? ''}`.toLowerCase();
  return terms.some(t => text.includes(t));
}
