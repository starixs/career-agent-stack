/**
 * 聊天附件读取：用户在对话里发 PDF / Word / PPT / 表格 / 图片时，每轮发送前在本地转成文字交给模型。
 *
 * 为什么要做：附件进工作区后只是一个 `@keystone_files/x.pdf` 引用，SDK 会把它当 PDF 文档块 / 图片块塞给模型；
 * 内置 DeepSeek 两种块都不收，docx / xlsx 这类二进制 Read 也读不出来，模型只能回答"读不了"。
 * 产品又禁了 Bash，模型自己调不了基座的 `keystone anydoc`，所以这一步必须由我们替它做完。
 *
 * 分层兜底（前一层失败才走下一层，每层失败原因都记下来）：
 *   1. 基座 AnyDoc（Rust 文档 Worker：版式、表格、扫描页 OCR 最好；原生资源没装时立即失败）
 *   2. 内置解析：pdf.js 文本层、docx / pptx / epub 解 XML、SheetJS 读表格、macOS textutil 读 doc / rtf / odt
 *   3. 系统 OCR：扫描版 PDF 或图片在 macOS 上用 Vision 识别（中英文）
 *   4. 都不行：把试过什么、为什么失败如实告诉模型，让它准确地跟用户说明，而不是假装读到了
 *
 * 转好的文字缓存在 `<工作区>/keystone_files/.converted/`（按路径 + 大小 + 修改时间命名），同一文件不重复转换。
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';

import { managementApi } from '../utils/management-api-client';

/** 需要转换的格式；纯文本 / 代码 / html 等 Read 本来就能读，不在此列。 */
const PDF_EXT = new Set(['.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
const WORD_EXT = new Set(['.docx', '.docm', '.dotx']);
const SLIDE_EXT = new Set(['.pptx', '.pptm', '.ppsx']);
const SHEET_EXT = new Set(['.xlsx', '.xlsm', '.xls', '.ods', '.numbers']);
const TEXTUTIL_EXT = new Set(['.doc', '.rtf', '.rtfd', '.odt', '.wordml', '.webarchive']);
const OTHER_EXT = new Set(['.ppt', '.epub', '.odp', '.pages', '.key']);
/** AnyDoc 支持的输入（见 specs/tech_docs/document_processing.md）。 */
const ANYDOC_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.odt', '.odp', '.ods', '.rtf', '.epub']);

export function needsConversion(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return [PDF_EXT, IMAGE_EXT, WORD_EXT, SLIDE_EXT, SHEET_EXT, TEXTUTIL_EXT, OTHER_EXT].some(set => set.has(ext));
}

/** 单文件注入上限；超出部分让模型按需 Read 缓存文件。 */
const INLINE_CHARS_PER_FILE = 20_000;
const INLINE_CHARS_TOTAL = 40_000;
const ANYDOC_DEADLINE_MS = 120_000;
const OCR_MAX_PAGES = 30;
/** 每页平均少于这么多可见字符，就当作扫描件去 OCR。 */
const SCANNED_CHARS_PER_PAGE = 40;

export interface AttachmentText {
  /** 工作区相对路径（展示给模型的）。 */
  path: string;
  name: string;
  ok: boolean;
  text: string;
  /** 用了哪一层，例如「AnyDoc」「PDF 文本层」「系统 OCR」。 */
  method?: string;
  pages?: number;
  /** 缓存文件的工作区相对路径，长文档让模型按需 Read。 */
  convertedPath?: string;
  /** 每一层失败的原因，失败时给模型看。 */
  attempts: string[];
}

// ── 找出本轮消息里引用的附件 ─────────────────────────────────────────────

/**
 * 从用户消息里找 `@路径` 引用（输入框插入的就是这种），只留工作区内存在且需要转换的文件。
 * 文件名带空格时输入框不会加引号，所以未加引号的引用解析不到文件时，再按扩展名向后贪心匹配一次。
 */
export function findAttachmentRefs(prompt: string, cwd: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): boolean => {
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (!needsConversion(abs)) return false;
    try {
      if (!statSync(abs).isFile()) return false;
    } catch {
      return false;
    }
    if (!seen.has(abs)) { seen.add(abs); found.push(abs); }
    return true;
  };
  const re = /(?:^|\s)@(?:"([^"]+)"|(\S+))/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
    if (m[1]) { add(m[1]); continue; }
    if (add(m[2])) continue;
    // 带空格的文件名：从这一行最长的前缀往回缩，第一个存在的文件就是它。
    const line = prompt.slice(m.index + m[0].indexOf('@') + 1).split('\n')[0];
    if (add(line.trimEnd())) continue;
    for (let end = line.lastIndexOf(' '); end > m[2].length; end = line.lastIndexOf(' ', end - 1)) {
      if (add(line.slice(0, end))) break;
    }
  }
  return found;
}

// ── 第 1 层：基座 AnyDoc ───────────────────────────────────────────────

type DocumentJob = {
  jobId: string;
  state: string;
  output?: { documentPath?: string; artifactAvailable?: boolean };
  error?: { code?: string; message?: string };
  metrics?: { pagesTotal?: number };
};

const TERMINAL = new Set(['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'interrupted']);

function anydocFailure(resp: Record<string, unknown>): string {
  const err = resp.error;
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string };
    return `${e.code ?? ''} ${e.message ?? ''}`.trim();
  }
  return `${String(resp.code ?? '')} ${String(err ?? '未知错误')}`.trim();
}

async function viaAnydoc(abs: string, outputRoot: string, cwd: string): Promise<{ text: string; pages?: number }> {
  mkdirSync(outputRoot, { recursive: true });
  const submitted = await managementApi('/api/document/convert', 'POST', { sourcePath: abs, outputRoot, currentWorkspace: cwd });
  if (!submitted.ok) throw new Error(anydocFailure(submitted));
  let job = submitted.job as DocumentJob;
  const deadline = Date.now() + ANYDOC_DEADLINE_MS;
  while (!TERMINAL.has(job.state)) {
    if (Date.now() > deadline) {
      await managementApi('/api/document/cancel', 'POST', { jobId: job.jobId }).catch(() => undefined);
      throw new Error(`超过 ${ANYDOC_DEADLINE_MS / 1000} 秒未完成，已取消`);
    }
    await new Promise(r => setTimeout(r, 500));
    const status = await managementApi(`/api/document/status?jobId=${encodeURIComponent(job.jobId)}`);
    if (!status.ok) throw new Error(anydocFailure(status));
    job = status.job as DocumentJob;
  }
  if (!job.state.startsWith('succeeded') || !job.output?.documentPath) {
    throw new Error(`${job.state}${job.error ? `：${job.error.code ?? ''} ${job.error.message ?? ''}` : ''}`);
  }
  return { text: readFileSync(job.output.documentPath, 'utf8'), pages: job.metrics?.pagesTotal };
}

// ── 第 2 层：内置解析 ────────────────────────────────────────────────

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** WordprocessingML：段落成行，表格行用 ` | ` 连接单元格。 */
export function docxXmlToText(xml: string): string {
  // 制表符 / 换行是独立元素，不在 <w:t> 里，先改写成文字节点才不会丢。
  const body = xml.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:(br|cr)(?:\s[^>]*)?\/>/g, '<w:t>\n</w:t>');
  const paragraphText = (p: string) => decodeXml((p.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? []).map(t => t.replace(/<[^>]+>/g, '')).join(''));
  const lines: string[] = [];
  const blockRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g;
  for (const block of body.match(blockRe) ?? []) {
    if (block.startsWith('<w:tbl>')) {
      for (const row of block.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []) {
        const cells = (row.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) ?? [])
          .map(c => (c.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []).map(paragraphText).join(' ').trim());
        lines.push(`| ${cells.join(' | ')} |`);
      }
    } else {
      lines.push(paragraphText(block));
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** DrawingML（pptx 幻灯片）：每个 `<a:p>` 一行。 */
export function drawingXmlToText(xml: string): string {
  return (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\s[\s\S]*?<\/a:p>/g) ?? [])
    .map(p => decodeXml((p.match(/<a:t>[^<]*<\/a:t>/g) ?? []).map(t => t.slice(5, -6)).join('')))
    .filter(line => line.trim())
    .join('\n');
}

export function htmlToText(html: string): string {
  return decodeXml(html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function zipOf(abs: string) {
  const { default: AdmZip } = await import('adm-zip');
  return new AdmZip(abs);
}

async function viaDocx(abs: string): Promise<string> {
  const zip = await zipOf(abs);
  const doc = zip.getEntry('word/document.xml');
  if (!doc) throw new Error('不是有效的 Word 文件（缺 word/document.xml）');
  return docxXmlToText(doc.getData().toString('utf8'));
}

async function viaPptx(abs: string): Promise<{ text: string; pages: number }> {
  const zip = await zipOf(abs);
  const slides = zip.getEntries()
    .map(e => ({ e, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(e.entryName)?.[1]) }))
    .filter(s => s.n)
    .sort((a, b) => a.n - b.n);
  if (!slides.length) throw new Error('没有找到幻灯片');
  const text = slides.map(({ e, n }) => {
    const notes = zip.getEntry(`ppt/notesSlides/notesSlide${n}.xml`);
    const noteText = notes ? drawingXmlToText(notes.getData().toString('utf8')) : '';
    return `## 第 ${n} 页\n${drawingXmlToText(e.getData().toString('utf8'))}${noteText ? `\n\n备注：${noteText}` : ''}`;
  }).join('\n\n');
  return { text, pages: slides.length };
}

async function viaEpub(abs: string): Promise<string> {
  const zip = await zipOf(abs);
  return zip.getEntries()
    .filter(e => /\.x?html?$/i.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }))
    .map(e => htmlToText(e.getData().toString('utf8')))
    .filter(Boolean)
    .join('\n\n');
}

const SHEET_MAX_ROWS = 2000;

async function viaSheet(abs: string): Promise<{ text: string; pages: number }> {
  const XLSX = await import('xlsx');
  const book = XLSX.read(readFileSync(abs), { type: 'buffer', cellDates: true });
  const parts = book.SheetNames.map(name => {
    const csv = XLSX.utils.sheet_to_csv(book.Sheets[name], { blankrows: false });
    const rows = csv.split('\n');
    const clipped = rows.length > SHEET_MAX_ROWS ? `${rows.slice(0, SHEET_MAX_ROWS).join('\n')}\n…（还有 ${rows.length - SHEET_MAX_ROWS} 行未列出）` : csv;
    return `## 工作表：${name}\n${clipped}`;
  });
  return { text: parts.join('\n\n'), pages: book.SheetNames.length };
}

/** pdf.js 文本层，按 hasEOL 还原换行，保留页边界。 */
async function viaPdfText(abs: string): Promise<{ text: string; pages: number; pageTexts: string[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(abs)), useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 } as Parameters<typeof pdfjs.getDocument>[0]).promise;
  const pageTexts: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pageTexts.push(content.items.map(it => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('').replace(/[ \t]+\n/g, '\n').trim());
    }
  } finally {
    await doc.destroy();
  }
  const text = pageTexts.map((t, i) => `## 第 ${i + 1} 页\n${t}`).join('\n\n');
  return { text, pages: pageTexts.length, pageTexts };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else ok(stdout);
    });
  });
}

async function viaTextutil(abs: string): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('仅 macOS 自带 textutil');
  return run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', abs], 60_000);
}

// ── 第 3 层：系统 OCR（macOS Vision） ──────────────────────────────────

/** JXA：PDF 逐页渲染 / 图片直接读，Vision 识别中英文。输出 JSON `{pages: string[], total}`。 */
const VISION_OCR_JXA = `
ObjC.import('Foundation'); ObjC.import('Vision'); ObjC.import('PDFKit'); ObjC.import('AppKit');
function ocr(nsimg) {
  const rep = $.NSBitmapImageRep.imageRepWithData(nsimg.TIFFRepresentation);
  if (!rep || rep.isNil()) return '';
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;
  req.usesLanguageCorrection = true;
  req.recognitionLanguages = $(['zh-Hans', 'zh-Hant', 'en-US']);
  const handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(rep.CGImage, $.NSDictionary.dictionary);
  if (!handler.performRequestsError($([req]), Ref())) return '';
  const out = []; const rs = req.results;
  for (let i = 0; i < rs.count; i++) { const c = rs.objectAtIndex(i).topCandidates(1); if (c.count) out.push(c.objectAtIndex(0).string.js); }
  return out.join('\\n');
}
function run(argv) {
  const path = argv[0]; const maxPages = Number(argv[1]);
  const url = $.NSURL.fileURLWithPath(path);
  if (/\\.pdf$/i.test(path)) {
    const doc = $.PDFDocument.alloc.initWithURL(url);
    if (!doc || doc.isNil()) return JSON.stringify({ error: 'open_failed' });
    const n = Math.min(doc.pageCount, maxPages); const pages = [];
    for (let i = 0; i < n; i++) {
      const b = doc.pageAtIndex(i).boundsForBox(0);
      const scale = 2200 / Math.max(b.size.width, b.size.height, 1);
      pages.push(ocr(doc.pageAtIndex(i).thumbnailOfSizeForBox($.NSMakeSize(b.size.width * scale, b.size.height * scale), 0)));
    }
    return JSON.stringify({ pages: pages, total: Number(doc.pageCount) });
  }
  const img = $.NSImage.alloc.initWithContentsOfURL(url);
  if (!img || img.isNil()) return JSON.stringify({ error: 'open_failed' });
  return JSON.stringify({ pages: [ocr(img)], total: 1 });
}`;

async function viaSystemOcr(abs: string): Promise<{ text: string; pages: number }> {
  if (process.platform !== 'darwin') throw new Error('当前系统没有内置 OCR（仅 macOS 可用）');
  const out = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', VISION_OCR_JXA, abs, String(OCR_MAX_PAGES)], 180_000);
  const parsed = JSON.parse(out) as { pages?: string[]; total?: number; error?: string };
  if (!parsed.pages) throw new Error(parsed.error ?? '识别失败');
  const total = parsed.total ?? parsed.pages.length;
  const body = parsed.pages.length === 1 && total === 1
    ? parsed.pages[0]
    : parsed.pages.map((t, i) => `## 第 ${i + 1} 页\n${t}`).join('\n\n');
  const clipped = total > parsed.pages.length ? `\n\n…（共 ${total} 页，只识别了前 ${parsed.pages.length} 页）` : '';
  return { text: body + clipped, pages: total };
}

// ── 编排 ─────────────────────────────────────────────────────────────

function visibleChars(text: string): number {
  return text.replace(/^## 第 \d+ 页$/gm, '').replace(/\s+/g, '').length;
}

/** 这一层读到了一点文字但不够可信：继续试下一层，全都失败时再拿它兜底。 */
class WeakTextError extends Error {
  constructor(message: string, readonly partial: { text: string; pages?: number }) { super(message); }
}

interface Layer {
  name: string;
  run: () => Promise<{ text: string; pages?: number }>;
}

/** 按格式排出要尝试的层；AnyDoc 永远在最前，因为它是基座能力里质量最好的。 */
function layersFor(abs: string, deps: ConvertDeps): Layer[] {
  const ext = extname(abs).toLowerCase();
  const layers: Layer[] = [];
  if (deps.anydoc && ANYDOC_EXT.has(ext)) layers.push({ name: 'AnyDoc', run: () => deps.anydoc!(abs) });
  if (PDF_EXT.has(ext)) {
    layers.push({
      name: 'PDF 文本层',
      run: async () => {
        const r = await viaPdfText(abs);
        if (visibleChars(r.text) < SCANNED_CHARS_PER_PAGE * r.pages) throw new WeakTextError('几乎没有文字层，像是扫描件或图片 PDF', r);
        return r;
      },
    });
    layers.push({ name: '系统 OCR', run: () => deps.ocr(abs) });
  } else if (IMAGE_EXT.has(ext)) {
    layers.push({ name: '系统 OCR', run: () => deps.ocr(abs) });
  } else if (WORD_EXT.has(ext)) {
    layers.push({ name: 'Word 解析', run: async () => ({ text: await viaDocx(abs) }) });
    layers.push({ name: 'textutil', run: async () => ({ text: await viaTextutil(abs) }) });
  } else if (SLIDE_EXT.has(ext)) {
    layers.push({ name: 'PPT 解析', run: () => viaPptx(abs) });
  } else if (SHEET_EXT.has(ext)) {
    layers.push({ name: '表格解析', run: () => viaSheet(abs) });
  } else if (TEXTUTIL_EXT.has(ext)) {
    layers.push({ name: 'textutil', run: async () => ({ text: await viaTextutil(abs) }) });
  } else if (ext === '.epub') {
    layers.push({ name: 'EPUB 解析', run: async () => ({ text: await viaEpub(abs) }) });
  }
  return layers;
}

export interface ConvertDeps {
  /** 基座 AnyDoc；不传则跳过（单测）。 */
  anydoc?: (abs: string) => Promise<{ text: string; pages?: number }>;
  ocr: (abs: string) => Promise<{ text: string; pages?: number }>;
  log?: (msg: string) => void;
}

const inflight = new Map<string, Promise<AttachmentText>>();

function cacheFile(abs: string, cacheDir: string): string {
  const st = statSync(abs);
  const key = createHash('sha1').update(`${abs}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 10);
  return join(cacheDir, `${basename(abs)}.${key}.md`);
}

/** 把一个附件转成文字（带缓存、并发去重）。不抛错：失败信息放进 attempts。 */
export function convertAttachment(abs: string, cwd: string, deps: ConvertDeps): Promise<AttachmentText> {
  const cacheDir = join(cwd, 'keystone_files', '.converted');
  const rel = (p: string) => relative(cwd, p).split('\\').join('/') || p;
  const base: AttachmentText = { path: rel(abs), name: basename(abs), ok: false, text: '', attempts: [] };
  let cachePath: string;
  try {
    cachePath = cacheFile(abs, cacheDir);
  } catch (error) {
    return Promise.resolve({ ...base, attempts: [`读取文件失败：${error instanceof Error ? error.message : String(error)}`] });
  }
  const pending = inflight.get(cachePath);
  if (pending) return pending;

  const task = (async (): Promise<AttachmentText> => {
    if (existsSync(cachePath)) {
      const cached = readFileSync(cachePath, 'utf8');
      const meta = /^<!-- method=(.*?) pages=(\d*) -->\n/.exec(cached);
      return { ...base, ok: true, text: meta ? cached.slice(meta[0].length) : cached, method: meta?.[1], pages: meta?.[2] ? Number(meta[2]) : undefined, convertedPath: rel(cachePath) };
    }
    const attempts: string[] = [];
    let weak: { text: string; pages?: number; method: string } | null = null;
    const done = (r: { text: string; pages?: number }, method: string): AttachmentText => {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, `<!-- method=${method} pages=${r.pages ?? ''} -->\n${r.text}`);
      return { ...base, ok: true, text: r.text, method, pages: r.pages, convertedPath: rel(cachePath), attempts };
    };
    for (const layer of layersFor(abs, deps)) {
      const started = Date.now();
      try {
        const r = await layer.run();
        if (visibleChars(r.text) === 0) throw new Error('没有识别出任何文字');
        deps.log?.(`${base.name}：${layer.name} 成功（${visibleChars(r.text)} 字，${Date.now() - started}ms）`);
        return done(r, layer.name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof WeakTextError && !weak && visibleChars(error.partial.text) > 0) weak = { ...error.partial, method: layer.name };
        attempts.push(`${layer.name}：${reason}`);
        deps.log?.(`${base.name}：${layer.name} 失败（${reason.slice(0, 160)}）`);
      }
    }
    if (weak) {
      deps.log?.(`${base.name}：其它方式都失败，退回 ${weak.method} 读到的少量文字`);
      return done(weak, `${weak.method}（文字很少，可能不完整）`);
    }
    if (!attempts.length) attempts.push(`暂不支持 ${extname(abs) || '无扩展名'} 格式`);
    return { ...base, attempts };
  })().finally(() => inflight.delete(cachePath));
  inflight.set(cachePath, task);
  return task;
}

/** 拼给模型看的上下文；没有需要转换的附件时返回 null。 */
export function renderAttachmentContext(files: AttachmentText[]): string | null {
  if (!files.length) return null;
  let budget = INLINE_CHARS_TOTAL;
  const blocks = files.map(f => {
    if (!f.ok) {
      return [
        `<attached-file name="${f.name}" path="${f.path}" status="unreadable">`,
        `这份文件没能转出文字。依次尝试过：\n${f.attempts.map(a => `- ${a}`).join('\n')}`,
        '请如实告诉用户没读到内容和原因（用大白话，不要提内部工具名），再给一个最省事的办法：换成可复制文字的 PDF / Word，或者直接截图发过来。',
        '</attached-file>',
      ].join('\n');
    }
    const limit = Math.min(INLINE_CHARS_PER_FILE, Math.max(budget, 2_000));
    const clipped = f.text.length > limit;
    const shown = clipped ? f.text.slice(0, limit) : f.text;
    budget -= shown.length;
    const attrs = [`name="${f.name}"`, `path="${f.path}"`, f.convertedPath ? `text_path="${f.convertedPath}"` : '', f.pages ? `pages="${f.pages}"` : '', `via="${f.method ?? ''}"`].filter(Boolean).join(' ');
    return [
      `<attached-file ${attrs}>`,
      shown,
      clipped ? `\n…（后面还有约 ${f.text.length - limit} 字没放进来；需要时用 Read 读 ${f.convertedPath}，用 offset/limit 分段）` : '',
      '</attached-file>',
    ].join('\n');
  });
  return [
    '用户这条消息带了文件，系统已在本地把它们转成文字，内容就在下面。直接根据内容回答；'
    + '如果自动读取的结果显示为空、乱码或"无法读取"，以这里为准，不要说读不了，也不要让用户自己复制粘贴。',
    ...blocks,
  ].join('\n\n');
}

/** UserPromptSubmit 用：找附件 → 逐个转换 → 拼上下文。 */
export async function buildAttachmentContext(prompt: string, cwd: string, deps: ConvertDeps): Promise<string | null> {
  const refs = findAttachmentRefs(prompt, cwd);
  if (!refs.length) return null;
  const files = await Promise.all(refs.map(abs => convertAttachment(abs, cwd, deps)));
  return renderAttachmentContext(files);
}

/** 生产环境依赖：基座 AnyDoc + macOS Vision OCR。 */
export function defaultConvertDeps(cwd: string): ConvertDeps {
  return {
    anydoc: abs => viaAnydoc(abs, join(cwd, 'keystone_files', '.converted', 'anydoc'), cwd),
    ocr: viaSystemOcr,
    log: msg => console.log(`[career-attach] ${msg}`),
  };
}
