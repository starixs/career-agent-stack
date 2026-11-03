import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findPrebuiltWindowHelper, WINDOW_HELPER_NAME } from './window-helper-binary';

let root: string | null = null;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

const touch = (path: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, ''); chmodSync(path, 0o755); };

describe('findPrebuiltWindowHelper', () => {
  it('发布包：server-dist.js 旁的 window-helper/', () => {
    root = mkdtempSync(join(tmpdir(), 'wh-'));
    touch(join(root, 'Resources', 'window-helper', WINDOW_HELPER_NAME));
    expect(findPrebuiltWindowHelper(join(root, 'Resources'))).toBe(join(root, 'Resources', 'window-helper', WINDOW_HELPER_NAME));
  });

  it('开发：向上找 src-tauri/resources/window-helper/', () => {
    root = mkdtempSync(join(tmpdir(), 'wh-'));
    touch(join(root, 'src-tauri', 'resources', 'window-helper', WINDOW_HELPER_NAME));
    expect(findPrebuiltWindowHelper(join(root, 'src', 'server'))).toBe(join(root, 'src-tauri', 'resources', 'window-helper', WINDOW_HELPER_NAME));
  });

  it('都没有：返回 null（调用方再决定要不要现场编译）', () => {
    root = mkdtempSync(join(tmpdir(), 'wh-'));
    expect(findPrebuiltWindowHelper(join(root, 'a', 'b'))).toBeNull();
  });
});
