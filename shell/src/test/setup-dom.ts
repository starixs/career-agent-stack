// Setup for the `dom` vitest project (jsdom + @testing-library/react).
// - Extends expect() with jest-dom matchers (toBeInTheDocument, toBeDisabled, …).
// - Unmounts rendered trees after each test so DOM/listeners don't leak across
//   tests sharing the same jsdom document.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { i18n } from '@/i18n';

// jsdom lacks ResizeObserver, which several components (CollapsibleContent,
// MessageList, editors) construct in effects. Provide a no-op stub so rendering
// them under jsdom doesn't throw. Tests that assert on observed sizes mock it
// per-test; this default just keeps construction from crashing.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void { /* no-op */ }
    unobserve(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  } as unknown as typeof ResizeObserver;
}

// Node 26 ships its own experimental Web Storage globals. Without
// `--localstorage-file` the `localStorage` getter returns undefined, and it
// shadows jsdom's implementation — every `localStorage.clear()` in a test then
// throws. Install an in-memory Storage only when the global is missing.
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string): void { this.items.delete(key); }
  setItem(key: string, value: string): void { this.items.set(key, String(value)); }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (globalThis[name] === undefined) {
    Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true, writable: true });
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
});
