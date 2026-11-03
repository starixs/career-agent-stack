import type { TabBase } from '@/tab-workspace/contracts';

/** 「接管简报」页的 Tab 载荷。单实例，无持久化；看哪个邮箱的简报由 career:focus 的 id 决定（缺省最近一份）。 */
export type CareerTakeoverTab = TabBase<'career-takeover'>;
