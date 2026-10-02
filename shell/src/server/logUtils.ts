/**
 * Shared utilities for logging system
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ensureDirSync } from './utils/fs-utils';

export const KEYSTONE_DIR = join(homedir(), '.keystone');
export const LOGS_DIR = join(KEYSTONE_DIR, 'logs');
// Retention policy moved to `./log-retention.ts` (, 2026-05). Keeping a
// re-export of LOGS_DIR + ensureLogsDir as the only API of this module.

/**
 * Ensure logs directory exists
 */
export function ensureLogsDir(): void {
  if (!existsSync(KEYSTONE_DIR)) {
    ensureDirSync(KEYSTONE_DIR);
  }
  if (!existsSync(LOGS_DIR)) {
    ensureDirSync(LOGS_DIR);
  }
}
