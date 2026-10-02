/**
 * Resolve app-owned custom-protocol subresource URLs for the current WebView.
 *
 * Tauri 2 serves custom protocols as `http://<scheme>.localhost/...` on
 * Windows, while macOS/Linux continue to use the scheme form. The Rust
 * `attachment_protocol` handler accepts both; renderer code must emit the form
 * the platform WebView can actually load as an <img>/<audio> subresource.
 */

const KEYSTONE_RESOURCE_WINDOWS_ORIGIN = 'http://keystone-resource.localhost';
const KEYSTONE_RESOURCE_SCHEME_PREFIX = 'keystone-resource://';
const LEGACY_KEYSTONE_WINDOWS_ORIGIN = 'http://keystone.localhost';
const LEGACY_KEYSTONE_SCHEME_PREFIX = 'keystone://';

export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
}

export function resolvekeystoneResourceUrl(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (isWindowsPlatform()) {
    return `${KEYSTONE_RESOURCE_WINDOWS_ORIGIN}${path}`;
  }
  return `${KEYSTONE_RESOURCE_SCHEME_PREFIX}${path.slice(1)}`;
}

/**
 * Rewrite only the two historical WebView resource authorities. This is not
 * an AppRoute parser and must never be used at an OS deep-link boundary.
 */
export function canonicalizeLegacykeystoneResourceUrl(value: string): string {
  for (const prefix of [LEGACY_KEYSTONE_SCHEME_PREFIX, KEYSTONE_RESOURCE_SCHEME_PREFIX]) {
    for (const authority of ['attachment/', 'tool-attachment/']) {
      const marker = `${prefix}${authority}`;
      if (value.startsWith(marker)) {
        return resolvekeystoneResourceUrl(`/${value.slice(prefix.length)}`);
      }
    }
  }
  for (const origin of [LEGACY_KEYSTONE_WINDOWS_ORIGIN, KEYSTONE_RESOURCE_WINDOWS_ORIGIN]) {
    for (const authority of ['/attachment/', '/tool-attachment/']) {
      const marker = `${origin}${authority}`;
      if (value.startsWith(marker)) {
        return resolvekeystoneResourceUrl(value.slice(origin.length));
      }
    }
  }
  return value;
}
