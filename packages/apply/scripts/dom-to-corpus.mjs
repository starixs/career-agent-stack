#!/usr/bin/env node
/**
 * 把运行记录里失败字段的 DOM 片段（runs/<动作id>/dom-*.html）转成"控件语料"用例模板，供补进 test/fixtures/corpus/。
 *
 *   node packages/apply/scripts/dom-to-corpus.mjs <运行目录或 runs 根目录> --out <输出目录>
 *
 * 只保留结构与类名，去掉一切可能的个人信息：
 *  - 属性：value / title / alt / href / src / aria-label / aria-valuetext / data-* 一律清空或删除（data-career-* 标记删除）；
 *  - 文本：只保留通用控件用语（请选择 / 请输入 / 加载中 / 预览 / 删除 / 年月数字…）和文件名里的字段名，
 *    其余文本替换成「文本1」「文本2」…；长数字、邮箱、手机号先行打码；
 *  - 输出目录必须显式给出，不会写进仓库的 fixtures（人工检查、补交互脚本后再挪进去）。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const src = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1)
const out = outIdx >= 0 ? args[outIdx + 1] : undefined
if (!src || !out) { console.error('用法：dom-to-corpus.mjs <运行目录或 runs 根目录> --out <输出目录>'); process.exit(1) }
if (/test[\\/]fixtures/.test(resolve(out))) { console.error('输出目录不能直接是 test/fixtures：先人工检查脱敏结果，再手动挪进去'); process.exit(1) }

const KEEP = /^(请选择|请输入|请选择.{0,8}|请输入.{0,8}|搜索|加载中|暂无数据|无匹配数据|无数据|预览|删除|重新上传|上传|点击上传|确定|取消|清空|今天|此刻|[0-9]{1,2}月|[一二三四五六七八九十]{1,3}月|20[0-9]{2}(年)?|[«»‹›<>|–—\-~至]|\s+)$/
const mask = s => s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'x@example.com').replace(/1[3-9]\d{9}/g, '13800000000').replace(/\d{5,}/g, m => '0'.repeat(m.length))

function sanitize(html, label) {
  let n = 0
  const texts = new Map()
  let s = html
    .replace(/\sdata-career-[\w-]+="[^"]*"/g, '')
    .replace(/\s(value|title|alt|aria-label|aria-valuetext)="[^"]*"/g, ' $1=""')
    .replace(/\s(href|src)="[^"]*"/g, ' $1="#"')
    .replace(/\sdata-[\w-]+="[^"]*"/g, '')
    .replace(/\splaceholder="([^"]*)"/g, (_m, p) => ` placeholder="${KEEP.test(p) || p === label ? p : '请输入'}"`)
  s = s.replace(/>([^<]+)</g, (_m, t) => {
    const raw = t.trim()
    if (!raw || KEEP.test(raw) || raw === label || raw === '…') return `>${t}<`
    const key = mask(raw)
    if (!texts.has(key)) texts.set(key, `文本${++n}`)
    return `>${texts.get(key)}<`
  })
  return { html: s, replaced: n }
}

const dirs = []
const root = resolve(src)
if (readdirSync(root).some(f => /^dom-.*\.html$/.test(f))) dirs.push(root)
else for (const d of readdirSync(root)) { const p = join(root, d); if (statSync(p).isDirectory() && readdirSync(p).some(f => /^dom-.*\.html$/.test(f))) dirs.push(p) }
if (!dirs.length) { console.error(`${root} 下没有 dom-*.html`); process.exit(1) }
if (!existsSync(out)) mkdirSync(out, { recursive: true })
let count = 0
for (const dir of dirs) {
  const run = basename(dir)
  let summary = {}
  try { summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) } catch { /* 没有汇总也行 */ }
  for (const f of readdirSync(dir).filter(x => /^dom-.*\.html$/.test(x))) {
    const label = f.replace(/^dom-\d+-(fail-)?/, '').replace(/\.html$/, '').replace(/_/g, '')
    const { html, replaced } = sanitize(readFileSync(join(dir, f), 'utf8'), label)
    const name = `${run}-${f}`.replace(/[^\w一-龥.-]/g, '_')
    const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>语料草稿：${label || f}</title>
<!--
  由 scripts/dom-to-corpus.mjs 从运行记录 ${run}/${f} 生成（组件库：${(summary.libraries ?? []).join(',') || '未知'}）。
  已脱敏：属性值清空、${replaced} 段文本替换成「文本N」。入库前请：
   1. 人工确认没有残留个人信息；
   2. 把「文本N」换成虚构的选项 / 标签文字；
   3. 补交互脚本（点开 / 弹层 / 选中 / 读回），把数据模型挂在 window.__model 上；
   4. 在 test/widget-corpus.e2e.test.ts 里加"能填对"和"做不到就留空"两个用例。
-->
</head><body>
<form>
${html}
</form>
<script>
  window.__model = {}
  // TODO: 按真机行为补交互
</script>
</body></html>
`
    writeFileSync(join(out, name), page)
    count++
  }
}
console.log(`生成 ${count} 个语料草稿 → ${resolve(out)}`)
