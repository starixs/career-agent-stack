/**
 * 邮件投递工作台的夹具（按 shared/careerMailApply.ts 合同造；只给测试和组件预览用，产品代码不引用）。
 * 十几份实习投递分布在五站上，和服务端 board.ts 的站位规则一致：一份只在一站。
 */
import type { MailBoardRow, MailBoardView, MailCompanyMark, MailSetupView } from '../../../../shared/careerMailApply';
import { BOUNCED, FOLLOWUPS, REPLY, SINGLE } from './testFixtures';

const MARK: Record<string, MailCompanyMark> = {
  美团: { company_id: 'c_mt', name: '美团', logo: 'mt', fill: '#ffd100' },
  京东: { company_id: 'c_jd', name: '京东', logo: 'jd' },
  大疆: { company_id: 'c_dj', name: '大疆', logo: 'dj' },
  字节跳动: { company_id: 'c_zj', name: '字节跳动', logo: 'zj' },
  拼多多: { company_id: 'c_pdd', name: '拼多多', logo: 'pdd' },
  华为: { company_id: 'c_hw', name: '华为', logo: 'hw' },
  科大讯飞: { company_id: 'c_xf', name: '科大讯飞', logo: 'xf' },
  理想汽车: { company_id: 'c_lx', name: '理想汽车', logo: 'lx' },
  阿里巴巴: { company_id: 'c_al', name: '阿里巴巴', logo: 'al' },
  荣耀: { company_id: 'c_ry', name: '荣耀', logo: 'ry' },
  小红书: { company_id: 'c_xhs', name: '小红书' },
  得物: { company_id: 'c_dw', name: '得物' },
};

export const BOARD_NOW = new Date('2026-11-06T10:00:00+08:00');
const daysAgo = (n: number) => new Date(BOARD_NOW.getTime() - n * 86_400_000).toISOString();

export function boardRow(over: Partial<MailBoardRow> & Pick<MailBoardRow, 'key' | 'station' | 'role'> & { co: string }): MailBoardRow {
  const { co, ...rest } = over;
  return {
    job_id: `job_${over.key}`, application_id: over.station === 'ready' ? null : over.key, company: MARK[co] ?? { company_id: null, name: co },
    city: '北京', deadline: null, target: false, waiting: null, action_id: null, ask_id: null, sent_at: null, reply_kind: null, reply_at: null,
    ...rest,
  };
}

export const READY_ROWS = [
  boardRow({ key: 'r_xhs', co: '小红书', role: '内容运营实习生', station: 'ready', deadline: '2026-11-20', target: true }),
  boardRow({ key: 'r_dw', co: '得物', role: '用户研究实习生', station: 'ready', deadline: '2026-11-15' }),
  boardRow({ key: 'r_al', co: '阿里巴巴', role: '产品运营实习生', station: 'ready' }),
  boardRow({ key: 'r_al2', co: '阿里巴巴', role: '数据运营实习生', station: 'ready', deadline: '2026-11-28' }),
];

export const WRITING_ROWS = [
  boardRow({ key: 'w_ry', co: '荣耀', role: '市场营销实习生', station: 'writing' }),
];

/** 等你：投递、回信、再争取、被退回各一行，外加一行没发出去。动作 id 对得上 testFixtures 里的预览。 */
export const WAITING_ROWS = [
  boardRow({ key: 'a_mt', co: '美团', role: SINGLE.role, station: 'waiting', waiting: 'apply', action_id: SINGLE.action_id, ask_id: 'ask_apply', target: true }),
  boardRow({ key: 'a_jd', co: '京东', role: REPLY.role, station: 'waiting', waiting: 'reply', action_id: REPLY.action_id, ask_id: 'ask_reply' }),
  boardRow({ key: 'a_dj', co: '大疆', role: FOLLOWUPS[2].role, station: 'waiting', waiting: 'followup', action_id: FOLLOWUPS[2].action_id, ask_id: 'ask_follow' }),
  boardRow({ key: 'a_bo', co: '拼多多', role: BOUNCED.role, station: 'waiting', waiting: 'bounced', action_id: BOUNCED.action_id, ask_id: 'ask_bounce' }),
  boardRow({ key: 'a_hw', co: '华为', role: '运营管培实习生', station: 'waiting', waiting: 'failed_send', ask_id: 'fail_mail_send_auth' }),
];

/** 等你那几封的整封预览（BOUNCED 换成拼多多）。 */
export const WAITING_DRAFTS = [SINGLE, REPLY, FOLLOWUPS[2], { ...BOUNCED, company: '拼多多' }];

export const SENT_ROWS = [
  boardRow({ key: 's_zj', co: '字节跳动', role: '产品经理实习生', station: 'sent', sent_at: daysAgo(1) }),
  boardRow({ key: 's_xf', co: '科大讯飞', role: '用户运营实习生', station: 'sent', sent_at: daysAgo(4) }),
  boardRow({ key: 's_lx', co: '理想汽车', role: '战略分析实习生', station: 'sent', sent_at: daysAgo(8) }),
];

export const REPLIED_ROWS = [
  boardRow({ key: 'p_jd', co: '京东', role: '用户运营实习生', station: 'replied', reply_kind: 'interview_invite', sent_at: daysAgo(6), reply_at: daysAgo(1), application_id: 'app_m_re' }),
  boardRow({ key: 'p_mt', co: '美团', role: '商家运营实习生', station: 'replied', reply_kind: 'reply', sent_at: daysAgo(5), reply_at: daysAgo(2) }),
  boardRow({ key: 'p_hw', co: '华为', role: '数据分析实习生', station: 'replied', reply_kind: 'written_test', sent_at: daysAgo(9), reply_at: daysAgo(3) }),
  boardRow({ key: 'p_dw', co: '得物', role: '品牌策划实习生', station: 'replied', reply_kind: 'rejection', sent_at: daysAgo(10), reply_at: daysAgo(4) }),
];

export const SETUP: MailSetupView = {
  mailbox: { account_id: 'acc_qq', address: 'zhouzihang@qq.com' },
  availability: { days_per_week: '4', months: '6', start: '两周内' },
  files: [{ id: 'f_pf', label: '作品集' }, { id: 'f_cert', label: '英语六级证书' }],
  portfolio_url: 'https://zhouzihang.design',
  direct_send: 'off',
  has_resume: true,
};

export const FULL_BOARD: MailBoardView = {
  rows: [...WAITING_ROWS, ...WRITING_ROWS, ...REPLIED_ROWS, ...SENT_ROWS, ...READY_ROWS],
  setup: SETUP,
};

export const EMPTY_BOARD: MailBoardView = {
  rows: [],
  setup: { mailbox: null, availability: { days_per_week: null, months: null, start: null }, files: [], portfolio_url: null, direct_send: 'off', has_resume: true },
};

