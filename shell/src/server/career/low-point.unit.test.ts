import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOW_POINT_KV, lowPointLine, lowPointOpener } from './low-point';
import { createMemoryRepos } from './test-db';

const NOW = '2026-10-23T04:00:00.000Z';
const DAY = 86_400_000;

function withRejections(n: number, daysAgo = 2) {
  const repos = createMemoryRepos();
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(Date.parse(NOW) - 30 * DAY);
    const app = repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: `r${i}`, title: '后端开发', company_name: `公司${i}` }).id);
    repos.jumpTo(app.id, 'applied', '已投递');
    vi.setSystemTime(Date.parse(NOW) - daysAgo * DAY);
    repos.jumpTo(app.id, 'rejected', '收到拒信');
  }
  vi.setSystemTime(Date.parse(NOW));
  return repos;
}

describe('低谷开场', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('7 天内 5 封拒信：说一句带基数的话；还没进过面试就说数据不够', () => {
    expect(lowPointLine(withRejections(5), NOW)).toBe('这 7 天收到 5 封拒信。累计投出 5 份，还没进过面试，现在的数据还不够下结论。');
  });

  it('不到 5 封、或拒信在 7 天之前：不开口', () => {
    expect(lowPointLine(withRejections(4), NOW)).toBeNull();
    expect(lowPointLine(withRejections(5, 8), NOW)).toBeNull();
  });

  it('说过一次就记下，7 天内不再说', () => {
    const repos = withRejections(6);
    expect(lowPointOpener(repos, NOW)).toContain('不提换方向');
    expect(repos.kvGet(LOW_POINT_KV)).toBe(NOW);
    expect(lowPointOpener(repos, NOW)).toBeNull();
  });
});
