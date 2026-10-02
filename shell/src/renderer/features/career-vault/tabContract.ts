import type { TabBase } from '@/tab-workspace/contracts';

/** 「私密信息」页的 Tab 载荷。单实例，无持久化。
 * 可带一个 focusExperienceId：从经历库跳过来时定位到该经历的保密补充。 */
export interface CareerVaultTab extends TabBase<'career-vault'> {
  readonly focusExperienceId?: string;
}
