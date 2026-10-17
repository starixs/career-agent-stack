import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAREER_TOOL_LABELS, getCareerToolLabel } from './careerToolLabels';
import { getToolExpandedLabel, getToolLabel, getToolMainLabel } from './toolBadgeConfig';

const TOOLS_DIR = join(__dirname, '../../../server/tools');

function registeredCareerTools(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.startsWith('career-tools') || file.includes('.test.')) continue;
    const source = readFileSync(join(TOOLS_DIR, file), 'utf8');
    for (const m of source.matchAll(/tool\(\s*'([a-z0-9_]+)'/g)) names.add(m[1]);
  }
  return [...names];
}

describe('career tool labels', () => {
  it('gives every registered career tool a Chinese label', () => {
    const tools = registeredCareerTools();
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.filter(name => !CAREER_TOOL_LABELS[name])).toEqual([]);
  });

  it('never shows the raw mcp__career__ name in the tool row', () => {
    const tool = { id: 't1', name: 'mcp__career__today_queue', input: {}, parsedInput: {} } as never;
    expect(getToolMainLabel(tool)).toBe('看今天的待办');
    expect(getToolLabel(tool)).toBe('看今天的待办');
    expect(getToolExpandedLabel(tool)).toBe('看今天的待办');
  });

  it('falls back to a readable action name and ignores other servers', () => {
    expect(getCareerToolLabel('mcp__career__brand_new_tool')).toBe('brand new tool');
    expect(getCareerToolLabel('mcp__playwright__browser_click')).toBeNull();
  });
});
