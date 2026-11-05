/** 浏览器操作的拟人节奏：同站基础随机间隔 + 重复动作降速 + 连续操作后的短停顿。 */
export const ACTION_BURST_LIMIT = 12;

export function actionDelayMs(opts: { baseMs: number; repeated: boolean; burstCount: number; rand?: () => number }): number {
  const rand = opts.rand ?? Math.random;
  const repeatFactor = opts.repeated ? 1.5 : 1;
  const idle = opts.burstCount > 0 && opts.burstCount % ACTION_BURST_LIMIT === 0 ? 3000 + rand() * 3000 : 0;
  return Math.round(opts.baseMs * repeatFactor + idle);
}
