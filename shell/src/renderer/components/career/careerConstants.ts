import type { ActionKind, ApplicationStage } from './types';

/** 与 packages/core/src/states.ts 的 STAGE_TRANSITIONS 保持一致（前端副本，只用于展示允许的目标阶段）。 */
export const STAGE_TRANSITIONS: Record<ApplicationStage, readonly ApplicationStage[]> = {
  evaluated: ['ready', 'skip', 'discarded'],
  ready: ['approved', 'skip', 'discarded'],
  approved: ['pending', 'applied', 'blocked', 'needs_user', 'skip'],
  pending: ['applied', 'blocked', 'needs_user', 'skip'],
  blocked: ['pending', 'approved', 'skip', 'discarded'],
  needs_user: ['pending', 'applied', 'skip'],
  applied: ['responded', 'interview', 'rejected', 'discarded'],
  responded: ['interview', 'rejected', 'discarded'],
  interview: ['interview', 'offer', 'rejected', 'discarded'],
  offer: ['hired', 'rejected', 'discarded'],
  rejected: [], discarded: [], skip: ['evaluated'], hired: [],
};

export const STAGE_LABELS: Record<ApplicationStage, string> = {
  evaluated: '已评估', ready: '待批准', approved: '已批准', pending: '投递中', applied: '已投递',
  responded: '已回应', interview: '面试中', offer: 'Offer', hired: '已入职',
  rejected: '被拒', discarded: '已放弃', skip: '跳过', blocked: '卡住', needs_user: '需要你',
};

/** 漏斗展示顺序（主线阶段）。 */
export const FUNNEL_ORDER: ApplicationStage[] = [
  'evaluated', 'ready', 'approved', 'pending', 'applied', 'responded', 'interview', 'offer', 'hired',
];

export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  fill_form: '填表', submit: '提交', send_greeting: '发招呼', upload: '上传',
  answer_open_q: '回答开放题', collect: '采集', research: '调研', send_mail: '发送投递邮件',
};

export const CLAIM_STATUS_LABELS = { verified: '已验证', pending: '待核实', user_confirmed: '你已确认' } as const;
export const ATTRIBUTION_LABELS = { self: '本人', team: '团队', unknown: '未知' } as const;
export const STRENGTH_LABELS = { strong: '强', mid: '中', weak: '弱' } as const;
export const RESUME_STRENGTH_LABELS = { nudge: '轻调', keywords: '关键词', full: '深改' } as const;

export const INTERVIEW_RESULT_LABELS: Record<string, string> = {
  none: '未知', rejected: '未通过', advanced: '进入下一轮', no_feedback_inferred: '无反馈（推测）',
};
export const INTERVIEW_RESULT_SOURCE_LABELS: Record<string, string> = { none: '无来源', official: '官方通知', inferred: '推测' };
export const INTERVIEW_ROUND_LABELS: Record<string, string> = {
  hr: 'HR 面', first: '一面', second: '二面', final: '终面', group: '群面', other: '其他',
};
export const MOCK_MODE_LABELS: Record<string, string> = { probe: '深挖追问', question_bank: '题库', project_story: '项目故事' };

export const DIRECTION_STATUS_LABELS = { candidate: '候选', tentative: '暂定', chosen: '已选', dropped: '放弃' } as const;
export const DIRECTION_STATUSES = ['candidate', 'tentative', 'chosen', 'dropped'] as const;

export const TRAFFIC_LIGHT_LABELS: Record<string, string> = { red: '红灯', yellow: '黄灯', green: '绿灯' };

export const HANDOFF_REASON_LABELS: Record<string, string> = {
  captcha: '验证码', login: '需要登录', '2fa': '两步验证', assessment: '需本人作答的测评',
  submit_confirm: '最终提交确认', missing_info: '缺少信息', user_request: '你要求接管',
};
export const TAKEOVER_STATE_LABELS: Record<string, string> = {
  idle: '空闲', running: '运行中', paused: '已暂停', human_active: '你在操作', resuming: '恢复中',
};

export const GAP_CATEGORY_LABELS = { have: '已具备', need_evidence: '需补证据', missing: '缺失' } as const;
