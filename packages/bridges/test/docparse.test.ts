import { describe, it, expect } from 'vitest'
import { writeFile, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { docparseArgs, parseDocument, extractPdfLinks, extractWithRegex, type ExecFn } from '../src/index.js'

describe('docparse 参数构造', () => {
  it('默认 md+json、--ocr-lang zh、--output 目录、静默与不中断', () => {
    const args = docparseArgs('/in/简历.pdf', '/out')
    expect(args).toEqual(['convert', '/in/简历.pdf', '--to', 'md', '--to', 'json', '--output', '/out', '--ocr-lang', 'zh', '--no-abort-on-error', '-q'])
  })
  it('pipeline / ocrEngine / pageRange / --no-ocr / extraArgs', () => {
    expect(docparseArgs('a.docx', '/o', { to: ['md'], pipeline: 'vlm', ocrEngine: 'rapidocr', ocrLang: 'ch', pageRange: [1, 3], extraArgs: ['--verbose'] }))
      .toEqual(['convert', 'a.docx', '--to', 'md', '--output', '/o', '--ocr-lang', 'ch', '--ocr-engine', 'rapidocr', '--pipeline', 'vlm', '--page-range', '1', '3', '--no-abort-on-error', '-q', '--verbose'])
    const noOcr = docparseArgs('a.pdf', '/o', { ocr: false })
    expect(noOcr).toContain('--no-ocr'); expect(noOcr).not.toContain('--ocr-lang')
  })
})

describe('parseDocument（子进程 mock）', () => {
  it('调用 DOCPARSE_BIN，输出到临时目录再读回 markdown 与 json', async () => {
    const seen: { bin: string; args: string[] }[] = []
    const exec: ExecFn = async (bin, args) => {
      seen.push({ bin, args })
      const out = args[args.indexOf('--output') + 1]
      await writeFile(join(out, '简历.md'), '# 张三\n\n后端工程师', 'utf8')
      await writeFile(join(out, '简历.json'), JSON.stringify({ schema_name: 'DoclingDocument', texts: [{ text: '张三' }] }), 'utf8')
      return { stdout: '', stderr: '', code: 0 }
    }
    const r = await parseDocument('/tmp/简历.pdf', { bin: '/opt/docparse', exec })
    expect(seen[0].bin).toBe('/opt/docparse')
    expect(seen[0].args.slice(0, 2)).toEqual(['convert', '/tmp/简历.pdf'])
    expect(r.markdown).toContain('# 张三')
    expect((r.json as { schema_name: string }).schema_name).toBe('DoclingDocument')
    await expect(readdir(r.outputDir)).rejects.toThrow() // 临时目录已清理
  })
  it('退出码非 0 抛错并带 stderr；没有产物也抛错', async () => {
    const fail: ExecFn = async () => ({ stdout: '', stderr: 'ModuleNotFoundError: rapidocr', code: 1 })
    await expect(parseDocument('/tmp/x.pdf', { exec: fail })).rejects.toThrow('rapidocr')
    const empty: ExecFn = async () => ({ stdout: '', stderr: '', code: 0 })
    await expect(parseDocument('/tmp/x.pdf', { exec: empty })).rejects.toThrow('没有产出')
  })
})

describe('extractPdfLinks', () => {
  async function makePdf(useObjectStreams: boolean): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 300])
    page.drawText('GitHub', { x: 50, y: 200, size: 14 })
    // PDF 规范要求 URI 为 7-bit ASCII（非 ASCII 需百分号编码）；也有生成器写成 UTF-16 十六进制串
    const mk = (uri: string, rect: number[], hex = false) => doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0],
      A: doc.context.obj({ Type: 'Action', S: 'URI', URI: hex ? PDFHexString.fromText(uri) : PDFString.of(uri) }),
    }))
    page.node.set(PDFName.of('Annots'), doc.context.obj([mk('https://github.com/zhangsan', [50, 195, 120, 215]), mk('https://github.com/zhangsan', [50, 195, 120, 215]), mk('mailto:zs@example.com', [50, 150, 200, 170])]))
    const page2 = doc.addPage([400, 300])
    page2.node.set(PDFName.of('Annots'), doc.context.obj([mk(encodeURI('https://zhangsan.dev/项目'), [10, 10, 100, 30]), mk('https://hex.example/路径', [10, 40, 100, 60], true)]))
    return doc.save({ useObjectStreams })
  }

  it('用 pdf-lib 读链接注解（含对象流压缩的 PDF），同页同 URL 去重，带页码与矩形', async () => {
    for (const objStreams of [false, true]) {
      const bytes = await makePdf(objStreams)
      const links = await extractPdfLinks(bytes)
      expect(links.map(l => [l.page, l.url])).toEqual([[1, 'https://github.com/zhangsan'], [1, 'mailto:zs@example.com'], [2, 'https://zhangsan.dev/%E9%A1%B9%E7%9B%AE'], [2, 'https://hex.example/路径']])
      expect(links[0].rect).toEqual([50, 195, 120, 215])
    }
  })
  it('接受文件路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-'))
    const p = join(dir, 'r.pdf')
    await writeFile(p, await makePdf(true))
    expect((await extractPdfLinks(p)).length).toBe(4)
  })
  it('正则兜底：手写最小 PDF 里的 /URI (...) 与转义', () => {
    const minimal = `%PDF-1.4\n1 0 obj << /Type /Annot /Subtype /Link /A << /S /URI /URI (https://example.com/a\\)b) >> >> endobj\n2 0 obj << /A << /S /URI /URI <68747470733a2f2f782e636e> >> >> endobj\ntrailer << >>\n%%EOF`
    const links = extractWithRegex(new TextEncoder().encode(minimal))
    expect(links.map(l => l.url)).toEqual(['https://example.com/a)b', 'https://x.cn'])
  })
  it('损坏的 PDF 走正则兜底而不是抛错', async () => {
    const broken = new TextEncoder().encode('not a pdf but has /URI (https://fallback.example) inside')
    expect((await extractPdfLinks(broken)).map(l => l.url)).toEqual(['https://fallback.example'])
  })
})
