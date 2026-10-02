import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalizeLegacykeystoneResourceUrl,
  resolvekeystoneResourceUrl,
} from './keystoneProtocol';

const originalPlatform = navigator.platform;
const originalUserAgent = navigator.userAgent;

function setNavigator(platform: string, userAgent: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

afterEach(() => {
  vi.restoreAllMocks();
  void originalPlatform;
  void originalUserAgent;
});

describe('keystone-resource protocol projection', () => {
  it('emits the canonical scheme on macOS and Linux', () => {
    setNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(resolvekeystoneResourceUrl('/attachment/s/file.png')).toBe(
      'keystone-resource://attachment/s/file.png',
    );
  });

  it('emits the WebView2 custom-protocol host on Windows', () => {
    setNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0)');
    expect(resolvekeystoneResourceUrl('/tool-attachment/s/t/file.png')).toBe(
      'http://keystone-resource.localhost/tool-attachment/s/t/file.png',
    );
  });

  it('rewrites only historical resource authorities through the platform projection', () => {
    setNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(canonicalizeLegacykeystoneResourceUrl('keystone://attachment/s/file.png')).toBe(
      'keystone-resource://attachment/s/file.png',
    );
    expect(canonicalizeLegacykeystoneResourceUrl('keystone://tool-attachment/s/t/file.png')).toBe(
      'keystone-resource://tool-attachment/s/t/file.png',
    );
    expect(canonicalizeLegacykeystoneResourceUrl('keystone://open/v1/spaces/a/issues/b')).toBe(
      'keystone://open/v1/spaces/a/issues/b',
    );
  });
});
