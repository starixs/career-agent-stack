import { describe, expect, it } from 'vitest'

import { FakePage, beisen, driveApplication, feishu, generic, isDetailEntryText, isEntryText, moka, pickPosition, requiredAbove, type PositionTarget } from '../src/index.js'
import { noLLM, profile } from './helpers.js'

const quiet = { pause: [0, 0] as [number, number], settleMs: 0, humanTyping: false }
const backend: PositionTarget = { terms: ['后端开发', '后端', '服务端', 'java', 'software'], search: ['后端开发', '后端'], prefer: ['上海', 'shanghai'] }
const basics = [{ label: '姓名', required: true }, { label: '手机号', required: true }]

describe('从首页 / 合集页找到具体岗位（立场 10：库里的岗位一定能投）', () => {
  it('挑最对口的岗位链接：方向词优先、期望城市加分；只沾导航不沾方向的链接不点', () => {
    const links = [
      { selector: 'a', href: '#/job/1', text: 'Hefei_Structure Durability Intern' },
      { selector: 'b', href: '#/job/2', text: 'Beijing_Software Developer Intern' },
      { selector: 'c', href: '#/job/3', text: 'Shanghai_Software Developer Intern' },
      { selector: 'd', href: '#/jobs', text: '职位列表 software' },
    ]
    expect(pickPosition(links, backend, moka)?.selector).toBe('c')
    expect(pickPosition(links.slice(0, 1), backend, moka)).toBeUndefined()
    // 英文按整词：engineer 不命中 engineering
    expect(pickPosition([{ selector: 'q', href: '#/job/9', text: 'Hefei_Quality engineering intern' }], { ...backend, terms: ['engineer'] }, moka)).toBeUndefined()
    // 没有链接样式的站：岗位样的文字才算
    expect(pickPosition([{ selector: 'x', href: '/about', text: '关于我们 后端' }, { selector: 'y', href: '/p/9', text: '后端开发工程师（2027 校招）' }], backend, generic)?.selector).toBe('y')
  })

  it('站内搜索网址：Moka 首页 → #/jobs?keyword=，飞书 /campus → /campus/position/list?keywords=', () => {
    expect(moka.positionSearchUrl?.('https://app.mokahr.com/campus-recruitment/vwa/142785#/', '后端')).toBe('https://app.mokahr.com/campus-recruitment/vwa/142785#/jobs?keyword=%E5%90%8E%E7%AB%AF')
    expect(feishu.positionSearchUrl?.('https://xiaopeng.jobs.feishu.cn/campus/m/', '后端')).toBe('https://xiaopeng.jobs.feishu.cn/campus/position/list?keywords=%E5%90%8E%E7%AB%AF')
    expect(moka.positionSearchUrl?.('https://example.com/jobs', '后端')).toBeNull()
  })

  it('飞书详情页的「投递」只打开网申表，算入口；别的站仍不算', () => {
    expect(isEntryText('投递', feishu)).toBe(true)
    expect(isEntryText('投递', generic)).toBe(false)
    // 中文校招详情页最常见的入口文案（2026-11-02 实例 A）：只在详情页入口守卫里算入口，别处仍不算
    for (const t of ['立即投递', '投递简历', '投递职位']) { expect(isDetailEntryText(t, generic)).toBe(true); expect(isEntryText(t, generic)).toBe(false) }
    expect(isDetailEntryText('提交申请', generic)).toBe(false)
  })

  it('Moka 首页 → 站内搜方向词 → 点进对口岗位 → 「申请职位」进表单 → 停在提交前，绝不点提交', async () => {
    const home = 'https://app.mokahr.com/campus-recruitment/acme/100#/'
    const page = new FakePage([
      { url: home, text: '欢迎加入' },
      { url: `${home}jobs?keyword=%E5%90%8E%E7%AB%AF%E5%BC%80%E5%8F%91`, links: [
        { text: '财务管培生（北京）', href: '#/job/a', goto: 'https://app.mokahr.com/x/a' },
        { text: '后端开发工程师（上海）2027 校招', href: '#/job/b', goto: 'https://app.mokahr.com/x/b' },
      ] },
      { url: 'https://app.mokahr.com/x/b', text: '岗位职责', buttons: [{ text: '申请职位', goto: 'https://app.mokahr.com/x/b/apply' }] },
      { url: 'https://app.mokahr.com/x/b/apply', fields: basics, buttons: [{ text: '提交', submit: true }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend })
    expect(page.actions.filter(a => a.target?.startsWith('link:')).map(a => a.target)).toEqual(['link:后端开发工程师（上海）2027 校招'])
    expect(r.entryClicked).toBe('申请职位')
    expect(r.status).toBe('stopped_before_submit')
    expect(page.submitted).toBe(false)
  })

  it('飞书列表页：左边的筛选框不是网申表 → 先点进对口岗位，详情页「投递」进表单，表单页的「投递」绝不点', async () => {
    const list = 'https://acme.jobs.feishu.cn/campus/position/list'
    const page = new FakePage([
      { url: list, fields: [{ label: '职位类别', type: 'checkbox' }, { label: '城市', type: 'checkbox' }], links: [
        { text: '【27届校招】Java 后端开发工程师 上海', href: '/campus/position/7/detail', goto: 'https://acme.jobs.feishu.cn/campus/position/7/detail' },
        { text: '【27届校招】汽车销售顾问', href: '/campus/position/8/detail', goto: 'https://acme.jobs.feishu.cn/campus/position/8/detail' },
      ] },
      { url: 'https://acme.jobs.feishu.cn/campus/position/7/detail', text: '岗位职责', buttons: [{ text: '投递', goto: 'https://acme.jobs.feishu.cn/campus/apply/7' }] },
      { url: 'https://acme.jobs.feishu.cn/campus/apply/7', fields: basics, buttons: [{ text: '投递', submit: true }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend })
    expect(page.actions.filter(a => a.target?.startsWith('link:')).map(a => a.target)).toEqual(['link:【27届校招】Java 后端开发工程师 上海'])
    expect(r.entryClicked).toBe('投递')
    expect(r.status).toBe('stopped_before_submit')
    expect(page.submitted).toBe(false)
    expect(page.fieldValues()).toMatchObject({ 姓名: '张三' })
  })

  it('Moka 首页只有「输入职位关键字」搜索框：不当网申表，去站内搜岗位', async () => {
    const home = 'https://app.mokahr.com/campus-recruitment/acme/100#/'
    const page = new FakePage([
      { url: home, fields: [{ label: '输入职位关键字', placeholder: '输入职位关键字' }] },
      { url: `${home}jobs?keyword=%E5%90%8E%E7%AB%AF%E5%BC%80%E5%8F%91`, links: [{ text: 'Shanghai_Software Developer Intern', href: '#/job/b', goto: 'https://app.mokahr.com/x/b' }] },
      { url: 'https://app.mokahr.com/x/b', text: 'JD', buttons: [{ text: '申请职位', goto: 'https://app.mokahr.com/x/b/apply' }] },
      { url: 'https://app.mokahr.com/x/b/apply', fields: basics, buttons: [{ text: '提交', submit: true }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend })
    expect(r.status).toBe('stopped_before_submit')
    expect(page.fieldValues()).not.toHaveProperty('输入职位关键字', expect.stringContaining('张'))
  })

  it('hotjob 首页只有导航：先进「校园招聘」栏目，再点可点的岗位行（没有链接）', async () => {
    const base = 'https://wecruit.hotjob.cn/SU1/pb'
    const page = new FakePage([
      { url: `${base}/index.html#/`, text: '关于我们', section: { text: '校园招聘', goto: `${base}/school.html` } },
      { url: `${base}/school.html`, links: [{ text: '【2027校招】研发工程师 技术 上海', href: '', goto: `${base}/detail` }] },
      { url: `${base}/detail`, text: '岗位职责', buttons: [{ text: '申请职位', goto: `${base}/apply` }] },
      { url: `${base}/apply`, fields: basics, buttons: [{ text: '提交申请', submit: true }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: { ...backend, terms: [...backend.terms, '研发'] } })
    expect(page.actions.map(a => a.target).filter(t => t?.startsWith('section:') || t?.startsWith('link:'))).toEqual(['section:校园招聘', 'link:【2027校招】研发工程师 技术 上海'])
    expect(r.status).toBe('stopped_before_submit')
    expect(page.submitted).toBe(false)
  })

  it('搜了还是只有筛选框：如实报「没有对口岗位」，绝不当成填好的表单去提交', async () => {
    const home = 'https://app.mokahr.com/campus-recruitment/acme/100#/'
    const page = new FakePage([
      { url: home, text: '欢迎' },
      { url: `${home}jobs?keyword=%E5%90%8E%E7%AB%AF%E5%BC%80%E5%8F%91`, fields: [{ label: '所属部门' }, { label: '职能类型' }, { label: '工作地点' }] },
      { url: `${home}jobs?keyword=%E5%90%8E%E7%AB%AF`, fields: [{ label: '所属部门' }, { label: '工作地点' }] },
      { url: `${home}jobs?keyword=%E6%9C%8D%E5%8A%A1%E7%AB%AF`, fields: [{ label: '所属部门' }, { label: '工作地点' }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend })
    expect(r.status).toBe('blocked')
    expect(r.message).toContain('没有和你方向对口的岗位')
    expect(r.filled).toEqual([])
  })

  it('认不出模板的列表页：筛选栏（「职位性质 / 职能类型」下拉、没标签的搜索框）按结构认出来，不当网申表填（2026-10-31 韶音）', async () => {
    const page = new FakePage({ url: 'https://app.mokahr.com/campus_apply/acme/36940#/jobs', fields: [{ label: '' }, { label: '职位性质', type: 'select', options: ['全职', '实习'] }, { label: '职能类型', type: 'select', options: ['研发', '设计'] }] })
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend })
    expect(r.status).toBe('blocked')
    expect(r.filled).toEqual([])
    expect(r.message).not.toContain('表单已填完')
  })

  it('导航栏的「登录/注册」不是登录墙：先去找岗位', async () => {
    const page = new FakePage([
      { url: 'https://acme.zhiye.com/', text: '首页 校园招聘 登录/注册', section: { text: '校园招聘', goto: 'https://acme.zhiye.com/campus/jobs' } },
      { url: 'https://acme.zhiye.com/campus/jobs', text: '登录/注册', links: [{ text: '软件开发工程师 校园招聘 上海 软件类', href: '', goto: 'https://acme.zhiye.com/campus/detail' }] },
      { url: 'https://acme.zhiye.com/campus/detail', text: '岗位职责 登录/注册', buttons: [{ text: '申请职位', goto: 'https://acme.zhiye.com/login' }] },
      { url: 'https://acme.zhiye.com/login', login: true, fields: [{ label: '手机号' }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: { ...backend, terms: [...backend.terms, '软件'] } })
    expect(r.entryClicked).toBe('申请职位')
    expect(r.status).toBe('handoff'); expect(r.reason).toBe('login')
    expect(r.finalUrl).toBe('https://acme.zhiye.com/login')
  })

  it('列表上只有沾通用词的岗位：先站内搜方向词，搜到 Java 后端就点它，不点「研发测试」', async () => {
    const list = 'https://acme.jobs.feishu.cn/campus/position/list'
    const page = new FakePage([
      { url: list, links: [{ text: '【27届】机器人系统集成培训生 深圳 研发 - 测试', href: '/campus/position/1/detail', goto: 'https://acme.jobs.feishu.cn/campus/position/1/detail' }] },
      { url: `https://acme.jobs.feishu.cn/campus/position/list?keywords=%E5%90%8E%E7%AB%AF%E5%BC%80%E5%8F%91`, links: [{ text: '【27届】Java 全栈开发 广州', href: '/campus/position/2/detail', goto: 'https://acme.jobs.feishu.cn/campus/position/2/detail' }] },
      { url: 'https://acme.jobs.feishu.cn/campus/position/1/detail', text: 'JD', buttons: [{ text: '投递', goto: 'https://acme.jobs.feishu.cn/apply/1' }] },
      { url: 'https://acme.jobs.feishu.cn/campus/position/2/detail', text: 'JD', buttons: [{ text: '投递', goto: 'https://acme.jobs.feishu.cn/apply/2' }] },
      { url: 'https://acme.jobs.feishu.cn/apply/1', fields: basics, buttons: [{ text: '投递', submit: true }] },
      { url: 'https://acme.jobs.feishu.cn/apply/2', fields: basics, buttons: [{ text: '投递', submit: true }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: { ...backend, terms: [...backend.terms, '研发', '开发'], strong: backend.terms.length } })
    expect(r.finalUrl).toBe('https://acme.jobs.feishu.cn/apply/2')
    expect(r.status).toBe('stopped_before_submit')
  })

  it('北森岗位行就地展开出「投递」：页面上只有搜索框时也点入口进申请', async () => {
    const page = new FakePage([
      { url: 'https://acme.zhiye.com/campus/jobs', fields: [{ label: '', placeholder: '搜索职位' }], buttons: [{ text: '投递', goto: 'https://acme.zhiye.com/apply' }] },
      { url: 'https://acme.zhiye.com/apply', fields: basics, buttons: [{ text: '提交申请', submit: true }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend, adapter: beisen })
    expect(r.entryClicked).toBe('投递')
    expect(r.status).toBe('stopped_before_submit')
  })

  it('内置找路走不通就交给注入的自主找路；它走到网申表，引擎接着填；只走一趟', async () => {
    const page = new FakePage([
      { url: 'https://careers.acme.com/', text: '欢迎加入我们' },
      { url: 'https://careers.acme.com/apply/9', fields: basics, buttons: [{ text: '提交', submit: true }] },
    ])
    const calls: string[] = []
    const pathfinder = async (why: string) => { calls.push(why); await page.goto('https://careers.acme.com/apply/9'); return { moved: true } }
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend, pathfinder })
    expect(calls).toHaveLength(1)
    expect(r.status).toBe('stopped_before_submit')
    expect(page.submitted).toBe(false)
  })

  it('自主找路说没有对口岗位：如实报它看到的情况', async () => {
    const page = new FakePage({ url: 'https://careers.acme.com/', text: '欢迎加入我们' })
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend, pathfinder: async () => ({ moved: false, note: '只有财务和销售岗' }) })
    expect(r.status).toBe('blocked')
    expect(r.message).toContain('只有财务和销售岗')
  })

  it('详情页要求学历高于他：不点投递；交给自主找路换岗位，找不到就如实报', async () => {
    const detail = { url: 'https://wecruit.hotjob.cn/SU1/pb/posDetail.html', text: '学历：博士研究生及以上', buttons: [{ text: '申请职位', goto: 'https://wecruit.hotjob.cn/SU1/pb/apply' }] }
    const page = new FakePage([detail, { url: 'https://wecruit.hotjob.cn/SU1/pb/apply', fields: basics }])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: { ...backend, tooHigh: ['博士研究生及以上'] }, pathfinder: async () => ({ moved: false, note: '只有一个博士岗' }) })
    expect(r.entryClicked).toBeUndefined()
    expect(r.status).toBe('blocked')
    expect(r.message).toContain('只有一个博士岗')
    expect(requiredAbove('学历：硕士及以上优先', ['硕士及以上'])).toBeUndefined()
    expect(requiredAbove('硕士及以上优先；博士及以上', ['硕士及以上', '博士及以上'])).toBe('博士及以上')
  })

  it('认定是校招首页 / 列表页又走不出去：如实报没找到，绝不把筛选和分页当表单、把岗位卡上的「立即投递」当提交', async () => {
    const home = 'https://app.mokahr.com/campus-recruitment/acme/100#/'
    const page = new FakePage([
      { url: home, fields: [{ label: '所属部门' }, { label: '30 行/页', type: 'select', options: ['30 行/页'] }], buttons: [{ text: '立即投递', submit: true }, { text: '立即投递', submit: true }] },
      { url: `${home}jobs?keyword=%E5%90%8E%E7%AB%AF%E5%BC%80%E5%8F%91`, text: '暂无匹配职位' },
      { url: `${home}jobs?keyword=%E5%90%8E%E7%AB%AF`, text: '暂无匹配职位' },
      { url: `${home}jobs?keyword=%E6%9C%8D%E5%8A%A1%E7%AB%AF`, text: '暂无匹配职位' },
    ])
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, target: backend, pathfinder: async () => ({ moved: false, note: '自己在网站上找了 14 步，还没走到网申表：只看到实习岗位' }) })
    expect(r.status).toBe('blocked')
    expect(r.message).toBe('自己在网站上找了 14 步，还没走到网申表：只看到实习岗位')
    expect(r.filled).toEqual([])
    expect(page.submitted).toBe(false)
  })

  it('不给 target 时行为不变：首页没表单就如实报没有表单', async () => {
    const r = await driveApplication(new FakePage({ url: 'https://app.mokahr.com/campus-recruitment/acme/100#/', text: '欢迎加入' }), noLLM(), profile, quiet)
    expect(r.status).toBe('blocked')
  })
})

describe('选岗避开不是给他的岗位', () => {
  it('方向对但写着「海外留学生专项」：不选，选普通的那个', async () => {
    const { scorePositionLink, pickPosition } = await import('../src/navigate.js')
    const { pickAdapter } = await import('../src/adapters/index.js')
    const adapter = pickAdapter('https://xiaopeng.jobs.feishu.cn/campus/position')
    const target = { terms: ['后端开发', 'java'], search: ['后端开发'], avoid: ['海外留学生'] }
    const overseas = { selector: 'a1', href: 'https://xiaopeng.jobs.feishu.cn/campus/position/1/detail', text: '【2027届校招】Java 全栈开发方向-海外留学生专项 广州' }
    const normal = { selector: 'a2', href: 'https://xiaopeng.jobs.feishu.cn/campus/position/2/detail', text: '【2027届校招】Java 后端开发 上海' }
    expect(scorePositionLink(overseas, target, adapter)).toBe(0)
    expect(pickPosition([overseas, normal], target, adapter)?.selector).toBe('a2')
  })
})
