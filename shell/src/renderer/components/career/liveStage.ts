/**
 * 网申现场里「这一家到哪一步了」：顶上的标签和下面的链路用同一个判断，两处不会说两样的话。
 *
 * 2026-11-06 用户看网申现场：顶上下拉框写「公司 · 岗位 · 等你」，底下面板又列一遍全部任务，停下来等他的几家还写着「进行中」。
 * 状态不靠文字拼接，靠这里算出来的一个值，各处用图形和颜色画。
 * 链路是从他选中开投算起的整条（shared/careerApplyStage.ts），不是从「打开网页」算起。
 */
import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

import { APPLY_STAGES, type ApplyStage } from '../../../shared/careerApplyStage';

/** waiting：停下等他（登录 / 验证码 / 补信息）；ready：填好了等他过目投出；sending：正在提交。 */
export type LiveStatus = 'queued' | 'filling' | 'waiting' | 'ready' | 'sending' | 'done' | 'failed';

export function liveStatusOf(page: { waiting: string | null } | undefined, run: ProgressRun | undefined): LiveStatus {
  if (page?.waiting) return 'waiting';
  if (!run) return 'queued';
  if (run.failed) return 'failed';
  if (run.ready) return 'ready';
  if (run.finished) return 'done';
  return run.steps.at(-1)?.phase.startsWith('submit') ? 'sending' : 'filling';
}

const at = (stage: ApplyStage) => APPLY_STAGES.indexOf(stage);
/** 停下等他时卡在哪一环（服务端没报到哪一环时的估计）：登录 / 验证是进门前的事，最终提交确认在投出那一环，其余在填写中途。 */
const WAITING_AT: Record<string, ApplyStage> = { login: 'open', '2fa': 'open', captcha: 'open', submit_confirm: 'send' };

export interface StagePosition {
  /** 正在哪一环（APPLY_STAGES 的下标）；全部做完是 APPLY_STAGES.length。 */
  current: number;
  /** 这一环的样子：working 小芽在做 / you 等他 / failed 没做成 / idle 还没轮到。 */
  tone: 'working' | 'you' | 'failed' | 'idle';
}

/** 链路上的位置：服务端报了走到哪一环就用它；没报（旧事件、重启后只剩等他的记录）按状态估一个。 */
export function stagePosition(status: LiveStatus, waiting: string | null, stage?: ApplyStage): StagePosition {
  const known = stage ? at(stage) : null;
  switch (status) {
    // 选中是他做的那一下，已经做完；还没轮到小芽动手
    case 'queued': return { current: at('tailor'), tone: 'idle' };
    case 'waiting': return { current: known ?? at(WAITING_AT[waiting ?? ''] ?? 'fill'), tone: 'you' };
    case 'filling': return { current: known ?? at('fill'), tone: 'working' };
    case 'failed': return { current: known ?? at('fill'), tone: 'failed' };
    case 'ready': return { current: at('review'), tone: 'you' };
    case 'sending': return { current: at('send'), tone: 'working' };
    case 'done': return { current: APPLY_STAGES.length, tone: 'idle' };
  }
}

/** 等他的那一环下面的小字：说清等他做哪一下（四五个字，不是句子）。 */
const WAITING_CAPTION: Record<string, string> = {
  login: '等你登录', '2fa': '等你验证', captcha: '等你过验证', missing_info: '等你补几项', assessment: '等你作答', submit_confirm: '等你确认',
  // user_request 这个原因码引擎也用在「页面弹了个对话框，拿不准点哪个」上：对他来说是要他看一眼，不是他在操作
  user_request: '等你看一眼',
};
/** 每一环里的子过程叫什么：固定几个词，说的是哪类事，不复述具体做了什么。 */
const LEAF_NAMES: Record<string, string> = {
  resume: '改简历', navigate: '打开网址', jd: '读岗位', entry: '进申请表', upload: '传简历', field: '填格子', section: '填经历', page: '看这一页', blocker: '关弹窗', stop: '核对', submit: '提交',
};
/** 这一环走到了、但没有记到具体做了什么（刚重启、旧事件）时，枝上放的那一片叶子。 */
const DEFAULT_LEAF: Record<ApplyStage, string> = { picked: '你选的', tailor: '改简历', open: '打开网址', fill: '填格子', review: '核对', send: '提交' };

/** 枝上的一片叶子：做过的 / 小芽正在做的 / 等他的 / 没做成的。 */
export interface StageLeaf { label: string; count?: number; tone: 'done' | 'working' | 'you' | 'failed' }

/** 链路上某一环往下分的那一小枝：这一环里做过的几类事，最后一片是现在的状态（正在做的那类事 / 等他做哪一下）。 */
export function stageLeaves(stage: ApplyStage, position: StagePosition, run: ProgressRun | undefined, caption: string | null): StageLeaf[] {
  const index = at(stage);
  const recorded = (run?.trail ?? []).filter(t => t.stage === stage && LEAF_NAMES[t.kind])
    .map((t): StageLeaf => ({ label: LEAF_NAMES[t.kind], tone: 'done', ...(t.count > 1 ? { count: t.count } : {}) }));
  const leaves: StageLeaf[] = recorded.length ? recorded : [{ label: DEFAULT_LEAF[stage], tone: 'done' }];
  const here = index === position.current;
  if (here && position.tone === 'working') leaves[leaves.length - 1] = { ...leaves[leaves.length - 1], tone: 'working' };
  if (here && (position.tone === 'you' || position.tone === 'failed') && caption) leaves.push({ label: caption, tone: position.tone });
  if (stage === 'send' && position.current >= APPLY_STAGES.length) leaves.push({ label: '投出了', tone: 'done' });
  return leaves;
}

/** 默认打开哪一环的枝：正在办 / 等他的那一环；还没轮到小芽动手时是他选中的那一环；全部走完是最后一环。 */
export function openStageIndex(position: StagePosition): number {
  if (position.tone === 'idle' && position.current < APPLY_STAGES.length) return Math.max(0, position.current - 1);
  return Math.min(position.current, APPLY_STAGES.length - 1);
}

export function stageCaption(status: LiveStatus, waiting: string | null): string | null {
  if (status === 'waiting') return WAITING_CAPTION[waiting ?? ''] ?? '等你处理';
  if (status === 'ready') return '等你投出';
  if (status === 'failed') return '没填成';
  if (status === 'sending') return '提交中';
  return null;
}

/** 给读屏和悬停提示的一句话（画面上用图形，不把这句拼进标题）。 */
export const LIVE_STATUS_TEXT: Record<LiveStatus, string> = {
  queued: '排队中', filling: '正在办', waiting: '等你处理', ready: '填好了，等你投出', sending: '正在提交', done: '已投出', failed: '没填成',
};
