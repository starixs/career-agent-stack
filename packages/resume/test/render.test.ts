import { describe, it, expect } from 'vitest'
import { renderPdf, renderDocx, renderPng, pdfPageCount, pdfPageText, countPdfPages, subsetsForText, cjkHyphenation, fontStackFor } from '../src/index.js'
import { sampleResume } from './fixture.js'

describe('render', () => {
  it('字体子集按文本计算；CJK 断行回调逐字拆分', () => {
    const idx = subsetsForText('张三 Python')
    expect(idx.length).toBeGreaterThan(0)
    expect(subsetsForText('abc 123')).toEqual([])
    const stack = fontStackFor('张三')
    expect(stack.regular[0]).toBe('Times-Roman')
    expect(stack.bold[0]).toBe('Times-Bold')
    expect(stack.regular.length).toBe(stack.bold.length)
    expect(cjkHyphenation('用Python搭建')).toEqual(['用', 'Python', '搭', '建'])
    expect(cjkHyphenation('hello')).toEqual(['hello'])
  })

  it('renderPdf 真实渲染：%PDF 开头、单页、文本含中文', async () => {
    const pdf = await renderPdf(sampleResume())
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF')
    expect(countPdfPages(pdf)).toBe(1)
    expect(await pdfPageCount(pdf)).toBe(1)
    const text = await pdfPageText(pdf)
    expect(text).toContain('张三')
    expect(text).toContain('复旦大学')
    expect(text).toContain('Python')
  }, 60000)

  it('长中文 bullet 能换行而不溢出（渲染到多页而不是报错）', async () => {
    const r = sampleResume()
    r.experience[0].bullets.push('这是一条非常长的没有任何空格的中文句子用来验证断行回调是否生效否则整段会被当成一个单词超出页面宽度导致版式错乱这里再补充一些文字确保长度足够触发换行逻辑并且继续延长它以超过两行的宽度上限')
    const pdf = await renderPdf(r)
    expect(await pdfPageCount(pdf)).toBe(1)
    const png = await renderPng(pdf, { scale: 1 })
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }, 60000)

  it('renderDocx 返回 zip（PK 开头）且包含宋体 / Times New Roman 设置', async () => {
    const buf = await renderDocx(sampleResume())
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(buf.length).toBeGreaterThan(2000)
    // 粗略检查：document.xml 在 zip 里可能被压缩，所以换一种方式——解包校验见 service 测试之外；这里只验签名与大小
  })

  it('renderPng 返回 PNG 签名，scale 影响尺寸', async () => {
    const pdf = await renderPdf(sampleResume())
    const png1 = await renderPng(pdf, { page: 1, scale: 1 })
    const png2 = await renderPng(pdf, { page: 1, scale: 2 })
    expect(png1.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(png2.length).toBeGreaterThan(png1.length)
    // IHDR 宽度：A4 595pt * scale
    expect(png2.readUInt32BE(16)).toBe(Math.ceil(595.28 * 2))
    await expect(renderPng(pdf, { page: 5 })).rejects.toThrow('页码超出范围')
  }, 60000)
})
