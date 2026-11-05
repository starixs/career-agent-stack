/**
 * 测试与组件预览用的邮件夹具（按 shared/careerMailApply.ts 合同造，服务端没好之前前端照它写）。
 * 只给测试和预览 import，产品代码不引用。
 */
import type { AskMailFailed, MailDraftView, MailThreadView } from '../../../../shared/careerMailApply';
import type { AskView, CompanyMark } from '../delivery/deliveryApi';

export const MARKS: Record<string, CompanyMark> = {
  美团: { company_id: 'c_mt', name: '美团', logo: 'mt', fill: '#ffd100' },
  京东: { company_id: 'c_jd', name: '京东', logo: 'jd' },
  大疆: { company_id: 'c_dj', name: '大疆', logo: 'dj' },
};

const SIGN = '周子航\n北京邮电大学 · 信息管理与信息系统\n138 0013 8000';

function body(role: string, points: string[], tail: string): string {
  return [
    '您好：',
    `我是北京邮电大学信息管理与信息系统专业 2027 届本科生周子航，想应聘贵司的${role}岗位。`,
    `和岗位比较贴近的有三点：\n${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
    tail,
    SIGN,
  ].join('\n\n');
}

const POINTS = [
  '负责学院公众号一年，粉丝从 3000 做到 1.2 万，单篇最高阅读 4.6 万；',
  '在字节跳动做过 3 个月用户运营实习，独立跑完两次拉新活动；',
  '会用 SQL 和 Excel 做数据分析，给社团搭过活动复盘看板。',
];

export function draft(over: Partial<MailDraftView> & Pick<MailDraftView, 'action_id' | 'company' | 'role'>): MailDraftView {
  return {
    application_id: `app_${over.action_id}`, job_id: `job_${over.action_id}`, purpose: 'apply', target: false,
    to: 'campus@example.com', cc: null,
    subject: `周子航-北京邮电大学-${over.role}-每周4天-实习6个月`,
    body: body(over.role, POINTS, '我每周可实习 4 天，可连续实习 6 个月，最早两周内到岗。简历见附件，期待您的回复。'),
    from: { account_id: 'acc_qq', address: 'zhouzihang@qq.com' },
    accounts: [{ account_id: 'acc_qq', address: 'zhouzihang@qq.com' }],
    attachments: [{ id: 'att_resume', kind: 'resume', filename: '北京邮电大学-周子航-信息管理-2027届.pdf', resume_id: 'r_tailored', resume_label: '产品运营定制版', tailored_changes: 4 }],
    resume_options: [{ id: 'r_tailored', label: '产品运营定制版' }, { id: 'r_master', label: '产品方向主简历' }],
    file_options: [], portfolio: { url: null, included: false }, wanted: [],
    blockers: [], availability: { days_per_week: '4', months: '6', start: '两周内' }, thread: null,
    ...over,
  };
}

export const SINGLE = draft({ action_id: 'm_mt', company: '美团', role: '产品运营实习生', target: true, to: 'campus-ops@meituan.example' });

export const MULTI = [
  draft({ action_id: 'm_jd', company: '京东', role: '用户运营实习生', to: 'jdcampus@jd.example' }),
  draft({ action_id: 'm_mt', company: '美团', role: '产品运营实习生', target: true, to: 'campus-ops@meituan.example' }),
  draft({ action_id: 'm_dj', company: '大疆', role: '市场策划实习生', to: 'dji-hr@dji.example',
    attachments: [{ id: 'att_resume', kind: 'resume', filename: '北京邮电大学-周子航-信息管理-2027届.pdf', resume_id: 'r_master', resume_label: '产品方向主简历', tailored_changes: null }] }),
];

/** 多附件：定制简历 + 存过的作品集文件，正文带着作品集链接那一行；岗位要成绩单还没带；存过的证书可点一下附上。 */
export const WITH_FILES = draft({
  action_id: 'm_bd', company: '字节跳动', role: '产品经理实习生', to: 'campus@bytedance.example',
  body: body('产品经理实习生', POINTS, '作品集：https://zhouzihang.design\n我每周可实习 4 天，可连续实习 6 个月，最早两周内到岗。简历见附件，期待您的回复。'),
  attachments: [
    { id: 'att_resume', kind: 'resume', filename: '北京邮电大学-周子航-信息管理-2027届.pdf', resume_id: 'r_tailored', resume_label: '产品运营定制版', tailored_changes: 3 },
    { id: 'att_pf', kind: 'file', filename: '周子航-作品集.pdf', resume_id: null, resume_label: '作品集', tailored_changes: null },
  ],
  file_options: [{ id: 'f_cert', label: '英语六级证书' }],
  portfolio: { url: 'https://zhouzihang.design', included: true },
  wanted: ['transcript'],
});

/** 跟进：投出一周没回音，三家各写好一封「再争取一下」。 */
function followup(action_id: string, company: string, role: string, to: string, text: string) {
  return draft({
    action_id, company, role, to, purpose: 'followup', availability: null,
    subject: `Re: 周子航-北京邮电大学-${role}-每周4天-实习6个月`,
    body: `您好：\n\n${text}\n\n周子航`,
    thread: { subject: `周子航-北京邮电大学-${role}-每周4天-实习6个月`, sent_at: '2026-10-29T02:00:00.000Z' },
  });
}
export const FOLLOWUPS = [
  followup('f_jd', '京东', '用户运营实习生', 'jdcampus@jd.example',
    '10 月 29 日我投了用户运营实习生。补充一点上次没提的：我在社团用 SQL 搭过活动复盘看板，岗位里写的「用数据跟踪拉新效果」我能直接上手。到岗时间也可以按团队安排提前。需要补什么材料随时告诉我。'),
  followup('f_mt', '美团', '产品运营实习生', 'campus-ops@meituan.example',
    '10 月 29 日我投了产品运营实习生。岗位里提到「商家侧活动策划」，我在字节实习时独立跑完两次拉新活动，从方案到复盘都是我做的。方便时告诉我一下进展就好。'),
  followup('f_dj', '大疆', '市场策划实习生', 'dji-hr@dji.example',
    '10 月 29 日我投了市场策划实习生。岗位要求「独立撰写传播方案」，我运营学院公众号一年，单篇最高阅读 4.6 万。每周可以来 5 天。如需作品样例我可以马上发过来。'),
];

export const BLOCKED = draft({
  action_id: 'm_jd2', company: '京东', role: '数据运营实习生', to: 'jdcampus@jd.example',
  subject: '周子航-北京邮电大学-数据运营实习生',
  body: body('数据运营实习生', POINTS, '简历见附件，期待您的回复。'),
  from: null, accounts: [], blockers: ['no_mailbox', 'availability'],
  availability: { days_per_week: null, months: null, start: null },
});

export function mailAsk(drafts: readonly MailDraftView[], title?: string): AskView {
  return {
    id: `mail_${drafts.map(d => d.action_id).join('_')}`, kind: 'review',
    title: title ?? (drafts.length > 1 ? `${drafts.length} 封邮件写好了` : `${drafts[0].company} · 邮件写好了`),
    application_ids: drafts.map(d => d.application_id ?? d.action_id),
    companies: drafts.map(d => MARKS[d.company] ?? { company_id: null, name: d.company }),
    sources: drafts.map(d => ({ type: 'action' as const, id: d.action_id })), action_ids: drafts.map(d => d.action_id),
    due_at: null, overdue: false, role: drafts.length === 1 ? drafts[0].role : undefined,
    mail: { purpose: drafts[0]?.purpose ?? 'apply', action_ids: drafts.map(d => d.action_id) },
  };
}

/** 回信：京东 HR 用另一个主题问到岗时间，回信写好了（不带附件）。 */
export const REPLY = draft({
  action_id: 'm_re', company: '京东', role: '用户运营实习生', purpose: 'reply', to: 'wangli@jd.example',
  subject: 'Re: 关于用户运营实习生岗位的到岗时间',
  body: '王老师您好：\n\n谢谢您的回复。我最早两周内可以到岗，每周可实习 4 天，能连续实习 6 个月。\n\n周子航',
  attachments: [], availability: null,
  thread: { subject: '周子航-北京邮电大学-用户运营实习生-每周4天-实习6个月', sent_at: '2026-10-29T02:00:00.000Z' },
  incoming: {
    from: '王莉 <wangli@jd.example>',
    text: '周同学你好，简历收到了，我们这边觉得比较合适。想确认一下：你最早什么时候能到岗？每周能来几天、能实习多久？方便的话今天回复一下，我们安排下一轮沟通。\n\n京东零售 · 用户增长部 王莉',
    received_at: '2026-11-05T03:12:00.000Z',
  },
});

/** 退信：大疆那封收件地址不存在，照抄一封等他改收件人重发。 */
export const BOUNCED = draft({
  action_id: 'm_bo', company: '大疆', role: '市场策划实习生', to: 'dji-hr@dji.example', blockers: ['bad_recipient'],
});

export function bouncedAsk(d: MailDraftView = BOUNCED): AskView {
  return { ...mailAsk([d], `${d.company} · 邮件被退回`), mail: { purpose: 'apply', action_ids: [d.action_id], bounced: true } };
}

/** 等你条上「N 封没发出去 / 没写成」那件。 */
export function failedMailAsk(failed: AskMailFailed, ids: string[] = ['m_jd', 'm_mt']): AskView {
  const title = failed.stage === 'draft' ? `${ids.length} 封没写成` : `${ids.length} 封没发出去`;
  return {
    id: `fail_mail_${failed.stage}_${failed.reauth ? 'auth' : 'other'}`, kind: 'failed', title,
    detail: failed.reauth ? '邮箱授权失效了' : undefined,
    application_ids: ids.map(id => `app_${id}`), companies: [MARKS.京东, MARKS.美团].slice(0, ids.length),
    sources: ids.map(id => ({ type: 'action' as const, id })), action_ids: ids,
    due_at: null, overdue: false, mail_failed: failed,
  };
}

/** 京东那份的邮件往来：发出的投递邮件 → 对方回信 → 写好待发的回信。 */
export const THREAD: MailThreadView = {
  application_id: 'app_m_re', company: '京东', role: '用户运营实习生',
  items: [
    { id: 'mm_out', direction: 'out', purpose: 'apply', counterpart: 'jdcampus@jd.example', subject: '周子航-北京邮电大学-用户运营实习生-每周4天-实习6个月',
      body: '您好：\n\n我是北京邮电大学信息管理与信息系统专业 2027 届本科生周子航，想应聘贵司的用户运营实习生岗位。', attachments: ['北京邮电大学-周子航-信息管理-2027届.pdf'],
      at: '2026-10-29T02:00:00.000Z', action_id: null, kind: null },
    { id: 'mm_auto', direction: 'in', purpose: null, counterpart: 'jdcampus@jd.example', subject: '自动回复：已收到您的邮件', body: '您好，您的邮件已收到，我们会尽快处理。', attachments: [],
      at: '2026-10-29T02:01:00.000Z', action_id: null, kind: 'application_received' },
    { id: 'mm_in', direction: 'in', purpose: null, counterpart: '王莉 <wangli@jd.example>', subject: '关于用户运营实习生岗位的到岗时间', body: REPLY.incoming?.text ?? '', attachments: [],
      at: '2026-11-05T03:12:00.000Z', action_id: null, kind: null },
    { id: 'mm_pending', direction: 'pending', purpose: 'reply', counterpart: 'wangli@jd.example', subject: REPLY.subject, body: REPLY.body,
      attachments: [], at: '2026-11-05T03:20:00.000Z', action_id: 'm_re', kind: null },
    { id: 'mm_iv', direction: 'in', purpose: null, counterpart: 'interview@jd.example', subject: '用户运营实习生 · 一面安排',
      body: '周同学好，邀请你参加 11 月 8 日（周六）15:00 的线上一面，会议链接稍后发你。', attachments: [],
      at: '2026-11-05T05:00:00.000Z', action_id: null, kind: 'interview_invite' },
  ],
};
