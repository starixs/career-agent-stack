/**
 * 搜题的纯函数：题干归一、相似度、岗位族、检索分级。
 *
 * 检索分级（世界模型「题」：同公司同岗位往年题 → 同岗位别家公司 → 同类题）：
 *   1 same-role-company：同一家公司、同一岗位族
 *   2 same-role：别家公司的同岗位族
 *   3 same-company：同一家公司的别的岗位
 *   4 general：其余
 * 原题判定只看题干相似度：固定题会在不同公司、不同年份反复出现。
 */

export type MatchTier = 'same-role-company' | 'same-role' | 'same-company' | 'general';

export const TIER_RANK: Record<MatchTier, number> = { 'same-role-company': 1, 'same-role': 2, 'same-company': 3, general: 4 };

/** 精排时同一相似度下，按分级加一点分，让更贴近这场笔试的题排前面。 */
const TIER_BOOST: Record<MatchTier, number> = { 'same-role-company': 0.08, 'same-role': 0.05, 'same-company': 0.02, general: 0 };

/** 题干 + 选项的二元字相似度达到这个值才可能是同一道题（固定题换了标点、空格也能认出来）。 */
export const SAME_QUESTION_MIN = 0.72;
/** 低于这个值的候选不算「类似题」，免得拿不相干的题凑数。 */
export const SIMILAR_MIN = 0.3;

/** 开头的题号：「3.」「（12）」「三、」。 */
const LEADING_NUMBER = /^\s*[（(]?\s*(\d+|[一二三四五六七八九十]+)\s*[.、．)）]\s*/u;

/** 去掉空白、标点、题号与选项字母前缀，只留可比较的字。 */
export function normalizeStem(text: string): string {
  return text
    .toLowerCase()
    .replace(LEADING_NUMBER, '')
    .replace(/(^|\s)[a-h]\s*[.、．)）:：]/gu, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text: string): Set<string> {
  const chars = [...text];
  const out = new Set<string>();
  if (chars.length === 1) out.add(chars[0]);
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** 题里出现的数字（按出现顺序）。改了数字的「同一道题」答案就变了，所以原题判定要求数字完全一致。 */
export function numbersIn(text: string): string[] {
  return text.replace(LEADING_NUMBER, '').match(/\d+(?:\.\d+)?/g) ?? [];
}

/** 是不是同一道题：字面足够像，而且数字一致。 */
export function isSameQuestion(similarity: number, a: string, b: string): boolean {
  return similarity >= SAME_QUESTION_MIN && numbersIn(a).join(',') === numbersIn(b).join(',');
}

/** Dice 系数（二元字）：0～1。 */
export function stemSimilarity(a: string, b: string): number {
  const x = bigrams(normalizeStem(a));
  const y = bigrams(normalizeStem(b));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** FTS5 trigram 查询：取题干里不重复的三字片段做 OR，最多 MAX_QUERY_TRIGRAMS 个。 */
const MAX_QUERY_TRIGRAMS = 48;
export function trigramQuery(text: string): string | null {
  const chars = [...normalizeStem(text)];
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= chars.length && grams.size < MAX_QUERY_TRIGRAMS; i++) grams.add(chars.slice(i, i + 3).join(''));
  if (grams.size === 0) return null;
  return [...grams].map(g => `"${g.replace(/"/g, '')}"`).join(' OR ');
}

/** 岗位族：按岗位名关键词归类，先命中的优先（更具体的写在前面）。 */
const ROLE_FAMILIES: Array<[string, RegExp]> = [
  ['算法', /算法|机器学习|深度学习|大模型|nlp|cv|推荐|搜索策略|ai\s*研究/i],
  ['测试', /测试|qa|质量/i],
  ['运维', /运维|sre|devops|系统工程|网络工程|dba/i],
  ['数据', /数据分析|数据科学|商业分析|bi\b|数仓|数据开发/i],
  ['开发', /开发|工程师|研发|前端|后端|客户端|java|c\+\+|golang|python|ios|android|嵌入式|架构/i],
  ['设计', /设计|ui|ux|交互|视觉|美术|原画|动效|插画/i],
  ['产品', /产品/],
  ['新媒体', /新媒体|内容|编辑|文案|短视频|直播|主播|策划/],
  ['运营', /运营|用户增长|社群|电商/],
  ['市场', /市场|品牌|公关|营销|广告|投放/],
  ['销售', /销售|商务|bd|客户经理|渠道/i],
  ['金融', /金融|投资|审计|会计|财务|风控|精算|证券|银行|管培/],
  ['职能', /人力|hr|招聘|行政|法务|法律|培训/i],
];

export function roleFamily(roleTitle: string | null | undefined): string | null {
  const text = roleTitle?.trim();
  if (!text) return null;
  return ROLE_FAMILIES.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** 公司名归一：去掉「集团 / 有限公司 / 科技」等后缀与空白，大小写不敏感。 */
export function normalizeCompany(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(股份)?有限(责任)?公司|集团|控股|科技|网络|技术|中国/g, '');
}

export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

export interface SearchContext { companyName: string | null; roleTitle: string | null }

export function tierOf(item: { company_name: string | null; role_family: string | null }, ctx: SearchContext): MatchTier {
  const family = roleFamily(ctx.roleTitle);
  const sameRole = family !== null && item.role_family === family;
  const company = sameCompany(item.company_name, ctx.companyName);
  if (company && sameRole) return 'same-role-company';
  if (sameRole) return 'same-role';
  if (company) return 'same-company';
  return 'general';
}

export function rankScore(similarity: number, tier: MatchTier): number {
  return similarity + TIER_BOOST[tier];
}
