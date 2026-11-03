/**
 * 网申网站的「会话 Cookie」跨重启保住（face-ga-port 已定：登录态要保住）。
 *
 * 很多校招站（北森 zhiye 扫码登录等）只给会话 Cookie（没有过期时间），托管浏览器一关就没了，
 * 学生每次重开 App 都得重新扫码（2026-10-31 实例测试 #44）。浏览器宿主的持久化权威是 Chrome 自己的资料夹，
 * 那一层不改；这里只在求职这一层：登上的那一刻记下这个站的会话 Cookie，下次在这个站填表前缺了就补回去。
 *
 * 存在求职数据目录里（和 Chrome 自己的 Cookie 库同一信任级别，文件权限 600），不进模型、不上传。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { BrowserContext } from 'playwright';

import { siteOf } from './app-pages';
import { careerDataDir } from './db';

type SavedCookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];
interface SavedSite { saved_at: string; cookies: SavedCookie[] }
type SavedFile = Record<string, SavedSite>;

/** 记下的会话 Cookie 多久不用就不再补：站点那头的会话多半也过期了，补回去只会误判成已登录。 */
export const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 3600_000;
const FILE_NAME = 'session-cookies.json';

const fileOf = (dir: string) => join(dir, FILE_NAME);
const cookieSiteOf = (domain: string) => siteOf(`https://${domain.replace(/^\./, '')}/`);
const isSession = (c: SavedCookie) => c.expires === undefined || c.expires < 0;

function readSaved(dir: string): SavedFile {
  const file = fileOf(dir);
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SavedFile : {};
  } catch (error) {
    console.warn(`[career] session-cookies: ${file} 读不出来，按没有记过处理`, error instanceof Error ? error.message : error);
    return {};
  }
}

function writeSaved(dir: string, data: SavedFile): void {
  const file = fileOf(dir);
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** 登上的那一刻：记下这个站此刻的会话 Cookie（有过期时间的 Chrome 自己会留，不用记）。返回记了几个。 */
export async function rememberSessionCookies(context: Pick<BrowserContext, 'cookies'>, site: string, dir = careerDataDir(), now = new Date()): Promise<number> {
  const cookies = (await context.cookies()).filter(c => cookieSiteOf(c.domain) === site && isSession(c) && c.value);
  if (!cookies.length) return 0;
  const saved = readSaved(dir);
  saved[site] = { saved_at: now.toISOString(), cookies };
  writeSaved(dir, saved);
  console.log(`[career] session-cookies remembered site=${site} count=${cookies.length}`);
  return cookies.length;
}

/** 在这个站填表前：记过的会话 Cookie 浏览器里没有了（重启过）就补回去。返回补了几个。 */
export async function restoreSessionCookies(context: Pick<BrowserContext, 'cookies' | 'addCookies'>, url: string, dir = careerDataDir(), now = new Date()): Promise<number> {
  const site = siteOf(url);
  if (!site) return 0;
  const entry = readSaved(dir)[site];
  if (!entry || now.getTime() - Date.parse(entry.saved_at) > SESSION_COOKIE_MAX_AGE_MS) return 0;
  const present = new Set((await context.cookies()).filter(c => cookieSiteOf(c.domain) === site).map(c => `${c.domain}|${c.path}|${c.name}`));
  const missing = entry.cookies.filter(c => !present.has(`${c.domain}|${c.path}|${c.name}`));
  if (!missing.length) return 0;
  await context.addCookies(missing);
  console.log(`[career] session-cookies restored site=${site} count=${missing.length}`);
  return missing.length;
}
