import { describe, expect, it } from 'vitest';

import { progressMessage } from './TaskProgressPanel';
import type { BatchState } from './types';

describe('progressMessage', () => {
  const PREP = '第一次要准备浏览器，约 1–2 分钟，之后不用等';
  it('浏览器第一次在准备：说要等多久，盖过上一份的旧进展；接管的话仍最先', () => {
    // 服务端发来的状态（前端类型还没收 browser_down 时也照样认）
    const batch: Pick<BatchState, 'phase' | 'message'> = JSON.parse(JSON.stringify({ phase: 'browser_down', message: PREP }));
    expect(progressMessage(undefined, '打开网申页', batch)).toBe(PREP);
    expect(progressMessage('请拖动滑块', '打开网申页', batch)).toBe('请拖动滑块');
  });
  it('平常：这份最新进展优先于批量状态', () => {
    expect(progressMessage(undefined, '打开网申页', { phase: 'driving', message: '正在填写 2 份' })).toBe('打开网申页');
    expect(progressMessage(undefined, undefined, null)).toBe('等待任务开始');
  });
});
