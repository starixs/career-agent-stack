import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { retireLegacyMemoryJobs } from '../../shared/careerMemoryPolicy';
import { removePristineLegacyMemoryRules } from './legacy-memory-cleanup';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const template = (name: string) => readFileSync(join(__dirname, '..', '..', 'shared', name));

describe('退役基座工作区记忆', () => {
  it('配置：心跳 / 记忆巩固 / 记忆演化一律关掉，保留其余设置；已关的不算改动', () => {
    const agents = [{ heartbeat: { enabled: true, intervalMinutes: 240 }, memoryAutoUpdate: { enabled: true, intervalHours: 24 }, memoryEvolution: { enabled: true } }];
    expect(retireLegacyMemoryJobs(agents)).toBe(true);
    expect(agents[0]).toEqual({ heartbeat: { enabled: false, intervalMinutes: 240 }, memoryAutoUpdate: { enabled: false, intervalHours: 24 }, memoryEvolution: { enabled: false } });
    expect(retireLegacyMemoryJobs(agents)).toBe(false);
    expect(retireLegacyMemoryJobs(undefined)).toBe(false);
  });

  it('规则文件：和默认模板一模一样的删掉，用户改过的保留', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'career-legacy-rules-')); dirs.push(ws);
    const rules = join(ws, '.claude', 'rules'); mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, '02-SOUL.md'), template('default-soul.md'));
    writeFileSync(join(rules, '03-USER.md'), Buffer.concat([template('default-user.md'), Buffer.from('\n- 用户自己加的一行\n')]));
    writeFileSync(join(rules, '04-MEMORY.md'), template('default-memory.md'));
    expect((await removePristineLegacyMemoryRules(ws)).sort()).toEqual(['02-SOUL.md', '04-MEMORY.md']);
    expect(existsSync(join(rules, '02-SOUL.md'))).toBe(false);
    expect(existsSync(join(rules, '03-USER.md'))).toBe(true);
    expect(await removePristineLegacyMemoryRules(ws)).toEqual([]);
  });
});
