#!/usr/bin/env node
/**
 * 截下求职产品每一页（浏览器模式，渲染器 + Global 侧车已在跑）。
 *
 *   node scripts/ui-capture/capture.mjs --out <dir> [--base http://localhost:5175] [--only today,apply]
 *
 * 导航走产品自己的事件（eventBus 的 career:navigate，与左栏点击同一入口），不靠文字点按钮。
 * 每页记下：页面报错、console.error、/api 非 2xx、是否出现「界面渲染出错」。产出 PNG + index.md。
 * 页面主区可滚动且明显超过一屏时，再补一张滚到下一屏的 *-2.png。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const OUT = args.out ?? join(process.cwd(), 'ui-shots');
const BASE = args.base ?? 'http://localhost:5175/';
const ONLY = args.only ? new Set(args.only.split(',')) : null;
/** 首次加载 vite 可能 504（Outdated Optimize Dep），最多重载这么多次。 */
const WARMUP_RELOADS = 6;
const WARMUP_WAIT_MS = 15000;
/** 导航后等页面取数、动画落定的时间。 */
const SETTLE_MS = 3500;
const RENDER_ERROR_TEXT = '界面渲染出错';

/** 左栏与功能市场能打开的每一页（navModel.ts NAV_AREAS + 功能市场里的工具页）。 */
const PAGES = [
  { id: 'chat', name: '对话（落地页 + 右栏）', target: { kind: 'chat' } },
  { id: 'today', name: '工作台 · 招聘概览', target: { kind: 'career-today' } },
  { id: 'apply', name: '我的求职 · 岗位库', target: { kind: 'career-dossier', view: 'apply' } },
  { id: 'line', name: '我的求职 · 投递记录', target: { kind: 'career-dossier', view: 'line' } },
  { id: 'assist', name: '我的求职 · 助力记录', target: { kind: 'career-dossier', view: 'assist' } },
  { id: 'guide', name: '功能市场', target: { kind: 'career-guide' } },
  { id: 'interview', name: '功能市场 · 面试', target: { kind: 'career-dossier', view: 'interview' } },
  { id: 'exam-search', name: '功能市场 · 笔试助力', target: { kind: 'career-dossier', view: 'exam-search' } },
  { id: 'offer', name: '功能市场 · Offer', target: { kind: 'career-dossier', view: 'offer' } },
  { id: 'review', name: '功能市场 · 我的求职月', target: { kind: 'career-review', view: 'funnel' } },
  { id: 'research', name: '功能市场 · 公司调研', target: { kind: 'career-review', view: 'research' } },
  { id: 'vault', name: '我的资料 · 基本资料', target: { kind: 'career-vault' } },
  { id: 'resume', name: '我的资料 · 简历', target: { kind: 'career-material', view: 'resume' } },
  { id: 'live', name: '网申进展', target: { kind: 'career-live' } },
  { id: 'inbox', name: '通知中心', target: { kind: 'career-inbox' } },
  { id: 'takeover', name: '邮箱接管简报', target: { kind: 'career-takeover' } },
  { id: 'settings-general', name: '设置 · 通用设置', target: { kind: 'settings', section: 'general' } },
  { id: 'settings-shortcuts', name: '设置 · 快捷键', target: { kind: 'settings', section: 'shortcuts' } },
  { id: 'settings-feedback', name: '设置 · 小助理与反馈', target: { kind: 'settings', section: 'feedback' } },
  { id: 'settings-about', name: '设置 · 关于', target: { kind: 'settings', section: 'about' } },
];
const DARK_PAGES = ['today', 'line', 'vault'];

async function warmUp(page) {
  for (let i = 0; i < WARMUP_RELOADS; i++) {
    await page.goto(BASE, { waitUntil: 'load', timeout: 120000 }).catch(e => console.warn(`[ui-capture] goto 失败（第 ${i + 1} 次）：${e.message}`));
    await page.waitForTimeout(i === 0 ? WARMUP_WAIT_MS : WARMUP_WAIT_MS / 2);
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (!text.includes(RENDER_ERROR_TEXT) && text.trim().length > 20) return true;
    console.warn(`[ui-capture] 渲染器还没好，重载（${i + 1}/${WARMUP_RELOADS}）`);
  }
  return false;
}

function watch(page) {
  const log = { pageErrors: [], consoleErrors: [], badApi: [] };
  page.on('pageerror', e => log.pageErrors.push(String(e.message ?? e).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('response', r => { const u = r.url(); if (u.includes('/api/') && r.status() >= 400) log.badApi.push(`${r.status()} ${r.request().method()} ${new URL(u).pathname}`); });
  return log;
}

async function navigate(page, target) {
  await page.evaluate(async t => {
    const bus = await import('/api/eventBus.ts');
    bus.emitEvent('career:navigate', t);
  }, target);
  await page.waitForTimeout(SETTLE_MS);
}

/** 主区里最高的那个可滚动容器；超过一屏 1.3 倍时滚一屏再截一张。 */
async function scrollMain(page) {
  return page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('main, section, div')) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!/(auto|scroll)/.test(s.overflowY) || el.clientHeight < 300 || el.clientWidth < 500) continue;
      if (r.width === 0 || r.bottom <= 0 || r.top >= innerHeight || s.visibility === 'hidden' || el.closest('[aria-hidden="true"],[hidden],[inert]')) continue;
      if (el.scrollHeight > el.clientHeight * 1.3 && (!best || el.scrollHeight > best.scrollHeight)) best = el;
    }
    if (!best) return null;
    best.scrollTop = best.clientHeight * 0.9;
    return { scrollHeight: best.scrollHeight, clientHeight: best.clientHeight };
  });
}

async function shoot(page, log, entry, suffix = '') {
  const before = { p: log.pageErrors.length, c: log.consoleErrors.length, a: log.badApi.length };
  await navigate(page, entry.target);
  const file = `${entry.id}${suffix}.png`;
  const first = await page.screenshot({ path: join(OUT, file) });
  const text = await page.evaluate(() => document.body.innerText);
  const files = [file];
  const scrolled = await scrollMain(page);
  if (scrolled) {
    await page.waitForTimeout(800);
    const more = `${entry.id}${suffix}-2.png`;
    const second = await page.screenshot();
    // 滚了但画面没变（滚的是看不见的容器）就不留第二张
    if (!second.equals(first)) { writeFileSync(join(OUT, more), second); files.push(more); }
  }
  return {
    ...entry, files, scrolled,
    renderError: text.includes(RENDER_ERROR_TEXT),
    headline: text.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 60).join(' · ').slice(0, 260),
    pageErrors: log.pageErrors.slice(before.p), consoleErrors: log.consoleErrors.slice(before.c), badApi: [...new Set(log.badApi.slice(before.a))],
  };
}

async function captureAll(browser, scheme, list, suffix) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, locale: 'zh-CN' });
  const page = await context.newPage();
  const log = watch(page);
  const ready = await warmUp(page);
  const results = [];
  for (const entry of list) {
    try {
      results.push(await shoot(page, log, entry, suffix));
      console.log(`[ui-capture] ✓ ${entry.id}${suffix}`);
    } catch (error) {
      results.push({ ...entry, files: [], failed: String(error?.message ?? error) });
      console.error(`[ui-capture] FAILED ${entry.id}${suffix}: ${error?.message ?? error}`);
    }
  }
  const scheme_attr = await page.evaluate(() => document.documentElement.dataset.colorScheme).catch(() => '?');
  await context.close();
  return { ready, results, scheme_attr, bootErrors: log };
}

function row(r, scheme) {
  const notes = [];
  if (r.failed) notes.push(`截图失败：${r.failed}`);
  if (r.renderError) notes.push('**出现「界面渲染出错」**');
  if (r.pageErrors?.length) notes.push(`页面异常 ${r.pageErrors.length}：${r.pageErrors[0]}`);
  if (r.badApi?.length) notes.push(`API 非 2xx：${r.badApi.join('，')}`);
  if (r.consoleErrors?.length) notes.push(`console.error ${r.consoleErrors.length}：${r.consoleErrors[0]}`);
  const files = r.files.map(f => `[${f}](${f})`).join('<br>');
  return `| ${r.name} | ${scheme} | \`${JSON.stringify(r.target)}\` | ${files} | ${(r.headline ?? '').replace(/\|/g, '/')} | ${notes.join('；').replace(/\|/g, '/') || '—'} |`;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const pick = list => list.filter(p => !ONLY || ONLY.has(p.id));
const light = await captureAll(browser, 'light', pick(PAGES), '');
const dark = await captureAll(browser, 'dark', pick(PAGES.filter(p => DARK_PAGES.includes(p.id))), '-dark');
await browser.close();

const md = [
  '# 求职产品 UI 截图', '',
  `生成于 ${new Date().toLocaleString('zh-CN')} · 1440×900 @2x · 浏览器模式（vite 渲染器 + Global 侧车，演示数据见 seed.mjs「林同学」）`, '',
  `浅色启动就绪：${light.ready ? '是' : '否'}；深色启动就绪：${dark.ready ? '是' : '否'}（深色时 html[data-color-scheme]=${dark.scheme_attr}）`, '',
  '已知限制：对话页在浏览器模式下起不了会话侧车（要 Tauri），中间一直停在「小芽在准备」，只有右栏是真实渲染；网申进展页的浏览器面板同理显示「浏览器未打开」。设置页的 403 /api/admin/vision/models 是浏览器模式没有管理口令，异步请求可能记到下一行。', '',
  '「页面开头文字」是截图时 body.innerText 的前几十行（含左栏与右栏），用于不看图也能核对页面状态。', '',
  '| 页面 | 外观 | 导航目标 | 文件 | 页面开头文字 | 报错 / 备注 |', '|---|---|---|---|---|---|',
  ...light.results.map(r => row(r, '浅色')), ...dark.results.map(r => row(r, '深色')), '',
];
writeFileSync(join(OUT, 'index.md'), md.join('\n'));
const bad = [...light.results, ...dark.results].filter(r => r.failed || r.renderError);
console.log(`[ui-capture] done → ${OUT}（${light.results.length + dark.results.length} 页，${bad.length} 页失败或渲染出错）`);
