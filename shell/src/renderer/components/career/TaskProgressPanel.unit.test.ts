import { describe, expect, it } from 'vitest';

import { livePageOfRun } from './TaskProgressPanel';

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
