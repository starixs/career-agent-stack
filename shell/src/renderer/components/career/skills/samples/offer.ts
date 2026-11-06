/** Offer 对比的示例：手上两个 Offer，一个两天后要答复、年包写全了，一个只写了月薪。公司是虚构的。 */
import type { Offer } from '../../types';

import { daysFromNow } from './sampleMode';

export const SAMPLE_OFFERS: Offer[] = [
  {
    id: 'sample_off_1', application_id: null, company_name: '星河科技', title: 'Java 后端开发工程师',
    comp_json: JSON.stringify({ base: 22000, months: 15, signing: 20000, total: 350000 }), location: '杭州',
    content_match: '和实习做的是同一类问题', risk_notes: '试用期六个月', deadline: daysFromNow(2), created_at: daysFromNow(-1), updated_at: daysFromNow(-1),
  },
  {
    id: 'sample_off_2', application_id: null, company_name: '云图智能', title: 'AI 应用开发工程师',
    comp_json: JSON.stringify({ base: 25000, months: 13 }), location: '上海',
    content_match: null, risk_notes: null, deadline: daysFromNow(9), created_at: daysFromNow(-2), updated_at: daysFromNow(-2),
  },
];
