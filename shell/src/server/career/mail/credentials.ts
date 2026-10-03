/**
 * 邮箱授权码存放：`$CAREER_DATA_DIR/mail-credentials.json`，权限 0600，不进 SQLite、不进日志、不随导出。
 * 只有 Global 侧车读写；Session 侧车的工具通过 Global 路由触发同步 / 发送。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { careerDataDir } from '../db';

type Store = Record<string, { password: string; updated_at: string }>;

let overridePath: string | null = null;
/** 测试注入。 */
export function setMailCredentialsPath(path: string | null): void { overridePath = path; }

function filePath(): string { return overridePath ?? join(careerDataDir(), 'mail-credentials.json'); }

function read(): Store {
  const p = filePath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) as Store; } catch { return {}; }
}
function write(store: Store): void {
  const p = filePath();
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* Windows 无 POSIX 权限 */ }
}

export function getMailPassword(accountId: string): string | null { return read()[accountId]?.password ?? null; }
export function setMailPassword(accountId: string, password: string): void {
  const store = read();
  store[accountId] = { password, updated_at: new Date().toISOString() };
  write(store);
}
export function deleteMailPassword(accountId: string): void {
  const store = read();
  if (accountId in store) { delete store[accountId]; write(store); }
}
