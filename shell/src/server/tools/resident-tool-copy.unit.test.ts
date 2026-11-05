import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { XIAOYA_TOOLS } from './career-tool-router';

// 小芽每轮都背着常驻工具的描述，描述里的词会被原样说给用户（10-17 实例：「材料包已冻结」「动作一旦失败就锁死」）。
// 这些词只许出现在参数说明或不常驻的工具里。
const DEVELOPER_WORDS = /队列|冻结|pending|JSON|快照|批量运行器|动作队列|状态码/;

function residentDescriptions(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const file of readdirSync(__dirname)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const source = readFileSync(join(__dirname, file), 'utf8');
    for (const m of source.matchAll(/tool\(\s*'([a-z0-9_]+)',\s*'((?:[^'\\]|\\.)*)'/g)) {
      if (XIAOYA_TOOLS.has(m[1])) out.push([m[1], m[2]]);
    }
  }
  return out;
}

describe('resident career tool copy', () => {
  it('finds the resident tools in source', () => {
    expect(residentDescriptions().length).toBeGreaterThan(10);
  });

  it('keeps developer words out of descriptions the model reads every turn', () => {
    const offenders = residentDescriptions()
      .filter(([, description]) => DEVELOPER_WORDS.test(description))
      .map(([name, description]) => `${name}: ${description.match(DEVELOPER_WORDS)?.[0]}`);
    expect(offenders).toEqual([]);
  });
});
