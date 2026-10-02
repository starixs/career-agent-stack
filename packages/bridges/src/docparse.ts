/**
 * docparse 桥接：把 PDF/DOCX/PPTX/图片 转成 Markdown + JSON（docling 分支的 CLI）。
 *
 * CLI（docparse/cli/main.py，`docparse <source>` 等价于 `docparse convert <source>`）关键参数：
 *   --to md|json|yaml|html|html_split_page|text|doctags|vtt|doclang|dclx|chunks|latex   （可重复）
 *   --from pdf|docx|...   --pipeline legacy|standard|native|vlm|asr   --ocr/--no-ocr   --ocr-engine auto|rapidocr|tesseract|...
 *   --ocr-lang <逗号分隔；原生标签如 ch，或 iso:zh-Hans>   --ocr-mode <区域>   --page-range a b
 *   --output <目录>（默认 .）   --output-file <单文件路径>   -q/--quiet   --abort-on-error
 *   输出命名：<输出目录>/<源文件 stem>.md / .json / ...
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import { envStr } from './common.js'

export type DocparseFormat = 'md' | 'json' | 'yaml' | 'html' | 'html_split_page' | 'text' | 'doctags' | 'chunks' | 'latex'
export type DocparsePipeline = 'legacy' | 'standard' | 'native' | 'vlm' | 'asr'

export interface ExecResult { stdout: string; stderr: string; code: number }
export type ExecFn = (bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>

export interface ParseDocumentOptions {
  to?: DocparseFormat[]
  /** OCR 语言：原样传给 --ocr-lang（rapidocr 用 'ch'，或 'iso:zh-Hans'；默认 'zh'）。 */
  ocrLang?: string
  ocr?: boolean
  ocrEngine?: string
  pipeline?: DocparsePipeline
  pageRange?: [number, number]
  extraArgs?: string[]
  /** docparse 可执行文件；默认环境变量 DOCPARSE_BIN（默认 'docparse'）。 */
  bin?: string
  timeoutMs?: number
  /** 子进程实现，测试用 mock。 */
  exec?: ExecFn
  /** 保留临时目录（排障）。 */
  keepOutput?: boolean
}

export interface ParsedDocument {
  markdown?: string
  json?: unknown
  /** 其他格式按扩展名放这里（html/text/...）。 */
  extra: Record<string, string>
  outputDir: string
  stdout: string
  stderr: string
}

const FORMAT_EXT: Record<DocparseFormat, string> = {
  md: 'md', json: 'json', yaml: 'yaml', html: 'html', html_split_page: 'html', text: 'txt', doctags: 'doctags', chunks: 'chunks.jsonl', latex: 'tex',
}

export const defaultExec: ExecFn = (bin, args, opts) => new Promise((resolve) => {
  execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code?: unknown }).code) : err ? 1 : 0
    const extra = err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? `\n找不到可执行文件 ${bin}（请安装 docparse 或设置 DOCPARSE_BIN）` : ''
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + extra + (err && !stderr ? `\n${err.message}` : ''), code })
  })
})

/** 纯函数：构造 docparse 命令行参数（便于测试）。 */
export function docparseArgs(inputPath: string, outputDir: string, opts: ParseDocumentOptions = {}): string[] {
  const to = opts.to && opts.to.length ? opts.to : ['md', 'json']
  const args: string[] = ['convert', inputPath]
  for (const f of to) args.push('--to', f)
  args.push('--output', outputDir)
  if (opts.ocr === false) args.push('--no-ocr')
  else {
    const lang = opts.ocrLang ?? 'zh'
    if (lang) args.push('--ocr-lang', lang)
  }
  if (opts.ocrEngine) args.push('--ocr-engine', opts.ocrEngine)
  if (opts.pipeline) args.push('--pipeline', opts.pipeline)
  if (opts.pageRange) args.push('--page-range', String(opts.pageRange[0]), String(opts.pageRange[1]))
  args.push('--no-abort-on-error', '-q')
  if (opts.extraArgs) args.push(...opts.extraArgs)
  return args
}

/** 调 docparse 把文档转成 Markdown / JSON，输出到临时目录后读回。 */
export async function parseDocument(inputPath: string, opts: ParseDocumentOptions = {}): Promise<ParsedDocument> {
  const bin = opts.bin ?? envStr('DOCPARSE_BIN', 'docparse')
  const exec = opts.exec ?? defaultExec
  const outputDir = await mkdtemp(join(tmpdir(), 'docparse-'))
  const to = opts.to && opts.to.length ? opts.to : (['md', 'json'] as DocparseFormat[])
  try {
    const args = docparseArgs(inputPath, outputDir, { ...opts, to })
    const res = await exec(bin, args, { timeoutMs: opts.timeoutMs ?? 10 * 60_000 })
    if (res.code !== 0) throw new Error(`docparse 退出码 ${res.code}：${res.stderr.trim() || res.stdout.trim()}`)
    const stem = basename(inputPath, extname(inputPath))
    const files = await readdir(outputDir).catch(() => [] as string[])
    const out: ParsedDocument = { extra: {}, outputDir, stdout: res.stdout, stderr: res.stderr }
    for (const f of to) {
      const ext = FORMAT_EXT[f]
      // 优先 <stem>.<ext>；docparse 对 URL/特殊名可能改名，退化为同扩展名的唯一文件
      let name = files.find(n => n === `${stem}.${ext}`) ?? files.find(n => n.endsWith(`.${ext}`))
      if (!name) continue
      const text = await readFile(join(outputDir, name), 'utf8')
      if (f === 'md') out.markdown = text
      else if (f === 'json') { try { out.json = JSON.parse(text) } catch { out.extra.json = text } }
      else out.extra[f] = text
      name = undefined
    }
    if (to.includes('md') && out.markdown === undefined && to.includes('json') && out.json === undefined) {
      throw new Error(`docparse 没有产出任何文件（输出目录 ${outputDir}）：${res.stderr.trim() || res.stdout.trim()}`)
    }
    return out
  } finally {
    if (!opts.keepOutput) await rm(outputDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── PDF 超链接兜底 ──────────────────────────────────────────────────────

export interface PdfLink { url: string; page: number; rect?: [number, number, number, number] }

/** 读取 PDF 的链接注解（Link 注解 → URI 动作）。不依赖 docparse；解析失败时退化为正则扫描。 */
export async function extractPdfLinks(input: string | Uint8Array): Promise<PdfLink[]> {
  const bytes = typeof input === 'string' ? new Uint8Array(await readFile(input)) : input
  let links: PdfLink[] = []
  try {
    links = await extractWithPdfLib(bytes)
  } catch {
    links = []
  }
  if (links.length === 0) links = extractWithRegex(bytes)
  // 去重（同 URL 同页只留一个），保持出现顺序
  const seen = new Set<string>()
  return links.filter(l => { const k = `${l.page}|${l.url}`; if (seen.has(k)) return false; seen.add(k); return true })
}

async function extractWithPdfLib(bytes: Uint8Array): Promise<PdfLink[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
  const out: PdfLink[] = []
  const ctx = doc.context
  const str = (v: unknown): string | undefined => {
    if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText()
    return undefined
  }
  doc.getPages().forEach((page, idx) => {
    const annots = page.node.Annots()
    if (!annots) return
    for (let i = 0; i < annots.size(); i++) {
      const dict = ctx.lookup(annots.get(i))
      if (!(dict instanceof PDFDict)) continue
      const subtype = dict.get(PDFName.of('Subtype'))
      if (subtype !== PDFName.of('Link')) continue
      const action = ctx.lookup(dict.get(PDFName.of('A')))
      let url: string | undefined
      if (action instanceof PDFDict) {
        const s = action.get(PDFName.of('S'))
        if (s === PDFName.of('URI')) url = str(ctx.lookup(action.get(PDFName.of('URI'))))
      }
      if (!url) continue
      let rect: PdfLink['rect']
      const r = ctx.lookup(dict.get(PDFName.of('Rect')))
      if (r instanceof PDFArray && r.size() === 4) {
        const nums = r.asArray().map(x => ctx.lookup(x)).map(x => (x instanceof PDFNumber ? x.asNumber() : NaN))
        if (nums.every(Number.isFinite)) rect = nums as [number, number, number, number]
      }
      out.push({ url, page: idx + 1, rect })
    }
  })
  return out
}

/** 正则兜底：只覆盖未压缩对象里的 `/URI (...)` 与 `/URI <hex>`；页码无法可靠判定，记 0。 */
export function extractWithRegex(bytes: Uint8Array): PdfLink[] {
  const text = Buffer.from(bytes).toString('latin1')
  const out: PdfLink[] = []
  const re = /\/URI\s*(?:\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) out.push({ url: unescapePdfString(m[1]), page: 0 })
    else if (m[2]) out.push({ url: Buffer.from(m[2].replace(/\s+/g, ''), 'hex').toString('utf8'), page: 0 })
  }
  return out
}

function unescapePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, g: string) => {
    switch (g) {
      case 'n': return '\n'; case 'r': return '\r'; case 't': return '\t'; case 'b': return '\b'; case 'f': return '\f'
      case '(': return '('; case ')': return ')'; case '\\': return '\\'
      default: return String.fromCharCode(parseInt(g, 8))
    }
  })
}

/** 判断 docparse 是否可用（跑 `--version`）。 */
export async function docparseAvailable(opts: { bin?: string; exec?: ExecFn } = {}): Promise<boolean> {
  const res = await (opts.exec ?? defaultExec)(opts.bin ?? envStr('DOCPARSE_BIN', 'docparse'), ['--version'], { timeoutMs: 20_000 })
  return res.code === 0
}

export async function fileExists(p: string): Promise<boolean> { try { await stat(p); return true } catch { return false } }
