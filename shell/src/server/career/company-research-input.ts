/**
 * 公司调研技能的输入：公司名、消歧信息、目标岗位（有就带上名称和 JD），加联网搜索结果。
 * 带上岗位是为了让报告能说清「这个岗位来了做什么」——只依据 JD，没有 JD 技能会把这一项留空。
 */

/** 搜索结果最多带这么多字符：再多会挤掉模型留给报告的输出预算。 */
const MAX_HITS_CHARS = 20_000;
/** JD 最多带这么多字符：职责和要求一般在前面，够说清岗位做什么。 */
const MAX_JD_CHARS = 3_000;

export interface ResearchJob { title: string; jd_raw: string | null }

export function companyResearchInput(input: { companyName: string; hints?: string | null; job?: ResearchJob | null; hits: unknown[] }): string {
  const { companyName, hints, job, hits } = input;
  const jd = job?.jd_raw?.trim();
  const role = job
    ? `目标岗位：${job.title}\n${jd ? `JD：\n${jd.slice(0, MAX_JD_CHARS)}` : 'JD：未提供（role 留空）'}`
    : '目标岗位：未提供（role 留空）';
  return [
    `公司名：${companyName}`,
    `消歧信息：${hints?.trim() || '无'}`,
    role,
    `\nWeb Search 结果（${hits.length} 条）：\n${JSON.stringify(hits).slice(0, MAX_HITS_CHARS)}`,
  ].join('\n');
}
