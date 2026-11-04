import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compile the production pure predicates. No Bluetooth calls, user devices,
// permissions, SMS, or developer-directory prebuilt binaries are used.
test('native MAP discovery and RFCOMM readiness regressions', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-phone-protocol-'));
  const source = fileURLToPath(new URL('../src/server/career/phone/native/career-phone-helper.m', import.meta.url));
  try {
    const fixture = join(dir, 'test.m');
    writeFileSync(fixture, `
#define main helper_main_not_invoked
#include ${JSON.stringify(source)}
#undef main
#include <assert.h>
int main(int argc, const char *argv[]) { @autoreleasepool {
  if (argc > 1) {
    gCloseLink = ^{ fputs("closed\\n", stdout); fflush(stdout); };
    exitOnStdinClose(); spin(3, nil); return 1;
  }
  assert(RFCOMM_OPEN_TIMEOUT_SECONDS <= 10);
  assert(MAP_AUTH_TIMEOUT_SECONDS >= 60);
  // macOS can return an already-open channel without an open-complete callback.
  assert(rfcommReady(YES, YES, NO, NO));
  assert(rfcommReady(YES, NO, YES, NO));
  assert(!rfcommReady(YES, NO, NO, NO));
  assert(!rfcommReady(YES, YES, YES, YES));
  assert(!rfcommReady(NO, YES, YES, NO));
  // Failed or incomplete discovery cannot use stale MAS records.
  assert([discoveryFailure(0, YES, kIOReturnError, YES, 8) isEqual:@"unreachable"]);
  assert([discoveryFailure(0, NO, 0, YES, 8) isEqual:@"unreachable"]);
  assert([discoveryFailure(kIOReturnError, YES, 0, YES, 8) isEqual:@"unreachable"]);
  assert([discoveryFailure(0, YES, 0, YES, 0) isEqual:@"unsupported"]);
  assert([discoveryFailure(0, YES, 0, NO, 0) isEqual:@"unreachable"]);
  assert(discoveryFailure(0, YES, 0, YES, 8) == nil);
  return 0;
} }
`);
    const bin = join(dir, 'test');
    execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'IOBluetooth', fixture, '-o', bin], { stdio: 'pipe', timeout: 60000 });
    execFileSync(bin, { stdio: 'pipe', timeout: 5000 });
    const output = execFileSync(bin, ['--shutdown'], { input: '', encoding: 'utf8', timeout: 5000 });
    if (output !== 'closed\n') throw new Error('stdin EOF did not close the owned MAP link');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
