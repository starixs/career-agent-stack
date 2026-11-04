import { describe, expect, it } from 'vitest'

import { clearBlockers } from '../src/blockers.js'
import type { PageLike } from '../src/page.js'
import type { DialogInfo } from '../src/widgets.js'

/** 只回答弹窗扫描的页面替身：第 n 次扫描时弹窗还在不在由 shownFor 决定；记下点过什么。 */
function dialogPage(dialog: DialogInfo, shownFor: number) {
  let scans = 0
  const clicked: string[] = []
  const page = {
    evaluate: async () => ({ dialogs: scans++ < shownFor ? [dialog] : [], mask: true }),
    click: async (sel: string) => { clicked.push(sel) },
    waitForTimeout: async () => {},
  } as unknown as PageLike
  return { page, clicked }
}

const parsing: DialogInfo = { id: 'd1', text: '解析中......', buttons: [{ text: '取消', selector: '#cancel' }], modal: true, kind: 'dialog' } as DialogInfo

describe('网站在忙的弹窗（2026-11-03 库洛游戏「解析中…… 取消」被交给了人）', () => {
  it('等它自己消失，不点「取消」，也不交给人', async () => {
    const { page, clicked } = dialogPage(parsing, 5)
    const r = await clearBlockers(page)
    expect(r.unresolved).toBeUndefined()
    expect(r.handled).toEqual([{ text: '解析中......', by: 'rule', rule: 'loading_wait', resolved: true }])
    expect(clicked).toEqual([])
  })

  it('等了半分钟还在：如实交给人，说是网站一直在加载', async () => {
    const { page, clicked } = dialogPage(parsing, 1000)
    const r = await clearBlockers(page)
    expect(r.unresolved?.reason).toContain('网站一直在「解析中......」')
    expect(clicked).toEqual([])
  })
})
