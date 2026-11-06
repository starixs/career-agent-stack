/**
 * 一份网申从「选中开投」到「投出」的整条链路，服务端和界面共用这一份顺序。
 *
 * 2026-11-06 用户：流程的起点不是「打开网页」，是从他批量选完开始投——选中、定制简历、打开网页、填写、过目、投出；
 * 界面用图形把「走到哪一环」画出来，不靠句子。进度事件带上 stage（走到哪一环）和 cells（格子填了多少），界面只管画。
 */
export const APPLY_STAGES = ['picked', 'tailor', 'open', 'fill', 'review', 'send'] as const;
export type ApplyStage = typeof APPLY_STAGES[number];

/** 每一环在界面上的名字（节点下面的小字，不是句子）。 */
export const APPLY_STAGE_NAMES: Record<ApplyStage, string> = {
  picked: '选中', tailor: '定制简历', open: '打开网页', fill: '填写', review: '你过目', send: '投出',
};

export function isApplyStage(v: unknown): v is ApplyStage {
  return typeof v === 'string' && (APPLY_STAGES as readonly string[]).includes(v);
}

/** 链路只往前走：同一趟里后来的事件不会把它拉回前面一环（填到一半弹了个登录框不算回到「打开网页」）。 */
export function laterStage(a: ApplyStage | undefined, b: ApplyStage | undefined): ApplyStage | undefined {
  if (!a) return b;
  if (!b) return a;
  return APPLY_STAGES.indexOf(b) > APPLY_STAGES.indexOf(a) ? b : a;
}

/** 这张表的格子：一共要填几格、填好几格、还有几格等他。 */
export interface ApplyCells { total: number; done: number; you: number }

export function parseApplyCells(v: unknown): ApplyCells | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { total, done, you } = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
  const t = n(total); const d = n(done);
  if (t === null || d === null || t === 0) return undefined;
  return { total: t, done: Math.min(d, t), you: Math.min(n(you) ?? 0, t) };
}
