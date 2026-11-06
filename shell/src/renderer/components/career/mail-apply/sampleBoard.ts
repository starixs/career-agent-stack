/**
 * 邮件投递工作台第一次打开时的示例（2026-11-06 用户：「不能做一个大片空白的占位页，要让用户看到我们的内容」）。
 * 他还没有自己的邮件申请时，右边一列是这几份示例，主区是其中一份的四步路和整封示例邮件；有了第一份真的，示例全部消失。
 * 示例公司、邮箱（example.com）、人名都是编的，不对应真实的公司和人；页面上标一枚「示例」章，按钮不可点。
 */
import type { MailBoardRow, MailDraftView, MailThreadView } from '../../../../shared/careerMailApply';

const row = (over: Partial<MailBoardRow> & Pick<MailBoardRow, 'key' | 'station' | 'role'> & { name: string }): MailBoardRow => {
  const { name, ...rest } = over;
  return {
    job_id: `sample_job_${over.key}`, application_id: `sample_app_${over.key}`, company: { company_id: null, name },
    city: null, deadline: null, target: false, waiting: null, action_id: null, ask_id: null, sent_at: null, reply_kind: null, reply_at: null,
    ...rest,
  };
};

export const SAMPLE_ROWS: readonly MailBoardRow[] = [
  row({ key: 'xh', name: '星河科技', role: '产品运营实习生', station: 'waiting', waiting: 'apply', action_id: 'sample_mail_xh' }),
  row({ key: 'qy', name: '青柚教育', role: '用户研究实习生', station: 'replied', reply_kind: 'interview_invite', sent_at: '2026-10-28T02:00:00.000Z', reply_at: '2026-11-03T03:00:00.000Z' }),
  row({ key: 'ys', name: '云杉数据', role: '数据运营实习生', station: 'sent', sent_at: '2026-11-02T02:00:00.000Z' }),
  row({ key: 'sg', name: '松果出行', role: '市场策划实习生', station: 'writing' }),
];

const SAMPLE_BODY = [
  '您好：',
  '我是示例大学信息管理专业 2027 届本科生林小满，想应聘贵司的产品运营实习生岗位。',
  '和岗位比较贴近的有三点：\n1. 运营学院公众号一年，粉丝从 3000 做到 1.2 万；\n2. 做过 3 个月用户运营实习，独立跑完两次拉新活动；\n3. 会用 SQL 和 Excel 做数据分析，搭过活动复盘看板。',
  '我每周可实习 4 天，可连续实习 6 个月，最早两周内到岗。简历见附件，期待您的回复。',
  '林小满\n示例大学 · 信息管理与信息系统',
].join('\n\n');

export const SAMPLE_DRAFT: MailDraftView = {
  action_id: 'sample_mail_xh', application_id: 'sample_app_xh', job_id: 'sample_job_xh', purpose: 'apply',
  company: '星河科技', role: '产品运营实习生', target: false,
  to: 'campus@example.com', cc: null, subject: '林小满-示例大学-产品运营实习生-每周4天-实习6个月', body: SAMPLE_BODY,
  from: { account_id: 'sample_account', address: 'linxiaoman@example.com' }, accounts: [{ account_id: 'sample_account', address: 'linxiaoman@example.com' }],
  attachments: [{ id: 'sample_resume', kind: 'resume', filename: '示例大学-林小满-信息管理-2027届.pdf', resume_id: null, resume_label: '产品运营定制版', tailored_changes: 4 }],
  resume_options: [], file_options: [], portfolio: { url: null, included: false }, wanted: [],
  blockers: [], availability: { days_per_week: '4', months: '6', start: '两周内' }, thread: null,
};

const out = (key: string, role: string, at: string): MailThreadView['items'][number] => ({
  id: `sample_out_${key}`, direction: 'out', purpose: 'apply', counterpart: 'campus@example.com',
  subject: `林小满-示例大学-${role}-每周4天-实习6个月`, body: SAMPLE_BODY, attachments: ['示例大学-林小满-信息管理-2027届.pdf'],
  at, action_id: null, kind: null,
});

export const SAMPLE_THREADS: Record<string, MailThreadView> = {
  sample_app_qy: {
    application_id: 'sample_app_qy', company: '青柚教育', role: '用户研究实习生',
    items: [
      out('qy', '用户研究实习生', '2026-10-28T02:00:00.000Z'),
      { id: 'sample_in_qy', direction: 'in', purpose: null, counterpart: 'hr@example.com', subject: '用户研究实习生 · 一面安排',
        body: '林同学好，邀请你参加下周二 15:00 的线上一面，会议链接稍后发你。', attachments: [], at: '2026-11-03T03:00:00.000Z', action_id: null, kind: 'interview_invite' },
    ],
  },
  sample_app_ys: { application_id: 'sample_app_ys', company: '云杉数据', role: '数据运营实习生', items: [out('ys', '数据运营实习生', '2026-11-02T02:00:00.000Z')] },
};
