import { describe, expect, it } from 'vitest';

import { positionTargetFor, titleParts } from './position-target';

describe('position target', () => {
  it('splits campaign-level job titles into position parts', () => {
    expect(titleParts('软件类 / 通信类 / IC类')).toEqual(['软件类', '通信类', 'IC类']);
    expect(titleParts('Java工程师 / 前端工程师 / 测试工程师 等19个岗位')).toEqual(['Java工程师', '前端工程师', '测试工程师']);
    expect(titleParts('2027届 其他')).toEqual([]);
  });

  it('builds terms from the direction first, then the matching title parts, with English city names to prefer', () => {
    const t = positionTargetFor({ keywords: ['后端开发'], cities: ['上海'] }, { title: '软件类 / 通信类 / IC类' })!;
    expect(t.terms.slice(0, 3)).toEqual(['后端开发', '后端', '服务端']);
    expect(t.terms).toContain('软件类');
    expect(t.terms).toContain('software');
    expect(t.search.slice(0, 2)).toEqual(['后端开发', '软件类']);
    expect(t.prefer).toEqual(['上海', 'shanghai']);
  });

  it('returns null when there is nothing to look for', () => {
    expect(positionTargetFor({}, { title: '2027届 其他' })).toBeNull();
  });
});
