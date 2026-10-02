/**
 * 求职数据库单例（Node 侧车进程内唯一连接）。
 *
 * 路径：`$CAREER_DATA_DIR/career.sqlite`，缺省 `~/.keystone/career/career.sqlite`。
 * Global 与 Session 侧车各自持有一个连接（SQLite WAL 允许多进程读写）；
 * 状态流转规则全部在 @career/core 的 Repos 里，这里只负责打开与缓存。
 */
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { Repos } from '@career/core';
import { loadCore } from './core-module';

let repos: Repos | null = null;
let opening: Promise<Repos> | null = null;

export function careerDataDir(): string {
  const env = process.env.CAREER_DATA_DIR?.trim();
  return env ? resolve(env) : join(homedir(), '.keystone', 'career');
}

export function careerDbPath(): string {
  return join(careerDataDir(), 'career.sqlite');
}

/** 导出文件目录（PDF / DOCX / PNG）。 */
export function careerExportsDir(): string {
  return join(careerDataDir(), 'exports');
}

/** 首次调用时惰性加载 @career/core 并打开数据库；并发调用共享同一个 Promise。 */
export async function getRepos(): Promise<Repos> {
  if (repos) return repos;
  if (!opening) {
    opening = loadCore().then(core => {
      const db = core.openDb(careerDbPath());
      repos = new core.Repos(db);
      console.log(`[career] SQLite opened: ${db.path}`);
      return repos;
    }).finally(() => { opening = null; });
  }
  return opening;
}

/** 测试 / 关闭时注入或重置单例。 */
export function setRepos(next: Repos | null): void {
  repos = next;
}

export function closeCareerDb(): void {
  if (!repos) return;
  try {
    repos.db.close();
  } catch (error) {
    console.warn('[career] close db failed:', error);
  }
  repos = null;
}
