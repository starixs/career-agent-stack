/**
 * 正文框按内容长高（F1）：整封都露出来，直到整张卡碰到卡组的上限（读卡组算出来的 max-height：
 * 邮件那几张是 mail-apply.css .cd-deck-mail 的 min(760px, 100vh - 200px)，其它是 delivery.css 的 520），
 * 再在正文框里滚。不在卡组里（网申进展页）时按一个固定上限。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** 再矮就不像一封信了：约四行（14px × 1.6 行高 + 上下内边距）。 */
const BODY_MIN_PX = 112;
/** 不在卡组里时正文框最高多少（进展页右侧够放一封投递邮件的全文）。 */
const BODY_CAP_OUTSIDE_DECK_PX = 440;

/** 卡组里除了正文框以外的内容占多高 → 正文框还能长多高。 */
function capInDeck(el: HTMLTextAreaElement): number {
  const deck = el.closest<HTMLElement>('.cd-deck');
  if (!deck) return BODY_CAP_OUTSIDE_DECK_PX;
  const max = Number.parseFloat(getComputedStyle(deck).maxHeight);
  if (!Number.isFinite(max)) return BODY_CAP_OUTSIDE_DECK_PX;
  const others = deck.scrollHeight - el.offsetHeight;
  return max - others;
}

export function fitBody(el: HTMLTextAreaElement): void {
  const deck = el.closest<HTMLElement>('.cd-deck');
  const keep = deck?.scrollTop ?? 0;
  el.style.height = `${BODY_MIN_PX}px`;
  const border = el.offsetHeight - el.clientHeight;
  const natural = el.scrollHeight + border;
  // 量不出尺寸（不在页面上、测试环境）：留在最小高度，框内滚动照常
  if (!natural) return;
  const height = Math.max(BODY_MIN_PX, Math.min(natural, capInDeck(el)));
  el.style.height = `${height}px`;
  if (deck) deck.scrollTop = keep;
}

/** 返回给 textarea 的 ref；字变了、窗口变了都重算。 */
export function useAutoGrow(text: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = useCallback(() => { if (ref.current) fitBody(ref.current); }, []);
  useLayoutEffect(fit, [text, fit]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);
  return ref;
}
