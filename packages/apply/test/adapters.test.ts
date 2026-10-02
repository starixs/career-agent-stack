import { describe, it, expect } from 'vitest'
import { pickAdapter, ADAPTERS, beisen, moka, feishu, nowcoder, boss, generic } from '../src/index.js'

describe('adapters', () => {
  it('按域名匹配，generic 兜底', () => {
    expect(pickAdapter('https://campus.beisen.com/xxx').id).toBe('beisen')
    expect(pickAdapter('https://abc.hotjob.cn/wt/abc/web/index').id).toBe('beisen')
    expect(pickAdapter('https://app.mokahr.com/campus_apply/xx/1').id).toBe('moka')
    expect(pickAdapter('https://people.feishu.cn/recruitment/xx').id).toBe('feishu')
    expect(pickAdapter('https://xx.feishu.cn/hire/job/1').id).toBe('feishu')
    expect(pickAdapter('https://xx.feishu.cn/docs/1').id).toBe('generic')
    expect(pickAdapter('https://job.nowcoder.com/careers/abc').id).toBe('nowcoder')
    expect(pickAdapter('https://www.zhipin.com/job_detail/1.html').id).toBe('boss')
    expect(pickAdapter('https://careers.example.com/apply').id).toBe('generic')
    expect(ADAPTERS.at(-1)).toBe(generic)
    for (const a of [beisen, moka, feishu, nowcoder, boss]) expect(a.hints.submitWords?.length).toBeGreaterThan(0)
  })
})
