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

/** 某一环里做过的一类事和次数（链路往下分的那一小枝上的一片叶子）。 */
export interface TrailStep { stage: ApplyStage; kind: string; count: number }

/** 记一笔这一环做的这类事；链路往回走了（同一份重头再来）就从头记。服务端存的和界面边收边记的用同一套算法。 */
export function nextTrail(trail: readonly TrailStep[] | undefined, before: ApplyStage | undefined, stage: ApplyStage | undefined, kind: string | undefined): readonly TrailStep[] | undefined {
  const restarted = !!before && !!stage && APPLY_STAGES.indexOf(stage) < APPLY_STAGES.indexOf(before);
  const kept = restarted ? [] : trail ?? [];
  if (!stage || !kind) return restarted ? kept : trail;
  const hit = kept.find(t => t.stage === stage && t.kind === kind);
  return hit ? kept.map(t => (t === hit ? { ...t, count: t.count + 1 } : t)) : [...kept, { stage, kind, count: 1 }];
}

/**
 * 一份网申走到哪了：服务端按申请存下来（重启、界面重新加载都还在），随现场的标签列表一起给界面；
 * 每个标签下面的那棵树画的是它自己这一份（2026-11-06 用户：「树没有跟着标签走…要有对应和持久化」）。
 * state：working 小芽在办 / ready 填好等他投出 / done 投出了 / failed 没办成。
 */
export interface ApplyProgress {
  stage?: ApplyStage;
  state: 'working' | 'ready' | 'done' | 'failed';
  kind?: string;
  trail: readonly TrailStep[];
  cells?: ApplyCells;
}

const PROGRESS_STATES: ReadonlyArray<ApplyProgress['state']> = ['working', 'ready', 'done', 'failed'];

/** 跨边界（接口返回 / 存储读出）来的进度先过一遍：认不出的字段丢掉，整个不像就不要。 */
export function parseApplyProgress(v: unknown): ApplyProgress | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const raw = v as Record<string, unknown>;
  const state = PROGRESS_STATES.find(s => s === raw.state);
  if (!state) return undefined;
  const trail = (Array.isArray(raw.trail) ? raw.trail : []).flatMap((t): TrailStep[] => {
    if (!t || typeof t !== 'object') return [];
    const { stage, kind, count } = t as Record<string, unknown>;
    return isApplyStage(stage) && typeof kind === 'string' && typeof count === 'number' && count > 0 ? [{ stage, kind, count }] : [];
  });
  const cells = parseApplyCells(raw.cells);
  return {
    state, trail,
    ...(isApplyStage(raw.stage) ? { stage: raw.stage } : {}), ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}), ...(cells ? { cells } : {}),
  };
}
