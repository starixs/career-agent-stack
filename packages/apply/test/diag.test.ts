import { describe, it, expect } from 'vitest'
import { snapshotNeedsUser, NEEDS_SNAPSHOT_MAX } from '../src/diag.js'
import { noopRecorder, type Recorder } from '../src/telemetry.js'
import type { PageLike } from '../src/page.js'

function fakeRecorder() {
  const doms: string[] = []
  const traces: string[] = []
  const r: Recorder = { ...noopRecorder, dom: (name: string) => { doms.push(name); return `${name}.html` }, trace: ev => { traces.push(`${ev.field}:${ev.result}`) } }
  return { r, doms, traces }
}

describe('交给人补的字段留 DOM 快照', () => {
  it('每个字段一份、同一字段不重复；读不到的记一条失败、不抛错；有上限', async () => {
    const asked: string[] = []
    const page = { evaluate: async (_s: unknown, arg: { selector: string }) => { asked.push(arg.selector); if (arg.selector.includes('f9')) throw new Error('detached'); return '<div>表单项</div>' } } as unknown as PageLike
    const { r, doms, traces } = fakeRecorder()
    const saved = await snapshotNeedsUser(page, r, [{ fieldId: 'f1', label: '推荐方式' }, { fieldId: 'f1', label: '推荐方式' }, { fieldId: 'f9', label: '所在地点' }, { fieldId: 'f6', label: '年龄' }])
    expect(saved).toBe(2)
    expect(doms).toEqual(['needs-f1-推荐方式', 'needs-f6-年龄'])
    expect(asked).toEqual(['[data-career-field="f1"]', '[data-career-field="f9"]', '[data-career-field="f6"]'])
    expect(traces).toEqual(['f9:fail'])
    const many = Array.from({ length: NEEDS_SNAPSHOT_MAX + 5 }, (_, i) => ({ fieldId: `g${i}`, label: `格${i}` }))
    expect(await snapshotNeedsUser(page, fakeRecorder().r, many)).toBe(NEEDS_SNAPSHOT_MAX)
  })
})
