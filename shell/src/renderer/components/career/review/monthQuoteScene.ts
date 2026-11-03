/**
 * 我的求职月：按这个月走到哪一步，决定漏斗页手写语句用哪一组（quotes.json 里的 funnel-* 场景）。
 * 有 Offer → 收获；有笔试 / 面试 → 推进；还没投出 → 起步；投出了还没进展：一半以上还在路上 → 等待，
 * 否则大多已经回来（被拒或关闭）→ 受挫。
 */
import type { QuoteScene } from '@/components/career/handwriting/handwritingPlan';
import type { MonthBoard } from '@/components/career/types';

// 投出的里面，还在路上的占到这个比例及以上，算「等待」而不是「受挫」。
const WAITING_SHARE = 0.5;

export function monthQuoteScene(board: Pick<MonthBoard, 'counts' | 'in_transit'>): QuoteScene {
  const [sent, exams, interviews, offers] = board.counts;
  if (offers > 0) return 'funnel-offer';
  if (exams + interviews > 0) return 'funnel-interview';
  if (sent === 0) return 'funnel-start';
  return board.in_transit >= sent * WAITING_SHARE ? 'funnel-waiting' : 'funnel-setback';
}
