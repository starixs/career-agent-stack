import type { TabBase } from '@/tab-workspace/contracts';

/** 「浏览器现场」页签：实时看助理在托管浏览器里的操作 + 批量投递进度。单实例，无持久化；关掉不影响后台运行。 */
export type CareerLiveTab = TabBase<'career-live'>;
