/**
 * 测试与组件预览用的邮件夹具（按 shared/careerMailApply.ts 合同造，服务端没好之前前端照它写）。
 * 只给测试和预览 import，产品代码不引用。
 */
import type { MailDraftView } from '../../../../shared/careerMailApply';
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
    attachments: [{ filename: '北京邮电大学-周子航-信息管理-2027届.pdf', resume_id: 'r_tailored', resume_label: '产品运营定制版', tailored_changes: 4 }],
    resume_options: [{ id: 'r_tailored', label: '产品运营定制版' }, { id: 'r_master', label: '产品方向主简历' }],
    blockers: [], availability: { days_per_week: '4', months: '6', start: '两周内' }, thread: null,
    ...over,
  };
}

export const SINGLE = draft({ action_id: 'm_mt', company: '美团', role: '产品运营实习生', target: true, to: 'campus-ops@meituan.example' });

export const MULTI = [
  draft({ action_id: 'm_jd', company: '京东', role: '用户运营实习生', to: 'jdcampus@jd.example' }),
  draft({ action_id: 'm_mt', company: '美团', role: '产品运营实习生', target: true, to: 'campus-ops@meituan.example' }),
  draft({ action_id: 'm_dj', company: '大疆', role: '市场策划实习生', to: 'dji-hr@dji.example',
    attachments: [{ filename: '北京邮电大学-周子航-信息管理-2027届.pdf', resume_id: 'r_master', resume_label: '产品方向主简历', tailored_changes: null }] }),
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
