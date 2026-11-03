/**
 * 直取网页（浏览的第一层）：不开浏览器，HTTP 拿文字。拿得到就不必动托管 Chrome（快、不占投递引擎、不触发窗口）；
 * 拿不到要说清为什么、该不该升级到浏览器——单页应用只有空壳、被反爬拦、要登录，这些浏览器层能处理或交给用户。
 *
 * 判定用和浏览器观察同一套提示（browse.detectHints），两层对「要登录 / 有验证码」的说法一致。
 */
import { htmlToText, pdfBytesToText } from './attachment-reader';
import { detectHints, type Hint } from './browse';

const FETCH_TIMEOUT_MS = 10_000;
/** 一次给模型的正文上限，和浏览器 browser_read 的一页同量级。 */
export const FETCH_TEXT_LIMIT = 12_000;
/**
 * 正文少于这么多字、页面又带脚本挂载点，就当单页应用空壳（实测字节、腾讯、美团校招页直取都只剩导航）。
 * 详情页一般上千字，导航 + 页脚通常不到几百字。
 */
const THIN_TEXT_CHARS = 400;
const SPA_SHELL_RX = /<div[^>]+id=["'](app|root|__next|__nuxt|main-app)["'][^>]*>\s*<\/div>|window\.__INITIAL_STATE__|<noscript>[^<]*(enable|启用|开启)\s*javascript/i;
/** 直取 PDF 的大小上限：招聘简章、宣讲会日程一般几 MB，再大多半是扫描件，文字层也读不出来。 */
const PDF_MAX_BYTES = 20 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export type FetchVerdict = 'ok' | 'needs_browser' | 'login' | 'blocked' | 'not_html' | 'error';
export interface FetchedPage {
  verdict: FetchVerdict;
  url: string; final_url: string; status: number | null;
  title: string; text: string; text_total: number;
  hints: Hint[];
  /** 给模型的一句话：拿到了什么，或为什么拿不到、下一步怎么办。 */
  note: string;
}

const NEXT_STEP: Record<Exclude<FetchVerdict, 'ok'>, string> = {
  needs_browser: '直取只拿到页面空壳（内容要等脚本加载）：用 browser_open 打开它。',
  login: '这页要登录才看得到：用 browser_open 打开；登录请用户帮一下（browser_wait_user），登录完接着办。',
  blocked: '被网站的反爬 / 验证拦下了：用 browser_open 打开，浏览器里能自己过的简单验证码会自己过。',
  not_html: '这不是网页（可能是 PDF / 图片 / 下载文件）：用 browser_open 打开看看，或请用户把文件发进对话。',
  error: '网络层取不到：再试一次，或用 browser_open 打开。',
};

function verdictOf(status: number, html: string, text: string, hints: Hint[]): FetchVerdict {
  if (hints.includes('captcha') || hints.includes('risk') || status === 403 || status === 412 || status === 429) return 'blocked';
  if (hints.includes('login') && text.length < THIN_TEXT_CHARS * 3) return 'login';
  if (status === 401) return 'login';
  if (status >= 400) return 'error';
  if (text.length < THIN_TEXT_CHARS && (SPA_SHELL_RX.test(html) || /<script[^>]+src=/i.test(html))) return 'needs_browser';
  return 'ok';
}

function titleAndText(html: string): { title: string; text: string } {
  const meta = (name: string) => html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1]?.trim();
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? meta('og:title') ?? '';
  const parts = [meta('description'), meta('og:description'), htmlToText(html)].filter((p): p is string => !!p);
  return { title, text: [...new Set(parts)].join('\n').trim() };
}

async function readPdf(res: Response, page: Omit<FetchedPage, 'verdict' | 'note'>): Promise<FetchedPage> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > PDF_MAX_BYTES) return { ...page, verdict: 'not_html', note: `PDF 太大（${Math.round(bytes.byteLength / 1048576)} MB），请用户下载后发进对话。` };
  let parsed: { text: string; pages: number };
  try {
    parsed = await pdfBytesToText(bytes);
  } catch (error) {
    console.warn(`[career] web_fetch pdf-parse failed url=${page.final_url.slice(0, 120)}: ${String(error).slice(0, 120)}`);
    return { ...page, verdict: 'not_html', note: 'PDF 解析不了（可能损坏或加密）：请用户下载后发进对话。' };
  }
  const { text, pages } = parsed;
  if (!text.replace(/## 第 \d+ 页/g, '').trim()) return { ...page, verdict: 'not_html', note: 'PDF 没有文字层（多半是扫描件）：请用户把文件发进对话，按图片识别。' };
  return { ...page, verdict: 'ok', title: `PDF · ${pages} 页`, text: text.slice(0, FETCH_TEXT_LIMIT), text_total: text.length, note: `已取到 PDF 文字（${pages} 页）。` };
}

/** 直取一个网址。不抛错：网络失败也回 verdict='error'，由模型决定重试或开浏览器。 */
export async function fetchPage(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedPage> {
  const base = { url, final_url: url, status: null as number | null, title: '', text: '', text_total: 0, hints: [] as Hint[] };
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*', 'accept-language': 'zh-CN,zh;q=0.9' } });
  } catch (error) {
    return { ...base, verdict: 'error', note: `${NEXT_STEP.error}（${String(error).slice(0, 120)}）` };
  }
  const page = { ...base, status: res.status, final_url: res.url || url };
  const type = res.headers.get('content-type') ?? '';
  if (/pdf/i.test(type) && res.status < 400) return readPdf(res, page);
  if (type && !/html|text|xml/i.test(type)) return { ...page, verdict: 'not_html', note: `${NEXT_STEP.not_html}（${type.split(';')[0]}）` };
  const html = await res.text();
  const { title, text } = titleAndText(html);
  const hints = detectHints({ hasPassword: /<input[^>]+type=["']?password/i.test(html), bodySample: text.slice(0, 3000), url: page.final_url }, []);
  const verdict = verdictOf(res.status, html, text, hints);
  const out = { ...page, title, text: text.slice(0, FETCH_TEXT_LIMIT), text_total: text.length, hints, verdict };
  if (verdict !== 'ok') return { ...out, note: NEXT_STEP[verdict] };
  return { ...out, note: text.length > FETCH_TEXT_LIMIT ? `已取到正文（共 ${text.length} 字，这里给前 ${FETCH_TEXT_LIMIT} 字；要后面的用 browser_open + browser_read）。` : '已取到正文。' };
}
