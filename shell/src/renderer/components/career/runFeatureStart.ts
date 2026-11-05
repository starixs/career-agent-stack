/**
 * 一个功能"起头"（plan-r3-suggest §4.4）：功能市场的卡和下一步条的起头格走同一个执行器。
 * open 打开一页；prefill 一句话：完整句直接发出，冒号收尾 / 带空的填进输入框等他补；batch 回对话放一张批量勾选表。
 */
import { requestNavigation } from '@/features/career-shell/navModel';

import { openBatchPick } from './BatchPickCard';
import { suggestToChat } from './CareerPrimitives';
import type { FeatureStart } from '../../../shared/careerFeatures';

/** 预填句要他接着补（冒号收尾或带空）时才只填进输入框；完整的一句直接发出去，点了就开始。 */
const NEEDS_MORE = /[：:]\s*$|_{2,}|＿/;

export function prefillMode(text: string): 'prefill' | 'send' {
  return NEEDS_MORE.test(text) ? 'prefill' : 'send';
}

export function runFeatureStart(start: FeatureStart, note: string): void {
  if ('prefill' in start) {
    suggestToChat(start.prefill, { surface: 'guide', note }, prefillMode(start.prefill));
    return;
  }
  if ('batch' in start) {
    void openBatchPick();
    return;
  }
  requestNavigation(start.open);
}
