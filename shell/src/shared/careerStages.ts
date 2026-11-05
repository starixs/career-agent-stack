/**
 * 「投出去过」的投递阶段：渲染端（我的进度、右栏）和服务端（批量投去重、回执、汇总表）共用这一份。
 *
 * pending 不算：它是「等我拍板 / 还没投出去」的中间态，算进来会把没投的数成已投。
 * discarded / skip 也不算：用户放弃或跳过，没真的投。
 */
export const SUBMITTED_STAGES = ['applied', 'responded', 'interview', 'offer', 'rejected', 'hired'] as const;
export type SubmittedStage = typeof SUBMITTED_STAGES[number];

const SUBMITTED_STAGE_SET: ReadonlySet<string> = new Set(SUBMITTED_STAGES);

/** 这个阶段算不算已经投出去。 */
export function isSubmittedStage(stage: string): boolean {
  return SUBMITTED_STAGE_SET.has(stage);
}
