/**
 * 功能市场的唯一清单：每一项对应内置技能（app/skills/<名>/SKILL.md），两种形态（2026-11-05 用户定）。
 *  - 工作台：能独立成事的技能，围绕它做一整页（面试助力 = 预测 + 面试前准备复习 + 面后复盘）。
 *  - 技能点：平时跟小芽聊的过程中会触发的特化能力。用户不知道我们有这些，所以在这里摆出来：
 *    特别在哪、说哪句话会用上、点一下就能试；落了库的成果在详情里看得到。
 * 清单里的技能名和 app/skills 一一对应（catalog.test.ts 守着），新加技能必须在这里给它一个位置。
 */
import {
  BarChart3, Building2, CalendarClock, Compass, FileInput, FileText, Inbox, ListChecks, Mail, MessageCircle, MessageSquareQuote,
  PenLine, Scale, Send, Sparkles, Target, Users, Wand2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { NavTarget } from '@/features/career-shell/navModel';

/** 卡片上的产出小样：画的是这个技能交回来的东西长什么样。 */
export type SpecimenKind =
  | 'chain' | 'answer' | 'page' | 'form' | 'report' | 'table' | 'funnel'
  | 'scores' | 'diff' | 'intake' | 'talk' | 'branches' | 'gaps' | 'essay' | 'letter' | 'bubble' | 'sorted' | 'timeline';

/** 落了库、详情里能直接看的成果。 */
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

interface MarketEntry {
  id: string;
  name: string;
  /** 一句话：他会拿到什么。 */
  promise: string;
  /** 对应的内置技能目录名；纯产品功能（搜题、求职月）为空。 */
  skills: readonly string[];
  icon: LucideIcon;
  specimen: SpecimenKind;
}

export interface Workbench extends MarketEntry { open: NavTarget }

export interface SkillPoint extends MarketEntry {
  /** 特别在哪：比直接问一个通用 AI 多做了什么。 */
  special: readonly string[];
  /** 说哪句话会用上（点了预填进对话输入框，可以先改再发）。 */
  ask: string;
  start?: StartSpec;
  results?: ResultKind;
  /** 不用叫、自己在做的；给一个去看结果的地方。 */
  auto?: { label: string; open: NavTarget };
}

export const WORKBENCHES: readonly Workbench[] = [
  {
    id: 'interview', name: '面试助力', promise: '面试前先知道会被问什么，练到答得上来；面完说几句就复盘',
    skills: ['probe-predict', 'interview-questions', 'interview-probe', 'project-story', 'interview-retro'],
    icon: Users, specimen: 'chain', open: { kind: 'career-dossier', view: 'interview' },
  },
  {
    id: 'exam', name: '笔试助力', promise: '截图或粘贴题目，先查同公司同岗位的往年题，再出答案',
    skills: [], icon: PenLine, specimen: 'answer', open: { kind: 'career-dossier', view: 'exam-search' },
  },
  {
    id: 'resume', name: '简历', promise: '一份底稿，按岗位各改一版',
    skills: ['resume-draft'], icon: FileText, specimen: 'page', open: { kind: 'career-material', view: 'resume' },
  },
  {
    id: 'apply', name: '网申进展', promise: '选一批岗位，小芽一家家填，填到哪一步都看得见',
    skills: ['apply-playbook'], icon: Send, specimen: 'form', open: { kind: 'career-live' },
  },
  {
    id: 'company', name: '公司调研', promise: '投之前查一查：招你的到底是哪家、有没有红线、面试时该问什么',
    skills: ['company-research'], icon: Building2, specimen: 'report', open: { kind: 'career-review', view: 'research' },
  },
  {
    id: 'offer', name: 'Offer 对比', promise: '几个 Offer 拆开摆在一起，哪个期限先到一眼看清',
    skills: ['offer-compare'], icon: Scale, specimen: 'table', open: { kind: 'career-dossier', view: 'offer' },
  },
  {
    id: 'month', name: '我的求职月', promise: '这个月投了多少、回了多少、卡在哪',
    skills: [], icon: BarChart3, specimen: 'funnel', open: { kind: 'career-review', view: 'funnel' },
  },
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
  {
    id: 'resume-import', name: '读简历', promise: '丢一份简历进来，基本资料、经历、能写进简历的话一次收好',
    skills: ['resume-import'], icon: FileInput, specimen: 'intake',
    special: ['按段落把经历切开，每句话标出能不能核实', '手机号、学校这些进你的资料，之后填表自动带上', '和已有资料对不上的地方，只让你选一次'],
    ask: '这是我的简历，帮我收一下',
  },
  {
    id: 'experience-interview', name: '聊经历', promise: '没有简历也行：口述一段实习或项目，整理成能写进简历的话',
    skills: ['experience-interview'], icon: MessageCircle, specimen: 'talk',
    special: ['按经历类型追着问：做了什么、你拍板了什么、结果是多少', '只记你亲口说的，拿不准的标出来等你确认', '数字说不清也能往下走，换个问法再问'],
    ask: '我先口述一段实习，帮我整理进简历',
    start: { label: '开始聊一段', inputs: [], say: () => '我想聊一段经历，帮我整理成能写进简历的话' },
  },
  {
    id: 'resume-tailor', name: '按岗位改简历', promise: '对着岗位要求改一版，每一处改动都写明为什么改',
    skills: ['resume-tailor'], icon: Wand2, specimen: 'diff',
    special: ['只用你确认过的经历，不编、不夸大', '把你做过的事换成这个岗位听得懂的说法', '改动一处处列出来，不满意整版换回'],
    ask: '按这个岗位把简历改一版',
    start: { label: '改一版', inputs: ['job'], say: pick => withJob(pick, '按', '把简历改一版') },
  },
  {
    id: 'job-evaluate', name: '岗位评估', promise: '值不值得投：先筛硬门槛，再从五个方面打分，每个分数都有依据',
    skills: ['job-evaluate', 'jd-parse'], icon: Target, specimen: 'scores',
    special: ['学历、届别、地点、到岗时间先过一遍，不符合直接告诉你', '技能、经历、方向、公司、成长五项分开看，各自写明依据', '分数卡在线上会再核一遍，并列出投之前要确认的事'],
    ask: '帮我评估这个岗位，JD 是：',
    start: { label: '评估这个岗位', inputs: ['job'], say: pick => withJob(pick, '帮我评估', '值不值得投') },
    results: 'evaluations',
  },
  {
    id: 'direction-explore', name: '方向探索', promise: '从你的经历里找出两三个更合适的方向，写明依据和拿不准的地方',
    skills: ['direction-explore'], icon: Compass, specimen: 'branches',
    special: ['每个方向都对得上你做过的具体的事', '不替你选：把不确定的地方和验证办法列出来', '看过的方向可以标成暂定、已选或放弃'],
    ask: '帮我看看还有哪些方向适合我',
    start: { label: '帮我看看方向', inputs: [], say: () => '帮我看看还有哪些方向适合我' },
    results: 'directions',
  },
  {
    id: 'gap-plan', name: '差距计划', promise: '离目标岗位还差什么：已经有的、缺证据的、真没有的，拆成能验收的小任务',
    skills: ['gap-plan'], icon: ListChecks, specimen: 'gaps',
    special: ['一条条对着岗位要求看，不是泛泛地说「再提升一下」', '缺证据和真没有分开：前者补材料，后者才去学', '每个小任务写明做到什么算完成、大概要几小时'],
    ask: '帮我做这个岗位的差距计划',
    start: { label: '做一份计划', inputs: ['job'], say: pick => withJob(pick, '帮我做', '的差距计划') },
    results: 'gapPlans',
  },
  {
    id: 'material-draft', name: '开放题和自我介绍', promise: '「为什么选我们」这类题按公司写，对同一家前后说法不打架',
    skills: ['material-draft'], icon: MessageSquareQuote, specimen: 'essay',
    special: ['优先用你以前写过、确认过的说法', '对每家公司说过什么都记着，前后矛盾会提醒你', '短、中、长几个版本一起给'],
    ask: '帮我写「为什么选择我们」，300 字，给这家公司：',
    start: {
      label: '写一版', inputs: ['topic', 'company'], topics: MATERIAL_TOPICS,
      say: pick => `帮我写「${topicLabel(pick.topic)}」${pick.company ? `，给${pick.company}` : ''}`,
    },
    results: 'materials',
  },
  {
    id: 'derivatives', name: '投递邮件', promise: '标题、正文、附件名都按规矩来，你点头了才发',
    skills: ['derivatives'], icon: Mail, specimen: 'letter',
    special: ['最要紧的信息放在最前面，HR 扫一眼就知道你是谁', '简历 PDF 自动附上，文件名按对方要求起', '写好先放着等你看，不会自己发出去'],
    ask: '帮我给这个岗位写投递邮件，附上简历 PDF',
    start: { label: '写投递邮件', inputs: ['job'], say: pick => withJob(pick, '帮我给', '写投递邮件，附上简历 PDF') },
  },
  {
    id: 'greeting', name: '招呼语', promise: 'Boss 上的第一句话：120 字以内，最要紧的放最前，不套模板',
    skills: ['greeting'], icon: Sparkles, specimen: 'bubble',
    special: ['对着岗位要求挑你最对口的一件事说', '写完自己先审一遍：有没有模板腔、有没有空话', '你点头之后自己发，小芽不替你发'],
    ask: '帮我给这个岗位写一句招呼语',
    start: { label: '写一句招呼语', inputs: ['job'], say: pick => withJob(pick, '帮我给', '写一句招呼语') },
  },
  {
    id: 'inbox-triage', name: '回音归类', promise: '面试邀请、笔试、拒信、Offer 进了邮箱自动认出来，记到对应的投递上',
    skills: ['inbox-triage'], icon: Inbox, specimen: 'sorted',
    special: ['时间、地点、链接从邮件里取出来，变成日历上的一件事', '同一件事来了几封只记一次', '粘贴一段通知或一个链接，也一样认'],
    ask: '帮我看看这封邮件是什么：',
    auto: { label: '看通知', open: { kind: 'career-inbox' } },
  },
  {
    id: 'campus-timeline', name: '校招节奏', promise: '提前批、秋招、春招现在走到哪了，这一步该做什么',
    skills: ['campus-timeline'], icon: CalendarClock, specimen: 'timeline',
    special: ['按你的届别和行业说，不是一张通用时间表', '网申、笔试、测评的截止时间以官方公告为准，会提醒你去核对', '查到的期限可以直接记进日历'],
    ask: '现在校招到哪个阶段了，我该做什么',
    start: { label: '问问现在该做什么', inputs: [], say: () => '现在校招到哪个阶段了，我该做什么' },
  },
];

/** 不单独摆出来的技能：总控，决定小芽怎么说话、什么时候用哪个技能。 */
export const INTERNAL_SKILLS: readonly string[] = ['assistant-core'];

export function findSkillPoint(id: string | undefined): SkillPoint | undefined {
  return SKILL_POINTS.find(point => point.id === id);
}
