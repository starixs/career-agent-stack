import { describe, it, expect } from 'vitest'
import { FakePage, typeLikeHuman, scrollLikeHuman, humanDelay, randomBetween } from '../src/index.js'

describe('pacing', () => {
  it('humanDelay 在区间内且可注入 sleep', async () => {
    const slept: number[] = []
    const ms = await humanDelay(10, 20, { rng: () => 0.5, sleep: async m => { slept.push(m) } })
    expect(ms).toBeGreaterThanOrEqual(10); expect(ms).toBeLessThanOrEqual(20); expect(slept).toEqual([ms])
    expect(randomBetween(5, 5, () => 0.99)).toBe(5)
  })
  it('typeLikeHuman 逐字输入；scrollLikeHuman 分步滚动', async () => {
    const page = new FakePage({ url: 'u', fields: [{ label: '姓名' }] })
    await typeLikeHuman(page, '[data-career-field="f0"]', '张三', { sleep: async () => {} })
    expect(page.valueOf('姓名')).toBe('张三')
    expect(page.actions.filter(a => a.kind === 'type').map(a => a.value)).toEqual(['张', '三'])
    await scrollLikeHuman(page, { steps: 3, sleep: async () => {} })
    expect(page.actions.filter(a => a.kind === 'scroll').length).toBe(4)
  })
})
