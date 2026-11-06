/**
 * 网申现场里「这一家到哪一步了」：顶上的标签和下面的流程用同一个判断，两处不会说两样的话。
 *
 * 2026-11-06 用户看网申现场：顶上下拉框写「公司 · 岗位 · 等你」，底下面板又列一遍全部任务，停下来等他的几家还写着「进行中」。
 * 状态不靠文字拼接，靠这里算出来的一个值，各处用图形和颜色画。
 */
import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

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

/** 一份网申从头到尾的四步。 */
export const LIVE_STAGES = ['打开网页', '填写', '你过目', '投出'] as const;

/** 停下等他时卡在哪一步：登录 / 验证这类是进门前的事，最终提交确认在投出那一步，其余是填写中途。 */
const WAITING_STAGE: Record<string, number> = { login: 0, '2fa': 0, captcha: 0, submit_confirm: 3 };

export interface StagePosition {
  /** 正在哪一步（0–3）；还没开始是 -1，全部做完是 4。 */
  current: number;
  /** 这一步的样子：working 小芽在做 / you 等他 / failed 没做成。 */
  tone: 'working' | 'you' | 'failed' | 'idle';
}

export function stagePosition(status: LiveStatus, waiting: string | null): StagePosition {
  switch (status) {
    case 'queued': return { current: -1, tone: 'idle' };
    case 'waiting': return { current: WAITING_STAGE[waiting ?? ''] ?? 1, tone: 'you' };
    case 'filling': return { current: 1, tone: 'working' };
    case 'failed': return { current: 1, tone: 'failed' };
    case 'ready': return { current: 2, tone: 'you' };
    case 'sending': return { current: 3, tone: 'working' };
    case 'done': return { current: LIVE_STAGES.length, tone: 'idle' };
  }
}

/** 给读屏和悬停提示的一句话（画面上用图形，不把这句拼进标题）。 */
export const LIVE_STATUS_TEXT: Record<LiveStatus, string> = {
  queued: '排队中', filling: '正在填', waiting: '等你处理', ready: '填好了，等你投出', sending: '正在提交', done: '已投出', failed: '没填成',
};
