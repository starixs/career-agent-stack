import { describe, expect, it } from 'vitest';

import { livePageOfRun, progressMessage } from './TaskProgressPanel';
import type { BatchState } from './types';

const page = (application_id: string, company: string, title: string) => ({ application_id, company, title, current: false, waiting: null });

describe('livePageOfRun', () => {
  const pages = [page('app_a', '美团', '数据分析'), page('app_b', '美团', '产品经理'), page('app_c', '中国中车', '数据分析')];

  it('按网申 id 认页面：同一家公司投几份也不会认错', () => {
    expect(livePageOfRun(pages, { applicationId: 'app_b', company: '美团', jobTitle: '数据分析' })?.application_id).toBe('app_b');
  });

  it('这份没有页面开着就不切（不退回猜同公司的别的岗位）', () => {
    expect(livePageOfRun(pages, { applicationId: 'app_gone', company: '美团', jobTitle: '数据分析' })).toBeUndefined();
  });

  it('旧事件没带 id：岗位名和公司都对上才算', () => {
    expect(livePageOfRun(pages, { company: '中国中车', jobTitle: '数据分析' })?.application_id).toBe('app_c');
    expect(livePageOfRun(pages, { company: '美团' })).toBeUndefined();
  });
});

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
