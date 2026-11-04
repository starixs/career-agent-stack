import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { objcHelperCompileArgs, prepareObjcHelper } from './prepare-objc-helper.mjs';

const quiet = () => {};

function fakeToolchain(calls) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'xcrun') writeFileSync(args[args.indexOf('-o') + 1], 'bin');
    if (cmd === 'lipo') return 'x86_64 arm64\n';
    return '';
  };
}

test('编译参数：双架构 + 每个 framework', () => {
  const args = objcHelperCompileArgs('a.m', 'out', ['Foundation', 'IOBluetooth']);
  assert.deepEqual(args.slice(-7), ['-framework', 'Foundation', '-framework', 'IOBluetooth', '-o', 'out', 'a.m']);
  assert.ok(args.includes('arm64') && args.includes('x86_64'));
});

test('源码没变就不重编；变了才编', () => {
  const dir = mkdtempSync(join(tmpdir(), 'objc-helper-'));
  try {
    const source = join(dir, 'h.m');
    writeFileSync(source, 'int main(){return 0;}');
    const spec = { name: 'h', source, outDir: join(dir, 'out'), frameworks: ['Foundation'] };
    const calls = [];
    const run = fakeToolchain(calls);
    assert.equal(prepareObjcHelper(spec, { platform: 'darwin', run, log: quiet }), join(dir, 'out', 'h'));
    assert.equal(calls.filter(c => c[0] === 'xcrun').length, 1);
    prepareObjcHelper(spec, { platform: 'darwin', run, log: quiet });
    assert.equal(calls.filter(c => c[0] === 'xcrun').length, 1);
    writeFileSync(source, 'int main(){return 1;}');
    prepareObjcHelper(spec, { platform: 'darwin', run, log: quiet });
    assert.equal(calls.filter(c => c[0] === 'xcrun').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非 macOS 跳过', () => {
  assert.equal(prepareObjcHelper({ name: 'h', source: '/nope', outDir: '/nope', frameworks: [] }, { platform: 'win32', log: quiet }), null);
});

test('架构不对就失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'objc-helper-'));
  try {
    const source = join(dir, 'h.m');
    writeFileSync(source, 'x');
    const run = (cmd, args) => { if (cmd === 'xcrun') writeFileSync(args[args.indexOf('-o') + 1], 'bin'); return cmd === 'lipo' ? 'arm64' : ''; };
    assert.throws(() => prepareObjcHelper({ name: 'h', source, outDir: join(dir, 'out'), frameworks: [] }, { platform: 'darwin', run, log: quiet }), /架构不对/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
