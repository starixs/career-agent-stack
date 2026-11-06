import { beforeEach, describe, expect, it } from 'vitest';

import { applyProgressOf, noteApplyProgress, resetApplyProgress } from './apply-progress';
import { createMemoryRepos } from './test-db';

describe('每份网申的进度按申请存下来（2026-11-06「树没有跟着标签走…要有对应和持久化」）', () => {
  beforeEach(() => { resetApplyProgress(); });

  it('各记各的：两份网申走到不同的环、枝上是各自做过的事', () => {
    const repos = createMemoryRepos();
    noteApplyProgress(repos, 'app_a', { stage: 'open', kind: 'navigate' });
    noteApplyProgress(repos, 'app_a', { stage: 'open', kind: 'entry' });
    noteApplyProgress(repos, 'app_b', { stage: 'tailor', kind: 'resume' });
    for (let i = 0; i < 3; i++) noteApplyProgress(repos, 'app_b', { stage: 'fill', kind: 'field' });
    expect(applyProgressOf(repos, 'app_a')).toMatchObject({ stage: 'open', state: 'working', trail: [{ stage: 'open', kind: 'navigate', count: 1 }, { stage: 'open', kind: 'entry', count: 1 }] });
    expect(applyProgressOf(repos, 'app_b')).toMatchObject({ stage: 'fill', trail: [{ stage: 'tailor', kind: 'resume', count: 1 }, { stage: 'fill', kind: 'field', count: 3 }] });
  });

  it('落了盘：内存清掉（重启）之后还读得回来；收尾时连次数和格子数一起存', () => {
    const repos = createMemoryRepos();
    noteApplyProgress(repos, 'app_a', { stage: 'fill', kind: 'page' });
    for (let i = 0; i < 5; i++) noteApplyProgress(repos, 'app_a', { stage: 'fill', kind: 'field' });
    noteApplyProgress(repos, 'app_a', { stage: 'review', state: 'ready', cells: { total: 12, done: 10, you: 2 }, settle: true });
    resetApplyProgress();
    expect(applyProgressOf(repos, 'app_a')).toEqual({
      stage: 'review', state: 'ready', kind: 'field', cells: { total: 12, done: 10, you: 2 },
      trail: [{ stage: 'fill', kind: 'page', count: 1 }, { stage: 'fill', kind: 'field', count: 5 }],
    });
  });

  it('一趟之内只往前走；重头再来的一趟从头记，不留上一趟的枝', () => {
    const repos = createMemoryRepos();
    noteApplyProgress(repos, 'app_a', { stage: 'fill', kind: 'field' });
    expect(noteApplyProgress(repos, 'app_a', { stage: 'open', kind: 'entry' }).stage).toBe('fill');
    noteApplyProgress(repos, 'app_a', { stage: 'picked', restart: true });
    expect(applyProgressOf(repos, 'app_a')).toEqual({ stage: 'picked', state: 'working', trail: [] });
  });

  it('没记过的申请没有进度', () => {
    expect(applyProgressOf(createMemoryRepos(), 'app_none')).toBeUndefined();
  });
});
