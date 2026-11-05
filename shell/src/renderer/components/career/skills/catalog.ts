/**
 * 功能市场的唯一清单：每一项对应内置技能（app/skills/<名>/SKILL.md），两种形态（2026-11-05 用户定）。
 *  - 工作台：能独立成事的技能，围绕它做一整页。
 *  - 技能点：平时跟小芽聊的过程中会触发的特化能力。用户不知道我们有这些，所以在这里摆出来。
 * 清单里的技能名和 app/skills 一一对应（catalog.test.ts 守着），新加技能必须在这里给它一个位置。
 * 页面上只放名字和一小段它做出来的东西，不写说明性的句子（CAREER_DESIGN 7.4.2）。
 */
import type { NavTarget } from '@/features/career-shell/navModel';

/** 落了库、点开就能看的成果。 */
export type ResultKind = 'evaluations' | 'directions' | 'gapPlans' | 'materials';

/** 开始前要他选的东西：从已有数据里选，不让他打字。 */
export type StartInput = 'job' | 'company' | 'topic';

export interface StartPick { jobId?: string; jobLabel?: string; company?: string; topic?: string }

export interface StartSpec {
  /** 按钮上的字。 */
  label: string;
  inputs: StartInput[];
  topics?: ReadonlyArray<{ value: string; label: string }>;
  /** 选好之后发进对话的那句话；对象 id 走隐藏上下文，助理不用再问「哪一个」。 */
  say: (pick: StartPick) => string;
}

export type WorkbenchId = 'interview' | 'exam' | 'resume' | 'apply' | 'company' | 'offer' | 'month';

export interface Workbench {
  id: WorkbenchId;
  name: string;
  /** 对应的内置技能目录名；纯产品功能（搜题、求职月）为空。 */
  skills: readonly string[];
  open: NavTarget;
}

/**
 * 技能点怎么用上，三选一：
 *  - start / results：点开就地展开，选一下、点一下开始，下面是它做出过的成果；
 *  - open：自己在做的，点了去看结果；
 *  - 都没有：点了把 ask 那句话预填进对话输入框。
 */
export interface SkillPoint {
  id: string;
  name: string;
  /** 它交回来的是什么，十来个字以内。 */
  gives: string;
  skills: readonly string[];
  /** 聊天时说这句会用上。 */
  ask: string;
  start?: StartSpec;
  results?: ResultKind;
  open?: NavTarget;
}

export const WORKBENCHES: readonly Workbench[] = [
  { id: 'interview', name: '面试助力', skills: ['probe-predict', 'interview-questions', 'interview-probe', 'project-story', 'interview-retro'], open: { kind: 'career-dossier', view: 'interview' } },
  { id: 'exam', name: '笔试助力', skills: [], open: { kind: 'career-dossier', view: 'exam-search' } },
  { id: 'resume', name: '简历', skills: ['resume-draft'], open: { kind: 'career-material', view: 'resume' } },
  { id: 'apply', name: '网申进展', skills: ['apply-playbook'], open: { kind: 'career-live' } },
  { id: 'company', name: '公司调研', skills: ['company-research'], open: { kind: 'career-review', view: 'research' } },
  { id: 'offer', name: 'Offer 对比', skills: ['offer-compare'], open: { kind: 'career-dossier', view: 'offer' } },
  { id: 'month', name: '我的求职月', skills: [], open: { kind: 'career-review', view: 'funnel' } },
];

const withJob = (pick: StartPick, lead: string, tail = ''): string => `${lead}${pick.jobLabel ? `「${pick.jobLabel}」` : '这个岗位'}${tail}`;

export const MATERIAL_TOPICS = [
  { value: 'why_company', label: '为什么选我们' },
  { value: 'self_intro', label: '自我介绍' },
  { value: 'strength_weakness', label: '优点和缺点' },
  { value: 'career_plan', label: '职业规划' },
  { value: 'why_role', label: '为什么做这个岗位' },
] as const;

const topicLabel = (value: string | undefined): string => MATERIAL_TOPICS.find(t => t.value === value)?.label ?? MATERIAL_TOPICS[0].label;

export const SKILL_POINTS: readonly SkillPoint[] = [
  { id: 'resume-import', name: '读简历', gives: '资料、经历一次收好', skills: ['resume-import'], ask: '这是我的简历，帮我收一下' },
  { id: 'experience-interview', name: '聊经历', gives: '口述一段，写成简历里的话', skills: ['experience-interview'], ask: '我先口述一段实习，帮我整理进简历' },
  {
    id: 'resume-tailor', name: '按岗位改简历', gives: '改动逐条列出', skills: ['resume-tailor'], ask: '按这个岗位把简历改一版',
    start: { label: '改一版', inputs: ['job'], say: pick => withJob(pick, '按', '把简历改一版') },
  },
  {
    id: 'job-evaluate', name: '岗位评估', gives: '硬门槛和五项评分', skills: ['job-evaluate', 'jd-parse'], ask: '帮我评估这个岗位，JD 是：',
    start: { label: '评估', inputs: ['job'], say: pick => withJob(pick, '帮我评估', '值不值得投') },
    results: 'evaluations',
  },
  {
    id: 'direction-explore', name: '方向探索', gives: '两三个方向和依据', skills: ['direction-explore'], ask: '帮我看看还有哪些方向适合我',
    start: { label: '看看方向', inputs: [], say: () => '帮我看看还有哪些方向适合我' },
    results: 'directions',
  },
  {
    id: 'gap-plan', name: '差距计划', gives: '还差什么，拆成小任务', skills: ['gap-plan'], ask: '帮我做这个岗位的差距计划',
    start: { label: '做一份', inputs: ['job'], say: pick => withJob(pick, '帮我做', '的差距计划') },
    results: 'gapPlans',
  },
  {
    id: 'material-draft', name: '开放题和自我介绍', gives: '短中长三版', skills: ['material-draft'], ask: '帮我写「为什么选择我们」，300 字，给这家公司：',
    start: {
      label: '写一版', inputs: ['topic', 'company'], topics: MATERIAL_TOPICS,
      say: pick => `帮我写「${topicLabel(pick.topic)}」${pick.company ? `，给${pick.company}` : ''}`,
    },
    results: 'materials',
  },
  {
    id: 'derivatives', name: '投递邮件', gives: '标题、正文、附件', skills: ['derivatives'], ask: '帮我给这个岗位写投递邮件，附上简历 PDF',
    start: { label: '写邮件', inputs: ['job'], say: pick => withJob(pick, '帮我给', '写投递邮件，附上简历 PDF') },
  },
  {
    id: 'greeting', name: '招呼语', gives: '120 字以内的第一句话', skills: ['greeting'], ask: '帮我给这个岗位写一句招呼语',
    start: { label: '写一句', inputs: ['job'], say: pick => withJob(pick, '帮我给', '写一句招呼语') },
  },
  { id: 'inbox-triage', name: '回音归类', gives: '邀请、笔试、拒信自动认出来', skills: ['inbox-triage'], ask: '帮我看看这封邮件是什么：', open: { kind: 'career-inbox' } },
  { id: 'campus-timeline', name: '校招节奏', gives: '现在走到哪一步', skills: ['campus-timeline'], ask: '现在校招到哪个阶段了，我该做什么' },
];

/** 不单独摆出来的技能：总控，决定小芽怎么说话、什么时候用哪个技能。 */
export const INTERNAL_SKILLS: readonly string[] = ['assistant-core'];

export function findSkillPoint(id: string | undefined): SkillPoint | undefined {
  return SKILL_POINTS.find(point => point.id === id);
}

/** 点开要就地展开的技能点（有东西要选，或者有成果可看）。 */
export const expands = (point: SkillPoint): boolean => !!point.start || !!point.results;
