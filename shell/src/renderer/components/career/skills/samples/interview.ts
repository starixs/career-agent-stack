/**
 * 面试助力的示例：一场两天后的二面（准备）、一场面过并复盘过的一面（复盘）、几道练过和没练过的题（题库）。
 * 来自之前给用户看过的预览那份示例；公司是虚构的。
 */
import type { DossierSummary, Interview, MockInterview, ProbePrediction, QuestionItem } from '../../types';

import { daysFromNow } from './sampleMode';

const J = JSON.stringify;

const dossier: DossierSummary = {
  application_id: 'sample_app_1', job_id: 'sample_job_1', company_name: '星河科技', title: 'Java 后端开发工程师', stage: 'interview',
  updated_at: daysFromNow(-2), days_since_update: 2, next_deadline: null, interview_count: 1, resume_tailored_id: null, closed: false,
};

const PREDICTIONS: Array<{ risk: string; type: string; statement: string; chain: string[] }> = [
  { risk: 'high', type: 'project', statement: '主导基于 Apollo 的三层动态配置体系开发，搭建营销活动可视化配置界面，实现活动规则的无代码化调整', chain: ['你在这个项目中具体负责哪部分？「主导」是指你独立完成了哪些模块？', '三层动态配置体系具体是哪三层？为什么需要三层？', '可视化配置界面是你独立开发的吗？', '降低运营日常工作量 30% 是怎么统计的？口径是什么？', '如果没有你，这个项目会怎样？'] },
  { risk: 'high', type: 'data', statement: '参与积分兑换模块的高并发优化，借助 Redis 缓存活动规则与用户状态，数据库直连请求削减 80%', chain: ['削减 80% 是怎么统计的？优化前后的 QPS 各是多少？', '分布式锁用的什么方案？锁的粒度是什么？', '缓存和数据库的一致性怎么保证？'] },
  { risk: 'high', type: 'data', statement: '基于 Redis Zset 设计点赞排行榜的实时排行逻辑，支撑 10 万用户实时点赞', chain: ['10 万用户是压测结果还是线上实际数据？', '点赞量突增到 100 万，方案的瓶颈在哪？'] },
  { risk: 'medium', type: 'method', statement: '总结了一套接口联调的检查清单，在组内推广使用', chain: ['清单里有哪几项？哪一项是踩过坑之后加的？'] },
  { risk: 'low', type: 'project', statement: '负责运营管理平台的任务配置、用户权限模块的后端接口开发', chain: ['权限模型是怎么设计的？'] },
];

const predictions: ProbePrediction[] = PREDICTIONS.map((p, i) => ({
  id: `sample_prb_${i}`, resume_tailored_id: null, claim_id: null, statement: p.statement, target_type: p.type, risk: p.risk,
  expected_chain_json: J(p.chain), created_at: daysFromNow(-3),
}));

const mockReport = {
  verdict: 'borderline',
  diagnosis: [
    { claim: '主导三层动态配置体系开发', broke_at_layer: 3, issue: '说不清哪些是自己拍板的', interviewer_thought: '「主导」可能说大了' },
    { claim: '数据库直连请求削减 80%', broke_at_layer: 2, issue: '没有优化前后的对比口径', interviewer_thought: '数字可能是估的' },
  ],
  red_flags: { suspicious: ['80% 这个数字过于整齐'], inflated: ['实习生写「主导」'], scripted: [] },
  reference_answers: [{ claim: '主导三层动态配置体系开发', answer: '我负责其中的规则配置层，从方案到上线独立完成；另外两层是和导师一起评审过方案。', needs_verification: ['规则配置层的上线时间'] }],
  todo: ['把「主导」改成你真正负责的那一层', '补上优化前后的 QPS 对比'],
  gaps: [{ jd_requirement: '高并发系统经验', real_gap: false, strategy: '用积分兑换模块的并发优化来讲' }],
};

const mocks: MockInterview[] = [{
  id: 'sample_mock_1', job_id: 'sample_job_1', resume_tailored_id: null, mode: 'probe', company_type: '大厂', round: 'first',
  turns_json: J(new Array(9).fill({})), report_json: J(mockReport), created_at: daysFromNow(-1), updated_at: daysFromNow(-1),
}];

const QUESTIONS: Array<{ content: string; category: string; attempts: number; score: number | null; reference: string | null }> = [
  { content: '讲一个你做过的最复杂的项目，你在里面具体负责什么？', category: 'project', attempts: 2, score: 62, reference: '先说清自己负责的那一层，再讲一个自己拍板的决定和它的结果。' },
  { content: 'Redis 分布式锁有哪些坑？你在项目里怎么处理的？', category: 'project', attempts: 0, score: null, reference: null },
  { content: '为什么想来我们公司？', category: 'motivation', attempts: 1, score: 78, reference: null },
  { content: '缓存和数据库的数据怎么保证一致？', category: 'tech', attempts: 1, score: 54, reference: null },
];

export const SAMPLE_QUESTIONS: QuestionItem[] = QUESTIONS.map((q, i) => ({
  id: `sample_q_${i}`, question_key: `sample_k_${i}`, kind: 'interview', category: q.category, content: q.content, reference: q.reference,
  probe_points_json: '[]', jd_requirement: null, company_name: '星河科技', title: 'Java 后端开发工程师', job_id: 'sample_job_1',
  source: 'generated', sources_json: '[]', tags_json: '[]', seen_count: 0, attempt_count: q.attempts, last_attempt_score: q.score,
  best_attempt_score: q.score, first_seen_at: null, last_seen_at: null, updated_at: daysFromNow(-1),
}));

const retro = {
  focus_this_round: '项目里你自己拍板的部分，和数字的口径',
  questions: [
    { type: 'project', point: '个人贡献边界', intent: '看你在项目里的真实分工', quote: '这个配置体系里，哪一层是你独立设计的？', answer: '规则配置层是我写的，另外两层我们一起做的，我主要负责联调。', good: ['先说清了自己负责哪一层'], lacking: ['说到另外两层改口成「我们」，没说你在里面拍板了什么'], stuck_layer: 3, interviewer_doubt: { evidence: '说到第三层开始用「我们」', alternative: '只是表达习惯' } },
    { type: 'data', point: '数字的口径', intent: '核对数字来源', quote: '降低 30% 是怎么统计出来的？', answer: '是运营那边反馈的，大概少了三成的工作量。', good: [], lacking: ['没有统计周期和对比基线', '数字来源是别人的反馈'], stuck_layer: 2, interviewer_doubt: { evidence: '没说统计周期', alternative: '' } },
    { type: 'tech', point: '缓存一致性', intent: '看基础是否扎实', quote: '配置改了以后，缓存怎么保证不读到旧值？', answer: '更新数据库后删缓存，再加一个短的过期时间兜底。', good: ['讲到了先更新再删缓存', '知道用过期时间兜底'], lacking: [], stuck_layer: 0, interviewer_doubt: { evidence: '', alternative: '' } },
  ],
  logic: [
    { point: '个人贡献边界', why: '简历写了「主导」，面试官要拆出哪部分真是你做的', review: '每段经历准备一句：我负责什么、我拍板了什么' },
    { point: '数字的口径', why: '简历里的百分比都会被追问怎么算的', review: '把每个数字的周期、基线、来源写下来' },
    { point: '缓存一致性', why: '项目用了缓存，顺着问基础', review: '缓存更新的几种策略和各自的坑' },
  ],
  signals: [{ tag: '追问变细', fact: '同一个项目连问了五层', interpretation: '对这段经历感兴趣', alternative: '在核实真实性' }],
  next_round_probes: ['三层配置各自解决什么问题', '没有你，这个项目会怎样'],
  retakes: [{ question: '降低 30% 是怎么统计出来的？', answer: '按运营同学每周处理配置工单的工时算，上线前四周平均和上线后四周平均对比。', needs_verification: ['上线前后各四周的工单工时'] }],
  todo: { facts: ['把统计口径和周期写下来'], delivery: ['先说结论再说过程'] },
};

const interview = (id: string, round: string, days: number, extra: Partial<Interview>): Interview => ({
  id, application_id: 'sample_app_1', company_name: '星河科技', title: 'Java 后端开发工程师', round, date: daysFromNow(days),
  interviewer_role_guess: null, transcript: null, tags_json: '[]', retro_json: null, result: 'none', result_source: 'none',
  created_at: daysFromNow(Math.min(days, -1)), updated_at: daysFromNow(Math.min(days, -1)), ...extra,
});

/** 准备：两天后的二面。 */
export const SAMPLE_UPCOMING = interview('sample_itv_1', 'second', 2, {});
/** 复盘：五天前的一面，复盘过、过了。 */
export const SAMPLE_RETRO_INTERVIEW = interview('sample_itv_2', 'first', -5, {
  interviewer_role_guess: '技术负责人', tags_json: J(['项目深挖', '数字口径']), retro_json: J(retro), result: 'advanced', result_source: 'official',
});

export const SAMPLE_PREP = { interviews: [SAMPLE_UPCOMING], mocks, predictions, dossiers: [dossier], questions: SAMPLE_QUESTIONS };
