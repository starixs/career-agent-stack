/**
 * 六个一级功能页（pages/Career*.tsx）与 Tab 壳之间的松耦合契约。
 *
 * 功能页可以声明接收这些 props，也可以完全不声明（React 会忽略多余的 props）；
 * Tab 模块统一按这个形状传参，页面实现与壳可以独立演进。
 */
export interface CareerPageProps {
  /** 当前 Tab 是否处于激活态（用于暂停后台轮询等）。 */
  isActive: boolean;
  /** 回到唯一的个人助理对话。 */
  onOpenChat: () => void;
  /** 作为另一个面的视图嵌入时为 true（不渲染页头）。 */
  embedded?: boolean;
}

export interface CareerPageRenderBinding {
  onOpenChat: () => void;
}
