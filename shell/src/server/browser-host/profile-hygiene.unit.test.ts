import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { markProfileExitedCleanly } from './profile-hygiene';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function profileWith(prefs: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'profile-hygiene-')); dirs.push(dir);
  mkdirSync(join(dir, 'Default'));
  writeFileSync(join(dir, 'Default', 'Preferences'), typeof prefs === 'string' ? prefs : JSON.stringify(prefs));
  return dir;
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8')) as { profile: Record<string, unknown>; other?: unknown };

describe('markProfileExitedCleanly', () => {
  it('上次被强杀（exit_type=Crashed）：改回 Normal，保留其他设置', () => {
    const dir = profileWith({ profile: { exit_type: 'Crashed', exited_cleanly: false, name: '求职' }, other: 1 });
    expect(markProfileExitedCleanly(dir)).toBe(true);
    expect(read(dir)).toMatchObject({ profile: { exit_type: 'Normal', exited_cleanly: true, name: '求职' }, other: 1 });
    expect(markProfileExitedCleanly(dir)).toBe(false);
  });

  it('新 profile / 坏文件不报错也不改', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'profile-hygiene-')); dirs.push(fresh);
    expect(markProfileExitedCleanly(fresh)).toBe(false);
    const broken = profileWith('{not json');
    expect(markProfileExitedCleanly(broken)).toBe(false);
    expect(readFileSync(join(broken, 'Default', 'Preferences'), 'utf8')).toBe('{not json');
  });
});
