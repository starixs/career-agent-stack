import { describe, expect, it } from 'vitest';

import { expandJobQuery, jobMatchesQuery } from './jobSearch';

describe('job search', () => {
  it('finds software back-end jobs whose titles say 服务端 / Java instead of 后端', () => {
    expect(jobMatchesQuery('DeepSeek', '服务端开发工程师 / 预训练数据工程师 等27个岗位', '后端')).toBe(true);
    expect(jobMatchesQuery('中电福富', 'AI应用开发工程师 / JAVA开发工程师', '后端')).toBe(true);
    expect(jobMatchesQuery('长江存储', '2027届 其他', '后端')).toBe(false);
  });

  it('keeps plain substring search for words outside the synonym table', () => {
    expect(expandJobQuery('  字节 ')).toEqual(['字节']);
    expect(jobMatchesQuery('字节跳动', '2027 校招', '字节')).toBe(true);
    expect(jobMatchesQuery('字节跳动', '2027 校招', '')).toBe(true);
  });

  it('expands compound direction words such as 后端开发 through the 后端 group', () => {
    expect(expandJobQuery('后端开发')).toEqual(expect.arrayContaining(['后端开发', '后端', '服务端', 'java']));
    expect(expandJobQuery('后端开发')[0]).toBe('后端开发');
  });
});
