/** 回音归类的示例：最近认出来的几封来信，各认成什么、挂到了哪家的申请。寄件人只写到公司的招聘组，不带邮箱。 */
import type { TriageRow } from '../results/TriageList';

import { daysFromNow } from './sampleMode';

export const SAMPLE_TRIAGE: TriageRow[] = [
  { id: 'sample_mail_1', subject: '星河科技 Java 后端开发工程师 二面邀请', from: '星河科技招聘组', kind: 'interview_invite', company: '星河科技', at: daysFromNow(-1) },
  { id: 'sample_mail_2', subject: '云图智能 2027 校招在线笔试通知', from: '云图智能校园招聘', kind: 'written_test', company: '云图智能', at: daysFromNow(-2) },
  { id: 'sample_mail_3', subject: '海岳数据 职业性格测评邀请', from: '海岳数据 HR', kind: 'assessment', company: '海岳数据', at: daysFromNow(-3) },
  { id: 'sample_mail_4', subject: '感谢你对青禾出行的关注', from: '青禾出行招聘', kind: 'rejection', company: '青禾出行', at: daysFromNow(-4) },
];
