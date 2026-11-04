import { describe, expect, it } from 'vitest';

import { ancestorClaudeMdExcludes } from './claude-md-scope';

describe('ancestorClaudeMdExcludes', () => {
  it('产品工作区（~/.keystone 下）：排除上级目录的说明文件，包括 ~/.claude/CLAUDE.md；工作区自己的不排除（2026-11-04）', () => {
    const ex = ancestorClaudeMdExcludes('/Users/u/.keystone/projects/career', '/Users/u');
    expect(ex).toContain('/Users/u/.claude/CLAUDE.md');
    expect(ex).toContain('/Users/u/CLAUDE.md');
    expect(ex).toContain('/Users/u/.keystone/projects/CLAUDE.md');
    expect(ex).not.toContain('/Users/u/.keystone/projects/career/CLAUDE.md');
    expect(ex).not.toContain('/Users/u/.keystone/projects/career/.claude/CLAUDE.md');
  });

  it('用户自己的项目目录：不排除任何上级说明（monorepo 的 CLAUDE.md 是正常用法）', () => {
    expect(ancestorClaudeMdExcludes('/Users/u/code/app', '/Users/u')).toEqual([]);
    expect(ancestorClaudeMdExcludes('', '/Users/u')).toEqual([]);
  });
});
