/** 开放题和自我介绍第一次打开时预设的一篇：给某家公司、确认过的「为什么选我们」，展开着；只摆这一篇。 */
import type { Material } from '../../types';

import { daysFromNow } from './sampleMode';

export const SAMPLE_MATERIALS: Material[] = [
  {
    id: 'sample_mat_1', kind: 'why_company', title: '为什么选星河科技', question_key: 'why_company', length_variant: 'medium',
    content: '我在实习里做的是把运营的重复配置工作变成可视化的规则，这和贵司平台团队正在做的事情是同一类问题。\n\n我想继续在这个方向上把一件事做深，而不是换一个场景重新开始。',
    claim_ids_json: '[]', tags_json: '[]', company_scope: '星河科技', confirmed: 1, created_at: daysFromNow(-3), updated_at: daysFromNow(-3),
  },
];
