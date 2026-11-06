/**
 * 邮件投递工作台第一次打开时的预设内容（2026-11-06 用户：「不能做一个大片空白的占位页」；
 * 同日纠正：「他就能看到初始效果就可以了」——只摆一封「邮件写好了」，不摆各个阶段，也不写「示例」二字）。
 * 他还没有自己的邮件申请时，主区就是卡组里那张单封的样子（MailPresetCard），用这一封渲染；有了第一份真的，整块消失。
 * 公司、邮箱（example.com）、人名、学校都是编的，不对应真实的公司和人。
 */
import type { MailDraftView } from '../../../../shared/careerMailApply';
import type { CompanyMark } from '../delivery/deliveryApi';

export const PRESET_COMPANY: CompanyMark = { company_id: null, name: '星河科技' };

const PRESET_BODY = [
  '您好：',
  '我是江南理工大学信息管理与信息系统专业 2027 届本科生林小满，想应聘贵司的产品运营实习生岗位。',
  '和岗位比较贴近的有三点：\n1. 运营学院公众号一年，粉丝从 3000 做到 1.2 万；\n2. 做过 3 个月用户运营实习，独立跑完两次拉新活动；\n3. 会用 SQL 和 Excel 做数据分析，搭过活动复盘看板。',
  '我每周可实习 4 天，可连续实习 6 个月，最早两周内到岗。简历见附件，期待您的回复。',
  '林小满\n江南理工大学 · 信息管理与信息系统',
].join('\n\n');

export const PRESET_DRAFT: MailDraftView = {
  action_id: 'preset_mail', application_id: 'preset_app', job_id: 'preset_job', purpose: 'apply',
  company: PRESET_COMPANY.name, role: '产品运营实习生', target: true,
  to: 'campus@example.com', cc: null, subject: '林小满-江南理工大学-产品运营实习生-每周4天-实习6个月', body: PRESET_BODY,
  from: { account_id: 'preset_account', address: 'linxiaoman@example.com' }, accounts: [{ account_id: 'preset_account', address: 'linxiaoman@example.com' }],
  attachments: [{ id: 'preset_resume', kind: 'resume', filename: '江南理工大学-林小满-信息管理-2027届.pdf', resume_id: null, resume_label: '产品运营定制版', tailored_changes: 4 }],
  resume_options: [{ id: 'preset_tailored', label: '产品运营定制版' }, { id: 'preset_master', label: '产品方向主简历' }],
  file_options: [], portfolio: { url: null, included: false }, wanted: [],
  blockers: [], availability: { days_per_week: '4', months: '6', start: '两周内' }, thread: null,
};
