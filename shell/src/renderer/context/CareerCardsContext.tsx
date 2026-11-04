/**
 * 求职流程卡片的独立 Context：Message 列表里每条回复都要按工具调用 id 找自己的卡片，
 * 如果直接读 TabContext，流式输出时每个 token 都会让所有消息重渲染。
 * 这里的值只在卡片集合变化时更新（TabProvider 里 useMemo）。
 */
import { createContext, useContext } from 'react';

import type { CareerCard, CareerCardState } from '@/components/career/types';

export interface CareerCardsContextValue {
  cards: CareerCard[];
  setState: (id: string, state: CareerCardState) => void;
  /** 审核卡片上的批准 / 拒绝（经本会话的 Session 路由回传）；缺省时卡片退回 Global 路由。 */
  respondReview?: (actionIds: string[], decision: 'approved' | 'rejected') => Promise<boolean>;
  /** 对话里被后来的同一对象顶掉的工具调用 id：那几次不再出信息卡（features/career-shell/supersede.ts）。 */
  supersededTools?: ReadonlySet<string>;
}

const EMPTY: CareerCardsContextValue = { cards: [], setState: () => {} };

export const CareerCardsContext = createContext<CareerCardsContextValue>(EMPTY);

export function useCareerCards(): CareerCardsContextValue {
  return useContext(CareerCardsContext);
}
