/**
 * HTML 简历 → PDF：无头 Chrome 打印。与预览同一份 HTML（@career/resume-studio/html），
 * 导出时在 Chrome 里重跑一次「排满一页」，保证 PDF 本身就是一页（预览与导出引擎可能有细微断行差异）。
 *
 * 浏览器：独立的无头实例（不碰托管浏览器的登录身份），本机 Chrome 优先、否则 App 自带 Chromium；
 * 按需启动，空闲 BROWSER_IDLE_MS 后关闭。字体请求拦截后由侧车字体缓存应答（离线可用）。
 */
import type { Browser, Page } from 'playwright';
import type { ResumeData } from '@career/resume-studio/schema';

import { readCachedFont } from './font-cache';

/** 空闲多久关浏览器：导出常连着几份（定制后批量导出），一分钟内复用，避免每份都冷启动 1–2 秒。 */
const BROWSER_IDLE_MS = 60_000;
/** 单份导出的上限：正常 < 1 秒；字体首次下载可能要几秒。 */
const EXPORT_TIMEOUT_MS = 30_000;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function launch(): Promise<Browser> {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    console.warn(`[resume-pdf] system-chrome=unavailable error=${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    const { waitForBrowserResource } = await import('../browser-host/resource-client');
    const { executablePath } = await waitForBrowserResource();
    return chromium.launch({ executablePath, headless: true });
  }
}

function acquireBrowser(): Promise<Browser> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!browserPromise) {
    browserPromise = launch().then(browser => {
      browser.once('disconnected', () => { browserPromise = null; });
      return browser;
    });
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

function releaseBrowser(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const pending = browserPromise;
    browserPromise = null;
    void pending?.then(b => b.close()).catch(error => console.warn(`[resume-pdf] browser=close-failed error=${String(error)}`));
  }, BROWSER_IDLE_MS);
  idleTimer.unref?.();
}

/** 字体走侧车缓存；其它外部请求一律拦下（简历 HTML 不应联网）。照片是 data URL，不经过这里。 */
async function routeRequests(page: Page, fontUrls: Set<string>): Promise<void> {
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!fontUrls.has(url)) return route.abort();
    try {
      const { bytes, mime } = await readCachedFont(url);
      await route.fulfill({ status: 200, body: bytes, contentType: mime });
    } catch (error) {
      console.warn(`[resume-pdf] font=unavailable url=${url} error=${error instanceof Error ? error.message : String(error)}`);
      await route.abort();
    }
  });
}

async function fitPage(page: Page, data: ResumeData): Promise<void> {
  if (!data.metadata.page.autoFit) return;
  const html = await import('@career/resume-studio/html');
  const size = html.PAGE_SIZE_MM[data.metadata.page.format === 'letter' ? 'letter' : 'a4'];
  const available = html.paperHeightPx(size.height);
  const scales = await html.fitOnePage(s => page.evaluate<number>(html.MEASURE_SNIPPET(s)), available);
  await page.evaluate(html.MEASURE_SNIPPET(scales));
}

/** 模板没有 HTML 版时返回 null，由调用方走 react-pdf。 */
export async function renderHtmlResumePdf(data: ResumeData): Promise<Buffer | null> {
  const html = await import('@career/resume-studio/html');
  const fonts = html.requiredFonts(data, { raw: true });
  const doc = html.buildResumeHtml(data, { fontCss: html.fontFaceCss(fonts) });
  if (!doc) return null;
  const browser = await acquireBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(EXPORT_TIMEOUT_MS);
  try {
    await routeRequests(page, new Set(fonts.map(f => f.url)));
    await page.setContent(doc, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready.then(() => true)');
    await fitPage(page, data);
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await page.close().catch(error => console.warn(`[resume-pdf] page=close-failed error=${String(error)}`));
    releaseBrowser();
  }
}
